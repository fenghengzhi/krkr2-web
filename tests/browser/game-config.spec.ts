import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect } from '../helpers/library-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { nativeSaveZipFiles } from '../helpers/native-saves.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'
import { startupScriptModesSource } from '../helpers/startup-script-modes.ts'
import { assertGameDirectoryInput, attachGameDirectoryInput, chooseGameDirectory, observeGameDirectoryInput } from '../helpers/game-directory-input.ts'

const embedded = '; embedded game defaults\r\nroute=embedded\r\nshared=exe-file\r\nonlydefault=embedded-retained\r\nonlyembedded=retained-exe\r\nflag=no\r\nholdalpha=yes\r\nevalcontext=global\r\nunaryaster=compat\r\ndatapath=$(exepath)/EmbeddedProfiles\r\n',
  defaults = '; shipped defaults\r\nroute=default\r\nshared=default-file\r\nonlydefault=retained\r\nflag\r\nholdalpha=no\r\nevalcontext=instance\r\nunaryaster=amp\r\ndatapath=$(exepath)/Profiles\r\n',
  packaged = '; packaged user settings\r\nonlyuser=packaged\r\nshared=user-file\r\n',
  imported = 'route=imported\r\nshared=imported\r\nonlyuser=imported\r\nflag=yes\r\ndatapath=$(exepath)/AnotherIgnored\r\n',
  overlay = 'route=overlay\r\nshared=overlay\r\nonlyuser=overlay\r\nflag=no\r\ndatapath=$(exepath)/Ignored\r\n'

const game = startupScriptModesSource + String.raw`
var configWindow=new Window();configWindow.caption="Game configuration";configWindow.setInnerSize(128,80);configWindow.visible=true;
var configRoot=new Layer(configWindow,null);configRoot.holdAlpha=false;configRoot.setSize(128,80);configRoot.fillRect(0,0,128,80,0xff112233);
var configStartupModes=startupScriptModes();
var configRoute=System.getArgument("-route"),configInitialDataPath=System.dataPath;
var configColor=new Layer(configWindow,configRoot);configColor.holdAlpha=false;configColor.setPos(96,0,24,24);configColor.visible=true;
configColor.fillRect(0,0,24,24,configRoute=="embedded"?0xffffff00:configRoute=="default"?0xff0000ff:configRoute=="overlay"?0xff00ff00:0xffff0000);
var configSave=new Layer(configWindow,configRoot);configSave.holdAlpha=false;configSave.setPos(0,0,80,32);configSave.fillRect(0,0,80,32,0xff408060);configSave.visible=true;
var configWrite=new Layer(configWindow,configRoot);configWrite.holdAlpha=false;configWrite.setPos(0,40,80,32);configWrite.fillRect(0,0,80,32,0xff604080);configWrite.visible=true;
var configAlpha=new Layer(configWindow,configRoot);configAlpha.setSize(1,1);configAlpha.face=dfOpaque;
var configHold=int(configAlpha.holdAlpha);configAlpha.setMaskPixel(0,0,73);var configBeforeMask=configAlpha.getMaskPixel(0,0);
configAlpha.fillRect(0,0,1,1,0xff445566);
function configStored(){return Storages.isExistentStorage(System.dataPath+"slot.txt")?[].load(System.dataPath+"slot.txt","utf-8")[0]:"none";}
function configState(){return [configRoute,System.getArgument("-route"),System.getArgument("-shared"),System.getArgument("-onlydefault"),
 System.getArgument("-onlyembedded"),System.getArgument("-sectiononly")===void?"absent":"present",
 System.getArgument("-onlyuser"),System.getArgument("-flag"),System.getArgument("-datapath"),System.exeName,System.exePath,System.dataPath,configStored(),
 System.getArgument("-holdalpha"),configHold,configBeforeMask,configAlpha.getMaskPixel(0,0),configAlpha.getMainPixel(0,0)&0xffffff,
 System.getArgument("-evalcontext"),System.getArgument("-unaryaster"),configStartupModes].join("|");}
configSave.onClick=function(){["stored:"+global.configRoute].save(global.System.dataPath+"slot.txt","utf-8");global.Debug.message("config-saved:"+global.configRoute);};
configWrite.onClick=function(){
 ["route=overlay","shared=overlay","onlyuser=overlay","flag=no","datapath=$(exepath)/Ignored"].save(global.System.dataPath+"Adventure.cfu","utf-8");
 global.Debug.message("config-user-written:"+global.configRoute);
};
Debug.message("config-ready:"+configRoute);
`

/** Authored data only: no PE header or runnable instructions. Stock startup
 * scans 16-byte boundaries from 512 KiB, skips the four-byte capacity, and
 * reads only the first NUL-terminated ANSI section. Do not use the product
 * embedded-option reader to construct this input. */
function embeddedExecutable(): Buffer {
  const offset = 512 * 1024, capacity = 1024, bytes = Buffer.alloc(offset + 20 + capacity)
  bytes.set([0x4d, 0x5a])
  bytes.set(Buffer.from('XOPT_EMBED_AREA_', 'ascii'), offset)
  bytes.writeUInt32LE(capacity, offset + 16)
  bytes.set(Buffer.from(embedded + '\0route=hidden-section\r\nsectiononly=must-not-load\r\n\0', 'ascii'), offset + 20)
  return bytes
}

type ConfigRoute = 'embedded' | 'default' | 'overlay' | 'imported'

/** Independent stored-ZIP input, with literal central records and CRC32. No
 * production configuration reader or project selector constructs expectations. */
function distribution(files: ReadonlyMap<string, Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, bytes] of files) {
    const text = Buffer.from(name), header = Buffer.alloc(30), record = Buffer.alloc(46)
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(text.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24)
    record.writeUInt16LE(text.length, 28); record.writeUInt32LE(offset, 42)
    local.push(header, text, bytes); central.push(record, text); offset += header.length + text.length + bytes.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode ZIP/XP3 with .cf' : 'source folder/data without .cf'}: embedded defaults and user settings survive library restart and native-save import`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], errors: string[] = [], evidence: unknown[] = []
    let directory: string | undefined
    let directorySelection: Awaited<ReturnType<typeof chooseGameDirectory>> | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await observeGameDirectoryInput(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const base = binary ? 'Adventure/' : '', dataDirectory = binary ? 'Profiles/' : 'EmbeddedProfiles/',
      otherDataDirectory = binary ? 'EmbeddedProfiles/' : 'Profiles/',
      initialRoute = binary ? 'default' : 'embedded', dataPath = `game://./${base}${dataDirectory}`,
      title = `Adventure settings ${backend} ${binary ? 'compiled' : 'source'}`,
      item = () => page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = () => page.locator('.game-window[data-window-id]').filter({
        has: page.locator('.game-window-title', { hasText: /^Game configuration$/ }),
      }).locator('canvas[data-window-id]'),
      expected = (route: ConfigRoute, saved: string) => [route, route,
        route === initialRoute ? 'user-file' : route, binary ? 'retained' : 'embedded-retained', 'retained-exe', 'absent',
        route === initialRoute ? 'packaged' : route,
        route === 'overlay' || route === 'embedded' ? 'no' : 'yes',
        `$(exepath)/${route === initialRoute ? dataDirectory.slice(0, -1) : route === 'overlay' ? 'Ignored' : 'AnotherIgnored'}`,
        `game://./${base}Adventure.exe`, `game://./${base}`, dataPath, saved,
        binary ? 'no' : 'yes', binary ? 0 : 1, 73, binary ? 255 : 73, 4478310,
        binary ? 'instance' : 'global', binary ? 'amp' : 'compat',
        binary ? 'instance:1:0|amp|0|255' : 'global:0:1|star|1|73'].join('|'),
      ready = async (route: ConfigRoute, saved: string) => {
        await expect(page.getByText('config-ready:' + route, { exact: true })).toBeVisible({ timeout: 30000 })
        await expect(page.locator('#evaluate')).toBeEnabled()
        await expect(page.locator('#project-status')).toContainText(base + (binary ? 'data.xp3>' : 'data/'))
        await evaluate(page, 'configState()', expected(route, saved))
        await canvas().scrollIntoViewIfNeeded()
        const wanted = route === 'embedded' ? [255, 255, 0, 255] : route === 'default' ? [0, 0, 255, 255]
          : route === 'overlay' ? [0, 255, 0, 255] : [255, 0, 0, 255]
        await expect.poll(async () => {
          const image = readScreenshotPng(await canvas().screenshot()),
            at = (Math.floor(image.height * 12 / 80) * image.width + Math.floor(image.width * 108 / 128)) * 4
          return [...image.rgba.subarray(at, at + 4)]
        }).toEqual(wanted)
      },
      click = async (y: number) => {
        const bounds = await canvas().boundingBox(); expect(bounds).not.toBeNull()
        await canvas().click({ position: { x: 40 * bounds!.width / 128, y: y * bounds!.height / 80 } })
      },
      backup = async (phase: string) => {
        await page.locator('#save-format').selectOption('backup')
        const pending = page.waitForEvent('download', { timeout: 10000 })
        const [download] = await Promise.all([pending, page.locator('#export-saves').click()]), path = await download.path()
        expect(await download.failure()).toBeNull(); expect(path).not.toBeNull()
        const bytes = await readFile(path!), value = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] }
        await info.attach(`config-${phase}-backup.json`, { body: bytes, contentType: 'application/json' })
        evidence.push({ phase, backup: value })
        return value
      },
      nativeFiles = async (phase: string) => {
        await page.locator('#save-format').selectOption('native')
        const pending = page.waitForEvent('download', { timeout: 10000 })
        const [download] = await Promise.all([pending, page.locator('#export-saves').click()]), path = await download.path()
        expect(await download.failure()).toBeNull(); expect(path).not.toBeNull()
        const bytes = await readFile(path!)
        await info.attach(`config-${phase}-data.zip`, { body: bytes, contentType: 'application/zip' })
        return nativeSaveZipFiles(bytes)
      },
      stop = async () => {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
        await expect(page.locator('#status')).toHaveText('待机')
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      }
    try {
      const script = { 'startup.tjs': binary
        ? 'Scripts.compileStorage("game.tjs",System.dataPath+"game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"game.cjs");'
        : 'Scripts.execStorage("game.tjs");', 'game.tjs': game },
        exe = embeddedExecutable(), files = new Map<string, Buffer>()
      files.set(base + 'Adventure.exe', exe)
      if (binary) {
        files.set(base + 'Adventure.cf', Buffer.from(defaults, 'ascii'))
        files.set(base + 'Setup.exe', Buffer.from([77, 90]))
        files.set(base + 'Setup.cf', Buffer.from('route=wrong-launcher\r\n'))
      }
      files.set(base + dataDirectory + 'Adventure.cfu', Buffer.from(packaged, 'ascii'))
      // .cf chooses the user directory over EXE defaults; without .cf the
      // EXE must choose it. The other location is deliberately wrong.
      files.set(base + otherDataDirectory + 'Adventure.cfu', Buffer.from('route=wrong-default-directory\r\n'))
      // A user pathname from a later .cfu must not cause a second lookup here.
      files.set(base + 'Ignored/Adventure.cfu', Buffer.from('route=wrong-location\r\n'))
      if (binary) files.set(base + 'data.xp3', xp3Fixture(script, { compressed: true }).bytes)
      else for (const [name, bytes] of Object.entries(script)) files.set('data/' + name, Buffer.from(bytes))
      await info.attach('config-inputs.json', { contentType: 'application/json', body: JSON.stringify({ backend, binary,
        embeddedText: embedded, externalDefaultText: binary ? defaults : null, packagedUserText: packaged,
        embeddedLayout: { offset: 512 * 1024, marker: 'XOPT_EMBED_AREA_', capacity: 1024, textOffset: 512 * 1024 + 20,
          encoding: 'ASCII subset of Windows ANSI', secondSection: 'ignored', executable: false },
        files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
        scope: 'One authored inert EXE option section with a data folder or an actual XP3 inside a distribution ZIP; no EXE is executed.',
      }, null, 2) })
      await page.locator('#project-mode').selectOption('auto')
      if (binary) {
        await page.locator('#project-executable').fill('adventure.exe')
        await page.locator('#files').setInputFiles({ name: 'Adventure.zip', mimeType: 'application/zip', buffer: distribution(files) })
      } else {
        directory = await mkdtemp(join(tmpdir(), 'krkr-game-config-'))
        for (const [name, bytes] of files) {
          const path = join(directory, name)
          await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
        }
        directorySelection = await chooseGameDirectory(page, directory)
      }
      await ready(initialRoute, 'none')
      if (directorySelection) await assertGameDirectoryInput(page, info, directorySelection,
        [...files].map(([path, bytes]) => ({ path, bytes: bytes.length })), 'auto', 'game-config')
      await expect(page.locator('#save-library')).toBeEnabled(); await page.locator('#library-title').fill(title)
      await page.locator('#save-library').click(); await expect(item()).toBeVisible()
      await expect(page.locator('#cancel-library')).toBeHidden()
      await click(16); await expect(page.getByText('config-saved:' + initialRoute, { exact: true })).toHaveCount(1)
      const first = await backup(initialRoute)
      expect(first.files.find((file) => file.path === base + dataDirectory + 'slot.txt')).toBeDefined()
      expect(first.files.some((file) => file.path.includes('>') || file.path.startsWith(base + 'Ignored/') || file.path.startsWith(base + otherDataDirectory))).toBe(false)
      await click(56); await expect(page.getByText('config-user-written:' + initialRoute, { exact: true })).toHaveCount(1)
      await evaluate(page, 'configState()', expected(initialRoute, 'stored:' + initialRoute))
      const written = await nativeFiles('written-overlay')
      expect(written.get('Adventure.cfu')!.toString('utf8')).toBe(overlay)
      expect(written.get('slot.txt')!.toString('utf8')).toBe('stored:' + initialRoute + '\r\n')
      await stop(); await page.reload(); await expect(item()).toBeVisible()
      await item().getByRole('button', { name: '启动', exact: true }).click()
      await ready('overlay', 'stored:' + initialRoute)
      expect((await backup('overlay-start')).gameId).toBe(first.gameId)
      await click(16); await expect(page.getByText('config-saved:overlay', { exact: true })).toHaveCount(1)

      // Native import is data-directory-relative. It replaces the saved .cfu
      // before the next Worker is initialized, not the live argument table.
      await page.locator('#save-format').selectOption('native'); await page.locator('#pause').click()
      await expect(page.locator('#status')).toHaveText('已暂停'); await expect(page.locator('#import-saves')).toBeEnabled()
      const marker = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), count = await marker.count(),
        choosing = page.waitForEvent('filechooser', { timeout: 5000 })
      const [chooser] = await Promise.all([choosing, page.locator('#import-saves').click()])
      expect(await chooser.element().getAttribute('id')).toBe('native-save-files')
      await chooser.setFiles({ name: 'Adventure.cfu', mimeType: 'application/octet-stream', buffer: Buffer.from(imported) })
      await expect(marker).toHaveCount(count + 1)
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('运行中')
      await evaluate(page, 'configState()', expected('overlay', 'stored:overlay'))
      await stop(); await page.reload(); await expect(item()).toBeVisible()
      await item().getByRole('button', { name: '启动', exact: true }).click()
      await ready('imported', 'stored:overlay')
      await click(16); await expect(page.getByText('config-saved:imported', { exact: true })).toHaveCount(1)
      const last = await backup('imported-start'), exported = await nativeFiles('imported-start')
      expect(last.gameId).toBe(first.gameId)
      expect(last.files.find((file) => file.path === base + dataDirectory + 'slot.txt')).toBeDefined()
      expect(last.files.some((file) => file.path.startsWith(base + 'Ignored/') || file.path.startsWith(base + 'AnotherIgnored/') ||
        file.path.startsWith(base + otherDataDirectory) || file.path.includes('>'))).toBe(false)
      expect(exported.get('Adventure.cfu')!.equals(Buffer.from(imported))).toBe(true)
      expect(exported.get('slot.txt')!.toString('utf8')).toBe('stored:imported\r\n')
      if (binary) expect(exported.get('game.cjs')!.toString('ascii', 0, 4)).toBe('TJS2')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length && directory) {
      try { await attachGameDirectoryInput(page, info, 'game-config-failure') } catch (error) { failures.push(error) }
    }
    try { await info.attach('config-observations.json', { body: JSON.stringify({ evidence, errors, logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { if (directory) await rm(directory, { recursive: true, force: true }) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Game configuration startup or cleanup failed', { cause: failures[0] })
  })

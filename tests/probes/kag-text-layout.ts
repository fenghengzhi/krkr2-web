// Run original KAG MessageLayer/Conductor code with project-owned layout fixtures.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeBmp } from '../../src/formats/image/bmp.ts'
const browserName = process.argv[2] ?? 'chromium',
  backend = process.argv[3] ?? 'asyncify',
  output = 'out/verification/text-layout/kag',
  root = resolve('dist')
if (
  !['chromium', 'firefox', 'webkit'].includes(browserName) ||
  !['asyncify', 'jspi'].includes(backend)
)
  throw new Error('Unknown browser/backend')
await mkdir(output, { recursive: true })
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname.slice(1) || 'index.html'
  if (!/^[\w./-]+$/.test(path) || path.split('/').includes('..')) {
    res.writeHead(404).end()
    return
  }
  try {
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
    }
    res.setHeader('content-type', mime[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(resolve(root, path)))
  } catch {
    res.writeHead(404).end()
  }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')
const browser = await { chromium, firefox, webkit }[browserName as 'chromium'].launch(),
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
  errors: string[] = [],
  cases: unknown[] = []
page.on('pageerror', (error) => errors.push(error.message))
let sequence = 0
const evaluate = async (source: string) => {
  const prefix = 'layout-probe-' + ++sequence + ':'
  await page.locator('#expression').fill(JSON.stringify(prefix) + '+string(' + source + ')')
  await page.locator('#evaluate').click()
  const message = page
    .locator('#logs p span')
    .filter({ hasText: new RegExp('^' + prefix) })
    .last()
  await expect(message).toBeVisible({ timeout: 20000 })
  return (await message.textContent())!.slice(prefix.length)
}
try {
  await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
  await page.locator('#files').setInputFiles([
    {
      name: 'kag3_template.xp3',
      mimeType: 'application/octet-stream',
      buffer: await readFile('../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3'),
    },
    {
      name: 'vertical.ttf',
      mimeType: 'font/ttf',
      buffer: await readFile('tests/fixtures/text-layout/vert.ttf'),
    },
    ...['horizontal', 'vertical', 'wrap'].map((mode) => ({
      name: 'layout-' + mode + '.ks',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '\ufeff' +
          '*start\n[cm][position layer=message0 page=fore left=40 top=40 width=400 height=' +
          (mode === 'wrap' ? 140 : 240) +
          ' marginl=20 marginr=20 margint=20 marginb=20 vertical=' +
          (mode !== 'horizontal') +
          ' visible=true]' +
          '[font face="Krkr Vertical vert" size=20 rubysize=10 rubyoffset=-2 bold=false edge=false shadow=false color=0xffffff][nowait]' +
          '[ruby text="ぁぁ"]' +
          (mode === 'wrap' ? '漢漢漢、漢漢（漢ぁ漢' : '漢A、（ぁ') +
          (mode === 'vertical' ? '[hch text="AA"]漢' : '') +
          '[eval exp="Debug.message(\'layout-ready:' +
          mode +
          '\')"][s]\n',
      ),
    })),
  ])
  await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
  const fullscreen = page.locator('.leave-fullscreen')
  if (await fullscreen.isVisible()) await fullscreen.click()
  assert.match(
    await evaluate(
      '(function(){kag.conductor.stop();return kag.fore.messages[0].lineLayer.font.getList(0).join(",");})()',
    ),
    /Krkr Vertical vert/,
  )
  await evaluate(
    '(function(){global.__layoutLayer=kag.fore.messages[0].lineLayer;global.__layoutDraw=global.__layoutLayer.drawText;f.layoutCalls=[];global.__layoutLayer.drawText=function(args*){var ll=global.__layoutLayer;f.layoutCalls.add([int(args[0]),int(args[1]),string(args[2]),int(ll.font.height),ll.font.face,ll.font.angle,ll.left,ll.top]);return (global.__layoutDraw incontextof ll)(args*);};return "trace-ready";})()',
  )
  for (const mode of ['horizontal', 'vertical', 'wrap']) {
    await evaluate(
      `(function(){f.layoutCalls=[];kag.conductor.loadScenario("layout-${mode}.ks");kag.conductor.startProcess();return "started";})()`,
    )
    await expect(page.getByText('layout-ready:' + mode, { exact: true })).toBeVisible({
      timeout: 20000,
    })
    const trace = await evaluate(
        '(function(){var rows=[];for(var i=0;i<f.layoutCalls.count;i++)rows.add(f.layoutCalls[i].join("|"));return rows.join("\\n");})()',
      ),
      state = await evaluate(
        '(function(){var m=kag.fore.messages[0];return [m.vertical,m.lineLayer.font.face,m.lineLayer.font.angle,m.lineLayer.font.height,m.lineLayerPos,m.currentRuby].join("|");})()',
      )
    await evaluate(
      `(function(){kag.fore.messages[0].lineLayer.saveLayerImage("layout-${mode}.bmp","bmp32");return "saved";})()`,
    )
    const pending = page.waitForEvent('download')
    await page.locator('#export-saves').click()
    const download = await pending,
      backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
        files: { path: string; base64: string }[]
      },
      entry = backup.files.find((file) => file.path.endsWith(`layout-${mode}.bmp`))
    assert(entry)
    const bytes = Buffer.from(entry.base64, 'base64'),
      image = decodeBmp(new Uint8Array(bytes))
    assert(image)
    const rows = trace.split('\n').map((row) => row.split('|')),
      calls = rows.map((row) => [
        Number(row[0]),
        Number(row[1]),
        row[2],
        Number(row[3]),
        row[4],
        Number(row[5]),
      ]),
      family = mode === 'horizontal' ? 'Krkr Vertical vert' : '@Krkr Vertical vert'
    assert.deepEqual(calls[0], [
      mode === 'horizontal' ? 4 : 26,
      mode === 'horizontal' ? 16 : 4,
      '漢',
      20,
      family,
      mode === 'horizontal' ? 0 : 2700,
    ])
    assert.deepEqual(calls[1], [
      mode === 'horizontal' ? 4 : 34,
      mode === 'horizontal' ? 8 : 4,
      'ぁぁ',
      10,
      family,
      mode === 'horizontal' ? 0 : 2700,
    ])
    assert.equal(calls.filter((row) => row[3] === 10).length, 1)
    if (mode === 'horizontal') {
      assert.equal(calls.length, 6)
      assert.deepEqual(
        calls.slice(2).map((row) => row.slice(0, 3)),
        [
          [24, 16, 'A'],
          [36, 16, '、'],
          [56, 16, '（'],
          [76, 16, 'ぁ'],
        ],
      )
      assert.equal(state, '0|Krkr Vertical vert|0|20|96|')
    } else if (mode === 'vertical') {
      assert.equal(calls.length, 8)
      assert.deepEqual(
        calls.slice(2).map((row) => row.slice(0, 3)),
        [
          [26, 24, 'A'],
          [26, 36, '、'],
          [26, 56, '（'],
          [26, 76, 'ぁ'],
          [4, 96, 'AA'],
          [26, 116, '漢'],
        ],
      )
      assert.deepEqual(calls[6]!.slice(3), [20, 'Krkr Vertical vert', 0])
      assert.equal(state, '1|@Krkr Vertical vert|2700|20|136|')
      const mask = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]
      for (const [x, y] of [
        [9, 10],
        [18, 7],
        [17, 16],
        [28, 7],
        [28, 17],
      ])
        assert.equal(mask(x!, y!), 255)
      assert.equal(mask(13, 12), 0)
    } else {
      assert.equal(calls.length, 11)
      const body = rows.filter((row) => Number(row[3]) === 20)
      assert.deepEqual(
        body.map((row) => [row[2], Number(row[1]), Number(row[6])]),
        [
          ['漢', 4, 346],
          ['漢', 24, 346],
          ['漢', 44, 346],
          ['、', 64, 346],
          ['漢', 4, 320],
          ['漢', 24, 320],
          ['（', 44, 320],
          ['漢', 64, 320],
          ['ぁ', 84, 320],
          ['漢', 4, 294],
        ],
      )
    }
    const restoredState = await evaluate(
      '(function(){var m=kag.fore.messages[0];kag.back.messages[0].assign(m);m.clear();m.assign(kag.back.messages[0]);return [m.vertical,m.lineLayer.font.face,m.lineLayer.font.angle,m.lineLayer.font.height,m.lineLayerPos,m.currentRuby].join("|");})()',
    )
    assert.equal(restoredState, state)
    await evaluate(
      `(function(){kag.fore.messages[0].lineLayer.saveLayerImage("layout-${mode}-restored.bmp","bmp32");return "saved";})()`,
    )
    const pendingRestored = page.waitForEvent('download')
    await page.locator('#export-saves').click()
    const restoredBackup = JSON.parse(
        await readFile((await (await pendingRestored).path())!, 'utf8'),
      ) as { files: { path: string; base64: string }[] },
      restored = restoredBackup.files.find((file) =>
        file.path.endsWith(`layout-${mode}-restored.bmp`),
      )
    assert(restored)
    assert.deepEqual(Buffer.from(restored.base64, 'base64'), bytes)
    const bitmap = `${output}/${browserName}-${backend}-${mode}.bmp`,
      screenshot = `${output}/${browserName}-${backend}-${mode}.png`
    await writeFile(bitmap, bytes)
    await page.locator('#stage canvas').screenshot({ path: screenshot })
    cases.push({
      mode,
      trace: rows,
      copiedAndRestored: true,
      state,
      width: image.width,
      height: image.height,
      nonzero: image.data.reduce(
        (sum, value, index) => sum + Number(index % 4 === 3 && value > 0),
        0,
      ),
      bitmap,
      screenshot,
    })
    console.log(mode, trace, state)
  }
  assert.deepEqual(errors, [])
  await writeFile(
    `${output}/${browserName}-${backend}.json`,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        browser: browserName,
        backend,
        indexSha256: createHash('sha256')
          .update(await readFile(root + '/index.html'))
          .digest('hex'),
        errors,
        cases,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await browser.close()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

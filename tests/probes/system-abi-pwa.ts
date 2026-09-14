import { probeBrowsers } from '../helpers/probe-browsers.ts'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
// Preserved release -> current deployment probe. Fourth argument "font" checks
// font ABI 1; "runtime"/"trace" check TJS ABI 2/3. Default checks TJS ABI 1.
// "protocol" instead checks a preserved protocol 8 shell against protocol 9,
// with unchanged TJS/font binaries and actual offline old/new Worker execution.
import assert from 'node:assert/strict'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareOffline, reloadOffline, pageBuild } from '../helpers/offline-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'

const fontAbi = process.argv[4] === 'font',
  protocol = process.argv[4] === 'protocol',
  runtimeAbi = process.argv[4] === 'runtime',
  traceAbi = process.argv[4] === 'trace',
  scriptsAbi = process.argv[4] === 'scripts',
  manifestKind = fontAbi ? 'fonts' : 'wasm',
  reportName = scriptsAbi
    ? 'scripts-abi-pwa'
    : traceAbi
      ? 'trace-abi-pwa'
      : runtimeAbi
        ? 'runtime-abi-pwa'
        : protocol
          ? 'protocol-pwa'
          : fontAbi
            ? 'font-abi-pwa'
            : 'abi-pwa',
  directory = process.argv[2] ?? 'out/verification/system-events',
  roots = [
    resolve(process.argv[3] ?? 'out/verification/system-events/abi1-root'),
    resolve(process.argv[5] ?? 'dist'),
  ],
  manifests = await Promise.all(
    roots.map(async (root) =>
      JSON.parse(await readFile(resolve(root, manifestKind + '/manifest.json'), 'utf8')),
    ),
  ),
  shells = await Promise.all(
    roots.map(async (root) => {
      const source = await readFile(resolve(root, 'sw.js'), 'utf8')
      return JSON.parse(source.slice('self.__KRKR_SHELL__='.length, source.indexOf(';\n')))
    }),
  )
const oldAbi = manifests[0].abi,
  newAbi = manifests[1].abi
if (fontAbi || protocol || runtimeAbi || traceAbi || scriptsAbi) {
  assert.equal(oldAbi, fontAbi ? 1 : scriptsAbi ? 4 : traceAbi ? 3 : 2)
  if (fontAbi || protocol) assert.equal(newAbi, 2)
  else assert([3, 4, 5].includes(newAbi) && newAbi > oldAbi)
} else {
  assert.equal(oldAbi, 1)
  assert([2, 3, 4, 5].includes(newAbi))
}
if (protocol) {
  assert.deepEqual(manifests[0], manifests[1])
  const fonts = await Promise.all(
    roots.map(async (root) =>
      JSON.parse(await readFile(resolve(root, 'fonts/manifest.json'), 'utf8')),
    ),
  )
  assert.deepEqual(fonts[0], fonts[1])
}
assert.notEqual(shells[0].build, shells[1].build)
const results: unknown[] = []
await mkdir(directory + '/' + reportName, { recursive: true })
for (const name of probeBrowsers()) {
  for (const backend of ['asyncify', 'jspi']) {
    let version = 0,
      closed = false
    const server = createServer(async (request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname.slice(1) || 'index.html'
      if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
        response.writeHead(404).end()
        return
      }
      try {
        const bytes = await readFile(resolve(roots[version]!, path))
        const mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.mjs': 'text/javascript',
          '.json': 'application/json',
          '.wasm': 'application/wasm',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.webmanifest': 'application/manifest+json',
        }
        response
          .writeHead(200, {
            'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          })
          .end(bytes)
      } catch {
        response.writeHead(404).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/?backend=${backend}`,
      profile = await mkdtemp(resolve(tmpdir(), 'krkr-abi-pwa-')),
      context = await { chromium, firefox, webkit }[name].launchPersistentContext(profile, {
        ...browserLaunchOptions,
        viewport: { width: 1280, height: 800 },
      })
    const stopServer = async () => {
      if (closed) return
      closed = true
      const done = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await done
    }
    const page = context.pages()[0] ?? (await context.newPage()),
      errors: string[] = [],
      fontRequests: string[] = []
    context.on('request', (request) => {
      if (request.url().includes('/fonts/')) fontRequests.push(request.url())
    })
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
    page.on('pageerror', (error) => errors.push(error.message))
    let loadSequence = 0
    const startups: { release: 'old' | 'current'; offline: boolean; milliseconds: number }[] = []
    const load = async (page: import('@playwright/test').Page, missing: boolean) => {
      const marker = 'abi-game-ready-' + ++loadSequence
      const started = performance.now()
      if ((traceAbi && !missing) || scriptsAbi) await page.locator('#script-debug').check()
      await page.locator('#files').setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            fontAbi
              ? 'var w=new Window(),a=new Layer(w,null);w.visible=true;w.setInnerSize(64,32);a.setSize(64,32);a.type=ltAlpha;a.font.face="font.ttf";a.font.faceIsFileName=true;a.font.height=20;a.drawText(0,0,"AV",0x123456);Debug.message("' +
                  marker +
                  '");'
              : 'var value=64;Debug.message("' + marker + '");',
          ),
        },
        ...(scriptsAbi
          ? [{ name: 'expression.tjs', mimeType: 'text/plain', buffer: Buffer.from('6*7') }]
          : []),
        ...(fontAbi
          ? [
              {
                name: 'font.ttf',
                mimeType: 'font/ttf',
                buffer: await readFile('tests/fixtures/font/narrow.ttf'),
              },
            ]
          : []),
      ])
      // Match the main browser suite's startup budget. A hosted WebKit trace
      // reached the old font release's ready marker after the default 5 s expired.
      await expect(page.locator('#logs')).toContainText(marker, { timeout: 12_000 })
      startups.push({
        release: missing ? 'old' : 'current',
        offline: closed,
        milliseconds: performance.now() - started,
      })
      if (fontAbi) {
        await evaluate(
          page,
          '[a.font.getTextWidth("AV"),a.getMaskPixel(4,10),a.getMainPixel(4,10)].join(",")',
          '24,255,1193046',
        )
        const file = manifests[missing ? 0 : 1].assets.wasm.file
        assert(fontRequests.some((url) => url.endsWith('/' + file)))
      } else if (protocol) {
        await evaluate(page, 'typeof Debug.console', missing ? 'undefined' : 'Object')
        if (!missing) {
          await evaluate(page, 'Debug.controller.visible=false', '0')
          await expect(page.locator('#debug-controller')).toBeHidden()
          await page.locator('#toggle-controller').click()
          await evaluate(page, 'Debug.controller.visible', '1')
          await page.locator('#hide-console').click()
          await expect(page.locator('#debug-console')).toBeHidden()
          await page.locator('#toggle-console').click()
          await evaluate(page, 'Debug.console.visible', '1')
        }
        await evaluate(page, 'value', '64')
      } else {
        if (!runtimeAbi && !traceAbi && !scriptsAbi)
          await evaluate(page, 'System.addContinuousHandler===void', missing ? '1' : '0')
        if (newAbi >= 3) {
          await evaluate(
            page,
            'typeof Debug.console=="Object" && Debug.console instanceof "Class"',
            missing && !traceAbi && !scriptsAbi ? '0' : '1',
          )
          if (!missing)
            await evaluate(
              page,
              '(function(){Scripts.dump();return [].load("savedata/krkr2-web.dump.txt").join("").indexOf("TJS Context Dump")>=0;})()',
              '1',
            )
        }
        if (traceAbi) {
          await evaluate(page, 'typeof Scripts.getTraceString', missing ? 'undefined' : 'Object')
          if (!missing)
            await evaluate(page, 'Scripts.getTraceString().indexOf("top level script")>=0', '1')
        }
        if (scriptsAbi) {
          await evaluate(page, 'Scripts instanceof "Class"', missing ? '0' : '1')
          await evaluate(page, 'typeof Scripts.compileStorage', missing ? 'undefined' : 'Object')
          await evaluate(
            page,
            'Scripts.eval("Scripts.getTraceString()","upgrade.tjs").indexOf("krkr2-web/bootstrap.tjs")<0',
            missing ? '0' : '1',
          )
          if (!missing)
            await evaluate(
              page,
              '(function(){Scripts.compileStorage("expression.tjs","savedata/upgrade.cjs",true,true,true);return Scripts.evalStorage("savedata/upgrade.cjs");})()',
              '42',
            )
        }
        await evaluate(page, 'value', '64')
      }
      await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
    }
    const artifact = `${directory}/${reportName}/${name}-${backend}`
    await context.tracing.start({ screenshots: name !== 'webkit', snapshots: true, sources: true })
    try {
      await page.goto(url)
      await prepareOffline(page)
      await load(page, true)
      const update = await context.newPage()
      await update.goto(url)
      expect(await pageBuild(update)).toBe(shells[0].build)
      version = 1
      await update.locator('#prepare-offline').click()
      await expect(update.locator('#reload-offline')).toBeVisible()
      await expect(update.locator('#prepare-offline')).toBeEnabled()
      await reloadOffline(update)
      expect(await pageBuild(update)).toBe(shells[1].build)
      expect(await pageBuild(page)).toBe(shells[0].build)
      await stopServer()
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
      await load(page, true)
      await load(update, false)
      const caches = await update.evaluate(() => window.caches.keys())
      assert(caches.some((key) => key.endsWith(shells[0].build)))
      assert(caches.some((key) => key.endsWith(shells[1].build)))
      assert.deepEqual(errors, [])
      results.push({
        browser: name,
        backend,
        oldBuild: shells[0].build,
        newBuild: shells[1].build,
        oldAbi,
        newAbi,
        ...(!fontAbi && !protocol && newAbi >= 3 ? { nativeClassesAndDumpVerified: true } : {}),
        ...(traceAbi ? { nativeTraceVerified: true } : {}),
        ...(scriptsAbi ? { nativeScriptsClassAndCompilerVerified: true } : {}),
        ...(protocol ? { oldProtocol: 8, newProtocol: 9, panelsVerified: true } : {}),
        oldWorkerRestartedOffline: true,
        newWorkerStartedOffline: true,
        startupTimeoutMs: 12_000,
        startups,
        caches,
        errors,
        ...(fontAbi ? { fontRequests } : {}),
      })
      await context.tracing.stop()
      console.log(
        `PASS ${name} ${backend} ${protocol ? 'protocol 8 -> 9' : manifestKind + ' ABI ' + oldAbi + ' -> ' + newAbi} with offline old/new Workers`,
      )
    } catch (error) {
      await page.screenshot({ path: artifact + '.png' }).catch(() => {})
      await context.tracing.stop({ path: artifact + '.zip' })
      throw error
    } finally {
      await context.close()
      await stopServer()
      await rm(profile, { recursive: true, force: true })
    }
  }
}
await writeFile(
  directory + '/' + reportName + '.json',
  JSON.stringify({ date: new Date().toISOString(), manifestKind, manifests, results }, null, 2) +
    '\n',
)

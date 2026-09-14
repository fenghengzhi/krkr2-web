import { test, expect, type Page } from '@playwright/test'
import { httpServer, type HttpFixture } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'

async function load(page: Page, url: string, name = '') {
  await page.locator('#remote-url').fill(url)
  await page.locator('#remote-name').fill(name)
  await page.locator('#load-url').click()
}
async function ready(page: Page, count = 0) {
  await expect(page.locator('#logs')).toContainText(`zip-ready:42:${count}`)
  await expect(page.locator('#evaluate')).toBeEnabled()
}
for (const backend of ['asyncify', 'jspi']) {
  for (const kind of ['xp3', 'zip'] as const) {
    test(`${backend}: remote ${kind} loads lazily across CORS, draws pixels and restores versioned saves`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const file = { bytes: remoteArchive(kind), etag: '"v1"' }
      const server = await httpServer({ '/download': file })
      try {
        await page.goto(`/?backend=${backend}`)
        await load(page, server.url + '/download')
        await ready(page)
        await evaluate(page, 'asset.getMainPixel(0,0)', String(0x336699))
        await expect(page.locator('canvas')).toHaveJSProperty('width', 2)
        const canvas = page.locator('canvas')
        await canvas.evaluate((node) => {
          node.style.width = '256px'
          node.style.height = '128px'
          node.style.imageRendering = 'pixelated'
        })
        const before = await canvas.screenshot()
        await evaluate(
          page,
          '(function(){layer.fillRect(0,0,2,1,0xffff0000);return layer.getMainPixel(0,0);})()',
          String(0xff0000),
        )
        await expect.poll(async () => Buffer.compare(before, await canvas.screenshot())).not.toBe(0)
        expect(server.stats().sent).toBeLessThan(file.bytes.length / 8)
        expect(server.requests.some((r) => r.method === 'OPTIONS')).toBe(true)
        expect(
          server.requests
            .filter((r) => r.range !== 'bytes=0-0' && r.method === 'GET')
            .every((r) => r.match === '"v1"'),
        ).toBe(true)
        await page.reload()
        await load(page, server.url + '/download')
        await ready(page, 1)
        file.etag = '"v2"'
        await page.reload()
        await load(page, server.url + '/download')
        await ready(page, 0)
        await page.locator('#stop').click()
        await expect(page.locator('#stop')).toBeDisabled()
        expect(errors).toEqual([])
        await testInfo.attach('range-requests', {
          body: JSON.stringify(
            { totalBytes: file.bytes.length, ...server.stats(), requests: server.requests },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      } finally {
        await server.close()
      }
    })
  }
  test(`${backend}: full HTTP fallback keeps a stable snapshot with no exposed strong ETag`, async ({
    page,
  }) => {
    const file = { bytes: zipFixture(), etag: 'W/"v1"', expose: 'Content-Range' }
    const server = await httpServer({ '/game.zip': file })
    try {
      await page.goto(`/?backend=${backend}`)
      await load(page, server.url + '/game.zip')
      await ready(page)
      expect(server.requests.filter((r) => r.method === 'GET').map((r) => r.range)).toEqual([
        'bytes=0-0',
        undefined,
      ])
      file.bytes = Buffer.from('no longer the archive')
      await evaluate(page, 'Scripts.evalStorage("シーン/value.tjs")', '42')
      expect(server.requests.filter((r) => r.method === 'GET')).toHaveLength(2)
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
    } finally {
      await server.close()
    }
  })
  test(`${backend}: a version change rejects new and cached archive reads without overwriting saves`, async ({
    page,
  }) => {
    const file = { bytes: remoteArchive('zip'), etag: '"v1"' }
    const server = await httpServer({ '/game.zip': file })
    try {
      await page.goto(`/?backend=${backend}`)
      await load(page, server.url + '/game.zip')
      await ready(page)
      file.etag = '"v2"'
      await evaluate(
        page,
        '(function(){try{Scripts.evalStorage("late.tjs");return false;}catch(e){return true;}})()',
        '1',
      )
      await evaluate(
        page,
        '(function(){try{Scripts.evalStorage("シーン/value.tjs");return false;}catch(e){return true;}})()',
        '1',
      )
      await evaluate(
        page,
        '(function(){var s=[];s.load("savedata/zip.txt","utf-8");return s[0];})()',
        'archive-save',
      )
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
      await page.reload()
      await load(page, server.url + '/game.zip')
      await ready(page)
    } finally {
      await server.close()
    }
  })
  test(`${backend}: stopping during HTTP discovery or archive mounting aborts network and can restart`, async ({
    page,
  }) => {
    const bytes = zipFixture(),
      files: Record<string, HttpFixture> = {
        '/probe.zip': { bytes, etag: '"v1"', intercept: () => true },
        '/body.zip': {
          bytes,
          etag: '"v1"',
          intercept: (request, response) => {
            if (!request.headers['if-match']) return false
            response.writeHead(206, {
              'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
              ETag: '"v1"',
              'Content-Length': bytes.length,
            })
            response.flushHeaders()
            response.write(bytes.subarray(0, 1))
            return true
          },
        },
        '/good.zip': { bytes, etag: '"v1"' },
      }
    const server = await httpServer(files)
    try {
      await page.goto(`/?backend=${backend}`)
      for (const path of ['/probe.zip', '/body.zip']) {
        const before = server.stats().aborted
        await load(page, server.url + path)
        await expect
          .poll(() =>
            server.requests.some(
              (r) => r.path === path && r.method === 'GET' && (path === '/probe.zip' || !!r.match),
            ),
          )
          .toBe(true)
        await page.locator('#stop').click()
        await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
        await expect.poll(() => server.stats().aborted).toBeGreaterThan(before)
        await expect(page.locator('#logs')).not.toContainText('zip-ready')
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
        await expect(page.locator('#load-url')).toBeEnabled()
      }
      await load(page, server.url + '/good.zip')
      await ready(page)
    } finally {
      await server.close()
    }
  })
  test(`${backend}: a CORS failure reports a load error and leaves the next game usable`, async ({
    page,
  }) => {
    const server = await httpServer({
      '/bad.zip': { bytes: zipFixture(), etag: '"v1"', cors: false },
    })
    try {
      await page.goto(`/?backend=${backend}`)
      await load(page, server.url + '/bad.zip')
      await expect(page.locator('#logs .error')).not.toHaveCount(0)
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#load-url')).toBeEnabled()
      await page
        .locator('#files')
        .setInputFiles({ name: 'good.zip', mimeType: 'application/zip', buffer: zipFixture() })
      await ready(page)
    } finally {
      await server.close()
    }
  })
}

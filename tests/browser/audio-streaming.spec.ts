import { test, expect } from '@playwright/test'
import { httpServer } from '../helpers/http-server.ts'
import { longAudioArchive, longWave } from '../helpers/streaming-audio.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: long ranged WAVE reaches the real Worklet before full download, seeks and cancels pending input`, async ({ page }, info) => {
    const errors: string[] = [], target = longWave().samples - 96000,
      fixture = longAudioArchive(String.raw`
class StreamSound extends WaveSoundBuffer {
 function StreamSound(){super.WaveSoundBuffer(null);}
 function onLabel(name){Debug.message("stream-label="+name);}
}
var sound=new StreamSound();sound.open("long.wav");sound.play();
Debug.message("stream-ready="+sound.frequency);
`, `#2.00\nLabel {Position=12000;Name="prefix";}\nLabel {Position=${target + 12000};Name="seek";}`)
    let sent = 0, holdFrom = Infinity, held = 0
    const server = await httpServer({ '/long.xp3': { bytes: Buffer.alloc(0), etag: '"stream-v1"',
      intercept(request, response) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!match) { response.writeHead(400).end('Range required'); return true }
        const start = Number(match[1]), end = Math.min(Number(match[2]), fixture.size - 1)
        if (start > end) { response.writeHead(416).end(); return true }
        response.writeHead(206, { ETag: '"stream-v1"', 'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${fixture.size}`, 'Content-Length': end - start + 1 })
        if (start >= holdFrom) { held++; response.flushHeaders(); return true }
        const bytes = fixture.read(start, end - start + 1)
        sent += bytes.length
        response.end(bytes)
        return true
      },
    } })
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`/?backend=${backend}`)
      test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
      await page.locator('#remote-url').fill(server.url + '/long.xp3')
      await page.locator('#load-url').click()
      await expect(page.locator('#logs')).toContainText('stream-ready=48000')
      const bytesAtOpen = sent
      expect(bytesAtOpen).toBeLessThan(4 * 1024 * 1024)
      await expect(page.locator('#evaluate')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#logs')).toContainText('stream-label=prefix')
      const meter = page.locator('#sound-level')
      await expect.poll(() => meter.evaluate((node) => Number((node as HTMLElement).dataset.maxPeak))).toBeGreaterThan(0.1)
      await expect.poll(() => meter.getAttribute('data-stream-voices')).toBe('1')
      expect(Number(await meter.getAttribute('data-stream-bytes'))).toBeGreaterThan(0)
      expect(Number(await meter.getAttribute('data-stream-reserved-bytes'))).toBe(4096 * 16 * 4)
      await evaluate(page, `(function(){sound.paused=true;sound.samplePosition=${target};return sound.samplePosition;})()`, String(target))
      await evaluate(page, '(function(){sound.paused=false;return sound.status;})()', 'play')
      await expect(page.locator('#logs')).toContainText('stream-label=seek')
      const afterSeek = sent, cache = await meter.evaluate((node) => ({ ...(node as HTMLElement).dataset }))
      expect(afterSeek).toBeLessThan(8 * 1024 * 1024)
      expect(Number(cache.streamBytes)).toBeLessThanOrEqual(4096 * 16 * 4)
      expect(Number(cache.streamPending)).toBeLessThanOrEqual(4)
      // Seek to an uncached middle range and stop while its actual HTTP body
      // remains outstanding. A late source must not keep the Worker alive.
      holdFrom = fixture.audioOffset + fixture.audio.size / 3
      await evaluate(page, `(function(){sound.paused=true;sound.samplePosition=${Math.floor(fixture.audio.samples / 2)};sound.play();sound.paused=false;return "waiting";})()`, 'waiting')
      await expect.poll(() => held).toBeGreaterThan(0)
      await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled({ timeout: 5000 })
      await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
      await expect.poll(() => server.stats().aborted).toBeGreaterThan(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      expect(errors).toEqual([])
      await info.attach('streaming-audio-evidence', { body: JSON.stringify({
        archiveBytes: fixture.size, decodedPcmBytes: fixture.audio.samples * 4, bytesAtOpen,
        bytesAfterSeek: afterSeek, cache, held, ...server.stats(), requests: server.requests,
        logs: await page.locator('#logs').innerText(),
      }, null, 2), contentType: 'application/json' })
    } finally { await server.close() }
  })
}

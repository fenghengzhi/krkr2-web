import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installVideoAudioChannelProbe, observeVideoAudioChannels,
  type VideoAudioChannelObservation } from '../helpers/video-audio-channel-probe.ts'

// Hand-derived fixed WaveImpl table entries, in hundredths of a decibel.
// null denotes the native -10000 silence boundary. Neither this table nor
// its expected amplitudes import the production control conversion functions.
const controls = [
  { name: 'half-volume', volume: 50000, balance: 0, readback: 0, attenuation: [-1505, -1505] },
  { name: 'same-volume-bucket', volume: 50999, balance: 0, readback: 0, attenuation: [-1505, -1505] },
  { name: 'quarter-volume-positive-pan', volume: 25000, balance: 25000, readback: 25000, attenuation: [-3634, -3010] },
  { name: 'quarter-volume-negative-pan', volume: 25000, balance: -25000, readback: -25000, attenuation: [-3010, -3634] },
  { name: 'positive-pan-silence-boundary', volume: 25000, balance: 99999, readback: 100000, attenuation: [null, -3010] },
  { name: 'negative-pan-silence-boundary', volume: 25000, balance: -99999, readback: -100000, attenuation: [-3010, null] },
  { name: 'zero-volume', volume: 0, balance: 0, readback: 0, attenuation: [null, null] },
  { name: 'below-first-bucket', volume: 999, balance: 0, readback: 0, attenuation: [null, null] },
  { name: 'first-bucket-is-silent', volume: 1000, balance: 0, readback: 0, attenuation: [null, null] },
  { name: 'top-of-first-bucket', volume: 1999, balance: 0, readback: 0, attenuation: [null, null] },
  { name: 'second-bucket', volume: 2000, balance: 0, readback: 0, attenuation: [-8494, -8494] },
  { name: 'same-second-bucket', volume: 2999, balance: 0, readback: 0, attenuation: [-8494, -8494] },
  { name: 'signed32-writes', volume: 4295017296, balance: 4294992296, readback: 25000, attenuation: [-2129, -1505] },
] as const

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: video DS attenuation controls real stereo audio independently of its public volume getter`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], readings: { phase: string; expected: readonly (number | null)[];
      frequency: number; channels: VideoAudioChannelObservation }[] = []
    await installVideoAudioProbe(page)
    await installVideoAudioChannelProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    const observe = async (phase: string, attenuation: readonly [number | null, number | null], frequency = 440) => {
      let last: VideoAudioChannelObservation | undefined
      try {
        await expect(async () => {
          last = await observeVideoAudioChannels(page)
          expect(last.errors).toEqual([])
          expect(last.graphs).toHaveLength(1)
          expect(last.liveProbeNodes).toBe(5)
          const graph = last.graphs[0]!
          expect(graph.state).toBe('running')
          for (const channel of [0, 1] as const) {
            const input = graph.input[channel], output = graph.output[channel], atten = attenuation[channel]
            // Source signal remains active even at zero gain. A stopped,
            // disconnected or silent source cannot satisfy a mute assertion.
            expect(input.rms).toBeGreaterThan(0.02)
            expect(input.peak).toBeGreaterThan(0.04)
            expect(Math.abs(input.frequency - frequency)).toBeLessThan(25)
            const amplitude = atten === null ? 0 : 10 ** (atten / 2000)
            expect(Math.abs(graph.gains[channel] - amplitude)).toBeLessThan(Math.max(1e-10, amplitude * 2e-6))
            if (atten === null) {
              expect(output.rms).toBeLessThan(0.00000001)
              expect(output.peak).toBeLessThan(0.00000001)
            } else {
              expect(output.rms).toBeGreaterThan(0)
              // Independent waveform ratio: the expected dB values above do
              // not come from AudioParam readback or the decoder under test.
              const measuredDb = 20 * Math.log10(output.rms / input.rms)
              expect(Math.abs(measuredDb - atten / 100)).toBeLessThan(0.5)
              expect(Math.abs(output.frequency - frequency)).toBeLessThan(25)
            }
          }
          const legacy = await observeVideoAudio(page)
          expect(legacy.graphs).toHaveLength(1)
          expect(legacy.graphs[0]!.state).toBe('running')
          expect(legacy.liveUrls).toBe(1)
          await expect(page.locator('video[data-video-id]')).toHaveCount(1)
          expect(await page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(false)
        }).toPass({ timeout: 12000 })
      } finally {
        if (last) readings.push({ phase, expected: attenuation, frequency, channels: last })
      }
    }
    const activate = async () => {
      await page.locator('canvas[data-window-id]').scrollIntoViewIfNeeded()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await expect(async () => {
        const button = page.getByRole('button', { name: '播放视频', exact: true })
        if (await button.isVisible()) await button.click({ timeout: 500 })
        const observation = await observeVideoAudio(page)
        expect(observation.graphs).toHaveLength(1)
        expect(observation.graphs[0]!.state).toBe('running')
        expect(observation.graphs[0]!.peak).toBeGreaterThan(0.01)
      }).toPass({ timeout: 12000 })
    }
    try {
      game = await launchWindowAttention(page, backend, binary, `
var win=new Window();win.caption="stereo controls";win.setInnerSize(96,64);win.visible=true;
var root=new Layer(win,null);root.setSize(96,64);root.fillRect(0,0,96,64,0xff000000);
var movie=new VideoOverlay(win);movie.visible=true;movie.setBounds(0,0,64,48);movie.loop=true;
movie.open("tracks.mp4");movie.play();
function setAudioControls(volume,balance){movie.audioVolume=volume;movie.audioBalance=balance;return movie.audioVolume+","+movie.audioBalance;}
function readAudioControls(){return movie.audioVolume+","+movie.audioBalance;}
`, [{ name: 'tracks.mp4', mimeType: 'video/mp4',
        buffer: readFileSync(resolve('out/verification/video-tracks/multitrack.mp4')) }], true)
      await activate()
      await observe('fresh-graph', [0, 0])
      const initialGraph = (await observeVideoAudioChannels(page)).graphs[0]!.id
      for (const control of controls) {
        await evaluate(page, `setAudioControls(${control.volume},${control.balance})`, `100000,${control.readback}`)
        await observe(control.name, control.attenuation)
        expect((await observeVideoAudioChannels(page)).graphs[0]!.id).toBe(initialGraph)
      }
      await evaluate(page, 'setAudioControls(25000,25000)', '100000,25000')
      await observe('before-getter-reads', [-3634, -3010])
      await evaluate(page, '(function(){var values=[];for(var i=0;i<8;i++)values.add(readAudioControls());movie.loop=true;movie.visible=true;return values.join("|");})()', Array(8).fill('100000,25000').join('|'))
      await observe('getters-and-unrelated-settings-do-not-unmute', [-3634, -3010])
      await evaluate(page, '(function(){movie.selectAudioStream(1);return movie.enabledAudioStream+"|"+readAudioControls();})()', '1|100000,25000')
      await observe('880Hz-selected-track-retains-controls', [-3634, -3010], 880)
      expect((await observeVideoAudioChannels(page)).graphs[0]!.id).not.toBe(initialGraph)
      await evaluate(page, '(function(){movie.close();return movie.status+"|"+readAudioControls();})()', 'unload|100000,0')
      await expect(page.locator('video')).toHaveCount(0)
      let channels = await observeVideoAudioChannels(page), legacy = await observeVideoAudio(page)
      expect(channels.graphs).toHaveLength(0); expect(channels.liveProbeNodes).toBe(0)
      expect(channels.createdGraphs).toBe(channels.releasedGraphs); expect(channels.errors).toEqual([])
      expect(legacy.graphs).toHaveLength(0); expect(legacy.liveUrls).toBe(0)
      await evaluate(page, '(function(){movie.audioVolume=0;movie.audioBalance=-100000;movie.open("tracks.mp4");movie.play();return movie.enabledAudioStream+"|"+readAudioControls();})()', '0|100000,0')
      await activate()
      await observe('reopened-graph-fresh-defaults', [0, 0])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else await stopGeometryPage(page)
      const channels = await observeVideoAudioChannels(page), legacy = await observeVideoAudio(page)
      expect(channels.graphs).toHaveLength(0); expect(channels.liveProbeNodes).toBe(0)
      expect(channels.createdGraphs).toBe(channels.releasedGraphs); expect(channels.errors).toEqual([])
      expect(legacy.graphs).toHaveLength(0); expect(legacy.liveUrls).toBe(0)
      expect(legacy.createdUrls).toBe(legacy.revokedUrls)
    } catch (error) { failures.push(error) }
    try { await info.attach('video-stereo-attenuation', { contentType: 'application/json', body: JSON.stringify({
      readings, finalChannels: await observeVideoAudioChannels(page), media: await observeVideoMedia(page),
      scope: 'Controlled browser media playback; passive stereo measurement branches, not hardware loudspeaker measurement',
      references: ['WaveImpl.cpp:515-568', 'krmovie/dsmovie.cpp:747-750'],
      publicVolumeQuirk: '100000 readback is independent of the real per-channel gain',
      logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Real stereo controls and cleanup failed', { cause: failures[0] })
  })
}

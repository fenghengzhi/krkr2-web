import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { wave } from '../helpers/audio.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { attachPhaseCapture, beginPhaseCapture, closePhaseCapture, endPhaseCapture,
  nativePhasePosition, observeNativePhaseMixer, openPhaseCapture } from '../helpers/web-phase-vocoder.ts'

const sourceRate = 44100, frequencies = [400, 8000] as const, amplitude = .25
const program = String.raw`
var emphasisDisc=new CDDASoundBuffer(null),emphasisWindow=new Window(),emphasisSerial=0,emphasisTrack="";
emphasisWindow.caption="CD pre-emphasis";emphasisWindow.setInnerSize(400,64);
var emphasisRoot=new Layer(emphasisWindow,null);emphasisWindow.add(emphasisRoot);
emphasisRoot.setSize(400,64);emphasisRoot.holdAlpha=false;emphasisRoot.fillRect(0,0,400,64,0xff182838);
function emphasisAction(action){
 if(action==0 || action==1){
  emphasisTrack=action==0?"D:1":"E:1";
  emphasisDisc.open(emphasisTrack);emphasisDisc.looping=true;emphasisDisc.paused=false;emphasisDisc.play();
 }else if(action==2){emphasisDisc.paused=true;emphasisDisc.position=750;}
 else if(action==3)emphasisDisc.paused=false;
 else emphasisDisc.stop();
 var position=action==2?emphasisDisc.position:-1;
 Debug.message("cd-pre:"+(++emphasisSerial)+":"+action+":"+emphasisTrack+":"+emphasisDisc.status+":"+
  int(emphasisDisc.paused)+":"+emphasisDisc.totalTime+":"+position);
}
for(var i=0;i<5;i++){
 var button=new Layer(emphasisWindow,emphasisRoot);emphasisWindow.add(button);button.setPos(i*80,0);button.setSize(78,64);
 button.holdAlpha=false;button.fillRect(0,0,78,64,0xff304860);button.font.height=14;
 button.drawText(6,22,["Plain","PRE","Seek","Resume","Stop"][i],0xffffff,255,true);
 button.action=i;button.onClick=function(){global.emphasisAction(this.action);};button.visible=true;
}
emphasisWindow.visible=true;Debug.message("cd-pre-ready");
`

/** Independent sinusoidal projection. No production decoder/filter supplies
 * an expected sample or coefficient. Both discs use these identical PCM bytes. */
function toneMetrics(samples: readonly number[], rate: number, frequency: number) {
  let real = 0, imaginary = 0, weight = 0, squares = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!, window = .5 - .5 * Math.cos(2 * Math.PI * i / (samples.length - 1)),
      angle = 2 * Math.PI * frequency * i / rate
    if (!Number.isFinite(value)) throw new Error('Non-finite CD playback sample')
    real += value * window * Math.cos(angle); imaginary += value * window * Math.sin(angle)
    weight += window; squares += value * value
  }
  return { amplitude: 2 * Math.hypot(real, imaginary) / weight, rms: Math.sqrt(squares / samples.length) }
}

// The CD 50/15 microsecond playback transfer function, independently evaluated
// at each authored tone. The source-rate digital implementation approximates
// this analog curve; it is not an exact device/DirectSound waveform claim.
const analogGain = (frequency: number) => Math.hypot(1, 2 * Math.PI * frequency * 15e-6) /
  Math.hypot(1, 2 * Math.PI * frequency * 50e-6)

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real CD buttons apply PRE treble attenuation through seek and whole-track loops`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      pcm = wave(Array.from({ length: sourceRate * 2 }, (_, at) =>
        amplitude * Math.sin(2 * Math.PI * frequencies[at % 2]! * Math.floor(at / 2) / sourceRate)), sourceRate, 2),
      cue = (pre: boolean) => `FILE "signal.wav" WAVE\n TRACK 01 AUDIO\n${pre ? ' FLAGS PRE\n' : ''} INDEX 01 00:00:00\n`,
      canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^CD pre-emphasis$/ }) })
        .locator('canvas[data-window-id]')
    let serial = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const click = async (action: number, track: string, paused = false) => {
      const point = await pointerPixel(canvas, action * 80 + 38, 32)
      await page.mouse.click(point.x, point.y)
      await expect(page.getByText(`cd-pre:${++serial}:${action}:${track}:${action === 4 ? 'stop' : 'play'}:${Number(paused)}:1000:${action === 2 ? 750 : -1}`,
        { exact: true })).toBeVisible({ timeout: 10000 })
    }
    const capture = async (name: string) => {
      const before = await nativePhasePosition(page)
      expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
      expect(before.snapshot.looping).toBe(true)
      await beginPhaseCapture(page, 1.2, { positionVoiceOnComplete: before.snapshot.id })
      const recording = await endPhaseCapture(page)
      await attachPhaseCapture(info, name, recording, { before, sourceRate, frequencies, amplitude })
      expect(recording.sampleRate).toBeGreaterThanOrEqual(32000)
      expect(recording.channels).toHaveLength(2)
      expect(recording.completionPosition?.error).toBeUndefined()
      expect(recording.completionPosition?.observation?.snapshot.status).toBe('play')
      expect(recording.completionPosition?.observation?.snapshot.looping).toBe(true)
      const metrics = recording.channels.map((samples, channel) => {
        expect(samples).toHaveLength(Math.ceil(recording.sampleRate * 1.2))
        // Every tenth of a second must contain real music, including a seam:
        // the capture is longer than the authored one-second CD track.
        const bucket = Math.floor(recording.sampleRate / 10)
        for (let start = 0; start + bucket <= samples.length; start += bucket) {
          let sum = 0
          for (let at = start; at < start + bucket; at++) sum += samples[at]! ** 2
          expect(Math.sqrt(sum / bucket)).toBeGreaterThan(.035)
        }
        return toneMetrics(samples, recording.sampleRate, frequencies[channel]!)
      })
      observations.push({ name, sampleRate: recording.sampleRate, metrics, before,
        after: recording.completionPosition?.observation })
      return { sampleRate: recording.sampleRate, metrics }
    }
    const seek = async (track: string) => {
      await click(2, track, true)
      const paused = await nativePhasePosition(page)
      expect(paused.snapshot.paused).toBe(true); expect(paused.snapshot.position).toBe(33075)
      observations.push({ seek: track, milliseconds: 750, paused })
      await click(3, track)
    }
    try {
      await page.locator('#cdda-discs').fill('D=plain.cue\nE=pre.cue')
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("emphasis.tjs",System.dataPath+"emphasis.cjs",false,true,false);Scripts.execStorage(System.dataPath+"emphasis.cjs");'
          : 'Scripts.execStorage("emphasis.tjs");') },
        { name: 'emphasis.tjs', mimeType: 'text/plain', buffer: Buffer.from(program) },
        { name: 'signal.wav', mimeType: 'audio/wav', buffer: Buffer.from(pcm) },
        { name: 'plain.cue', mimeType: 'text/plain', buffer: Buffer.from(cue(false)) },
        { name: 'pre.cue', mimeType: 'text/plain', buffer: Buffer.from(cue(true)) },
      ])
      await expect(page.getByText('cd-pre-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await click(0, 'D:1'); await openPhaseCapture(page)
      const plain = await capture('plain-loop')
      await seek('D:1'); const plainSeek = await capture('plain-seek-loop')
      await click(1, 'E:1'); const pre = await capture('pre-loop')
      await seek('E:1'); const preSeek = await capture('pre-seek-loop')
      for (const recording of [plainSeek, pre, preSeek]) expect(recording.sampleRate).toBe(plain.sampleRate)
      for (let channel = 0; channel < frequencies.length; channel++) {
        const original = plain.metrics[channel]!, expected = analogGain(frequencies[channel]!)
        expect(original.amplitude).toBeGreaterThan(.18); expect(original.amplitude).toBeLessThan(.26)
        expect(Math.abs(plainSeek.metrics[channel]!.amplitude / original.amplitude - 1)).toBeLessThan(.02)
        for (const [name, recording] of [['pre', pre], ['pre-seek', preSeek]] as const) {
          const ratio = recording.metrics[channel]!.amplitude / original.amplitude,
            deviationDb = 20 * Math.log10(ratio / expected)
          observations.push({ name, channel, frequency: frequencies[channel], ratio, analogGain: expected, deviationDb })
          expect(Math.abs(deviationDb)).toBeLessThan(.75)
          if (channel === 0) expect(ratio).toBeGreaterThan(.97)
          else expect(ratio).toBeLessThan(.55)
        }
      }
      await click(4, 'E:1')
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page); await attachPhaseCapture(info, 'stopped-disc', stopped)
      for (const samples of stopped.channels) expect(samples).toEqual(Array(samples.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('cd-pre-emphasis-observations', { contentType: 'application/json', body: JSON.stringify({
        backend, binary, sourceRate, frequencies, amplitude, frames: sourceRate,
        waveSha256: createHash('sha256').update(pcm).digest('hex'), cues: { plain: cue(false), pre: cue(true) },
        observations, errors, logs: await page.locator('#logs').innerText(),
        scope: 'Same authored stereo PCM; actual CD.open/paused 750ms seek/resume/loop buttons; real production AudioWorklet capture. PRE amplitude ratios compare the independent analog 50/15 microsecond curve with 0.75 dB digital-fit allowance. No physical CD-device or original Windows PCM equality claim.',
      }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'CD PRE playback or cleanup failed', { cause: failures[0] })
  })

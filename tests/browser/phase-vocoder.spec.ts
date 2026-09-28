import { test, expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { wave } from '../helpers/audio.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  releasePhaseWorklet,
  openPhaseCapture,
  closePhaseCapture,
  observeNativePhaseMixer,
  nativePhasePosition,
  phaseFilter,
  phaseTone,
  sourceRate,
  loadPhasePcm,
  phaseCommand,
  beginPhaseCapture,
  endPhaseCapture,
  attachPhaseCapture,
  attachPhaseInput,
  type CapturedPhaseAudio,
  type PhaseFilter,
} from '../helpers/web-phase-vocoder.ts'

let release: Awaited<ReturnType<typeof releasePhaseWorklet>>
test.beforeAll(async () => {
  release = await releasePhaseWorklet()
})

function soundEvents(capture: CapturedPhaseAudio) {
  return capture.events.flatMap(({ message }) =>
    message.type === 'event'
      ? [message.event]
      : message.type === 'reply'
        ? (message.result?.events ?? [])
        : [],
  )
}
function assertFinite(metrics: Awaited<ReturnType<typeof attachPhaseCapture>>, audible = true) {
  for (const channel of metrics) {
    expect(channel.nonfinite).toBe(0)
    expect(channel.peak).toBeLessThan(2)
    if (audible) expect(channel.rms).toBeGreaterThan(0.002)
  }
}
async function directClip(
  page: Page,
  info: TestInfo,
  name: string,
  data: number[][],
  filters: PhaseFilter[],
  seconds: number,
  frequency = sourceRate,
) {
  await attachPhaseInput(info, name, data)
  await loadPhasePcm(page, data, filters)
  await phaseCommand(page, { op: 'set', id: 1, property: 'frequency', value: frequency })
  await beginPhaseCapture(page, seconds)
  await phaseCommand(page, { op: 'play', id: 1 })
  const capture = await endPhaseCapture(page),
    metrics = await attachPhaseCapture(info, name, capture, {
      release,
      sourceRate,
      inputFrames: data[0]!.length,
      filters,
      frequency,
    })
  expect(soundEvents(capture).filter((event) => event.type === 'error')).toEqual([])
  assertFinite(metrics)
  return { capture, metrics }
}

test('release AudioWorklet independently changes pitch and duration before playback frequency', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await openPhaseCapture(page, release.url)
  const data = phaseTone(0.5),
    results: Record<string, Awaited<ReturnType<typeof directClip>>> = {}
  try {
    for (const scenario of [
      { name: 'identity', pitch: 1, time: 1, frequency: sourceRate, expected: 750, seconds: 0.85 },
      {
        name: 'pitch-double',
        pitch: 2,
        time: 1,
        frequency: sourceRate,
        expected: 1500,
        seconds: 0.85,
      },
      {
        name: 'pitch-half',
        pitch: 0.5,
        time: 1,
        frequency: sourceRate,
        expected: 375,
        seconds: 0.85,
      },
      {
        name: 'time-double',
        pitch: 1,
        time: 2,
        frequency: sourceRate,
        expected: 750,
        seconds: 1.35,
      },
      {
        name: 'composed-frequency',
        pitch: 2,
        time: 1.5,
        frequency: sourceRate / 2,
        expected: 750,
        seconds: 1.85,
      },
    ]) {
      const result = await directClip(
        page,
        info,
        scenario.name,
        data,
        [phaseFilter({ pitch: scenario.pitch, time: scenario.time })],
        scenario.seconds,
        scenario.frequency,
      )
      results[scenario.name] = result
      for (const channel of result.metrics) {
        expect(channel.spectrum.count).toBeGreaterThanOrEqual(8192)
        expect(Math.abs(channel.spectrum.peakHz / scenario.expected - 1)).toBeLessThan(0.01)
      }
      expect(soundEvents(result.capture).filter((event) => event.type === 'ended')).toHaveLength(1)
    }
    // Independent waveform support, with an explicit window-bound endpoint
    // margin. The filter intentionally does not flush an invented EOF tail.
    const duration = (name: string) => results[name]!.metrics[0]!.audibleSeconds,
      base = duration('identity'),
      margin = (4 * 512) / sourceRate
    expect(Math.abs(duration('pitch-double') - base)).toBeLessThan(margin)
    expect(Math.abs(duration('pitch-half') - base)).toBeLessThan(margin)
    expect(Math.abs(duration('time-double') - 2 * base)).toBeLessThan(margin)
    expect(Math.abs(duration('composed-frequency') - 3 * base)).toBeLessThan(margin * 2)
    await info.attach('pitch-time-duration-comparison.json', {
      body: JSON.stringify(
        Object.fromEntries(Object.entries(results).map(([name, value]) => [name, value.metrics])),
        null,
        2,
      ),
      contentType: 'application/json',
    })
  } finally {
    await closePhaseCapture(page)
  }
})

test('release AudioWorklet keeps stereo isolation and executes ordered windowed stages with bounded EOF', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await openPhaseCapture(page, release.url)
  try {
    const stereo = await directClip(
      page,
      info,
      'stereo',
      phaseTone(0.5, [750, 1125]),
      [phaseFilter({ pitch: 2 })],
      0.85,
    )
    for (const [index, expected, wrong] of [
      [0, 1500, 2250],
      [1, 2250, 1500],
    ]) {
      const spectrum = stereo.metrics[index!]!.spectrum
      expect(Math.abs(spectrum.peakHz / expected! - 1)).toBeLessThan(0.01)
      expect(spectrum.probes[wrong!]!).toBeLessThan(spectrum.probes[expected!]! * 0.02)
    }
    // A two-tone signal with short transients makes order and window effects
    // observable. Merely multiplying pitch/time parameters cannot pass this.
    const rich = phaseTone(0.55)
    for (let frame = 0; frame < rich[0]!.length; frame++) {
      rich[0]![frame] =
        0.08 * Math.sin((2 * Math.PI * 691 * frame) / sourceRate) +
        0.07 * Math.sin((2 * Math.PI * 1207 * frame) / sourceRate) +
        (frame % 4800 < 32 ? 0.08 : 0)
    }
    const first = phaseFilter({ id: 1, window: 512, pitch: 1.5, time: 1.25 }),
      second = phaseFilter({ id: 2, window: 2048, pitch: 0.75, time: 0.8 }),
      ordered = await directClip(page, info, 'chain-first-second', rich, [first, second], 0.9),
      reversed = await directClip(page, info, 'chain-second-first', rich, [second, first], 0.9),
      narrow = await directClip(page, info, 'single-window-512', rich, [phaseFilter()], 0.9),
      wide = await directClip(
        page,
        info,
        'single-window-2048',
        rich,
        [phaseFilter({ window: 2048 })],
        0.9,
      )
    // Compare independently aligned waveforms. Avoid main-thread
    // scheduling offsets between arm and play becoming the claimed DSP effect.
    const alignedDifference = (a: typeof ordered, b: typeof ordered) => {
      const left = a.capture.channels[0]!,
        right = b.capture.channels[0]!,
        startA = a.metrics[0]!.first,
        startB = b.metrics[0]!.first,
        count = Math.min(left.length - startA, right.length - startB, sourceRate / 3)
      let squared = 0
      for (let index = 0; index < count; index++)
        squared += (left[startA + index]! - right[startB + index]!) ** 2
      return Math.sqrt(squared / count)
    }
    const differences = {
      order: alignedDifference(ordered, reversed),
      window: alignedDifference(narrow, wide),
    }
    await info.attach('independent-stage-differences.json', {
      body: JSON.stringify(differences),
      contentType: 'application/json',
    })
    expect(differences.order).toBeGreaterThan(0.0001)
    expect(differences.window).toBeGreaterThan(0.0001)
    // Short and partial source inputs must terminate. Silence is valid here;
    // save all samples and actual events rather than inventing a flushed tail.
    await expect(loadPhasePcm(page, [[]], [phaseFilter()])).rejects.toThrow('Invalid decoded audio')
    await info.attach('empty-source-rejected.json', {
      body: JSON.stringify({
        sourceFrames: 0,
        expected: 'Invalid decoded audio',
        playbackAttempted: false,
      }),
      contentType: 'application/json',
    })
    for (const frames of [37, 512 + 113]) {
      const source = [phaseTone(0.02)[0]!.slice(0, frames)]
      await attachPhaseInput(info, `short-${frames}`, source)
      await loadPhasePcm(page, source, [phaseFilter()])
      await beginPhaseCapture(page, 0.25)
      await phaseCommand(page, { op: 'play', id: 1 })
      const captured = await endPhaseCapture(page),
        measured = await attachPhaseCapture(info, `short-${frames}`, captured, {
          sourceFrames: frames,
        })
      assertFinite(measured, false)
      expect(soundEvents(captured).filter((event) => event.type === 'error')).toEqual([])
      expect(soundEvents(captured).filter((event) => event.type === 'ended')).toHaveLength(1)
      expect((await phaseCommand(page, { op: 'inspect', id: 1 })).snapshot?.status).toBe('stop')
    }
  } finally {
    await closePhaseCapture(page)
  }
})

test('release AudioWorklet publishes consumed labels and flushes seek while preserving pause, fade, stop and EOF', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await openPhaseCapture(page, release.url)
  try {
    const data = phaseTone(1)
    for (let frame = sourceRate / 2; frame < data[0]!.length; frame++)
      data[0]![frame] = 0.2 * Math.sin((2 * Math.PI * 1125 * frame) / sourceRate)
    await attachPhaseInput(info, 'timeline', data)
    await loadPhasePcm(
      page,
      data,
      [phaseFilter({ window: 4096, time: 2 })],
      [
        { position: sourceRate * 0.2, name: 'pre-read-boundary' },
        { position: sourceRate / 2, name: 'old-middle' },
        { position: sourceRate * 0.65, name: 'after-seek' },
      ],
    )
    // At 0.25 output seconds source consumption is near 0.125 seconds;
    // the 4096-frame lookahead can already cross the 0.2-second label.
    // Keep 150 ms before its audible deadline for the port reply barrier.
    await beginPhaseCapture(page, 0.25)
    await phaseCommand(page, { op: 'play', id: 1 })
    const early = await endPhaseCapture(page),
      paused = await phaseCommand(page, { op: 'set', id: 1, property: 'paused', value: true })
    await attachPhaseCapture(info, 'before-source-label', early)
    expect(soundEvents(early).filter((event) => event.type === 'label')).toEqual([])
    expect(paused.snapshot!.position).toBeLessThan(sourceRate / 2)
    await beginPhaseCapture(page, 0.18)
    const silence = await endPhaseCapture(page),
      silentMetrics = await attachPhaseCapture(info, 'paused-silence', silence)
    expect((await phaseCommand(page, { op: 'inspect', id: 1 })).snapshot!.position).toBe(
      paused.snapshot!.position,
    )
    expect(silentMetrics[0]!.peak).toBe(0)
    await beginPhaseCapture(page, 0.35)
    await phaseCommand(page, { op: 'set', id: 1, property: 'paused', value: false })
    const resumed = await endPhaseCapture(page)
    await phaseCommand(page, { op: 'set', id: 1, property: 'paused', value: true })
    const resumedMetrics = await attachPhaseCapture(info, 'resumed-before-seek', resumed)
    expect(Math.abs(resumedMetrics[0]!.spectrum.peakHz / 750 - 1)).toBeLessThan(0.01)
    expect(
      soundEvents(resumed)
        .filter((event) => event.type === 'label')
        .map((event) => event.label),
    ).toEqual(['pre-read-boundary'])
    // The explicit seek must discard the old buffered phase. Its label must not
    // escape from a prefetched FFT window after the seek generation changes.
    await phaseCommand(page, { op: 'set', id: 1, property: 'position', value: sourceRate * 0.6 })
    await beginPhaseCapture(page, 0.4)
    await phaseCommand(page, { op: 'set', id: 1, property: 'paused', value: false })
    const seek = await endPhaseCapture(page)
    await phaseCommand(page, { op: 'set', id: 1, property: 'paused', value: true })
    const seekMetrics = await attachPhaseCapture(info, 'seek-new-frequency', seek)
    expect(Math.abs(seekMetrics[0]!.spectrum.peakHz / 1125 - 1)).toBeLessThan(0.01)
    const labels = soundEvents(seek).filter((event) => event.type === 'label')
    expect(labels.map((event) => event.label)).toEqual(['after-seek'])
    expect(labels[0]!.snapshot.position).toBeGreaterThanOrEqual(sourceRate * 0.65)
    const fadeDurations: number[] = []
    for (const time of [0.5, 1.5]) {
      await loadPhasePcm(page, phaseTone(1), [phaseFilter({ time })])
      await beginPhaseCapture(page, 0.3)
      await phaseCommand(page, { op: 'play', id: 1 })
      await phaseCommand(page, { op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
      const faded = await endPhaseCapture(page)
      await phaseCommand(page, { op: 'stop', id: 1 })
      const fadedMetrics = await attachPhaseCapture(info, `fade-time-${time}`, faded)
      expect(fadedMetrics[0]!.peak).toBeGreaterThan(0.02)
      expect(fadedMetrics[0]!.audibleSeconds).toBeGreaterThan(0.05)
      expect(fadedMetrics[0]!.audibleSeconds).toBeLessThan(0.2)
      fadeDurations.push(fadedMetrics[0]!.audibleSeconds)
      expect(soundEvents(faded).filter((event) => event.type === 'fade')).toHaveLength(1)
      expect(soundEvents(faded).filter((event) => event.type === 'ended')).toEqual([])
      expect(Math.max(...faded.channels[0]!.slice(-1024).map(Math.abs))).toBe(0)
    }
    expect(Math.abs(fadeDurations[0]! - fadeDurations[1]!)).toBeLessThan(0.03)
    expect((await phaseCommand(page, { op: 'inspect', id: 1 })).snapshot!.position).toBe(0)
    await phaseCommand(page, { op: 'set', id: 1, property: 'volume', value: 100000 })
    await beginPhaseCapture(page, 0.35)
    await phaseCommand(page, { op: 'play', id: 1 })
    const restarted = await endPhaseCapture(page),
      restartedMetrics = await attachPhaseCapture(info, 'stop-restart', restarted)
    expect(Math.abs(restartedMetrics[0]!.spectrum.peakHz / 750 - 1)).toBeLessThan(0.01)
    await phaseCommand(page, { op: 'stop', id: 1 })
    await beginPhaseCapture(page, 0.15)
    const stopped = await endPhaseCapture(page)
    expect((await attachPhaseCapture(info, 'stopped-silence', stopped))[0]!.peak).toBe(0)
    await loadPhasePcm(
      page,
      phaseTone(0.2),
      [phaseFilter({ time: 2 })],
      [{ position: sourceRate * 0.15, name: 'tail' }],
    )
    await beginPhaseCapture(page, 0.65)
    await phaseCommand(page, { op: 'play', id: 1 })
    const ending = await endPhaseCapture(page)
    await attachPhaseCapture(info, 'tail-and-ended', ending)
    expect(
      soundEvents(ending).map((event) => (event.type === 'label' ? event.label : event.type)),
    ).toEqual(['tail', 'ended'])
    expect(soundEvents(ending).filter((event) => event.type === 'ended')).toHaveLength(1)
  } finally {
    await closePhaseCapture(page)
  }
})

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    test(`${backend} ${binary ? 'bytecode' : 'source'}: native PhaseVocoder ownership and updates reach actual player AudioWorklet samples`, async ({
      page,
    }, info) => {
      test.setTimeout(60_000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await observeNativePhaseMixer(page)
      await page.goto(`/?backend=${backend}`)
      test.skip(
        backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
        'JSPI unavailable',
      )
      const source = String.raw`
function requirePhase(condition,name){if(!condition)throw new Exception("phase-browser:"+name);}
var phase=new WaveSoundBuffer.PhaseVocoder();
requirePhase(phase.window==4096 && phase.overlap==0 && phase.pitch==1 && phase.time==1,"defaults");
requirePhase(phase.interface>0,"native-interface");
var readonly=false;try{phase.interface=42;}catch(e){readonly=true;}
requirePhase(readonly,"readonly-interface");
var invalid=false;try{phase.window=65;}catch(e){invalid=true;}
requirePhase(invalid && phase.window==4096,"window-validation");
phase.window=512.9;phase.overlap=4.9;phase.pitch=0.1;phase.time=0.1;
requirePhase(phase.window==512 && phase.overlap==4,"integer-conversion");
requirePhase(phase.pitch==0.10000000149011612 && phase.time==0.10000000149011612,"float32-conversion");
phase.pitch=2;phase.time=1;
class PhaseSound extends WaveSoundBuffer {
 function PhaseSound(){super.WaveSoundBuffer(null);}
 function onLabel(name){Debug.message("phase-label:"+name);}
 function onStatusChanged(status){Debug.message("phase-status:"+status);}
}
class ThrowingPhaseFilter { property interface { getter(){throw new Exception("phase-getter-threw");} } }
var rejected=new WaveSoundBuffer(null);rejected.filters.add(new ThrowingPhaseFilter());
var getterThrew=false;try{rejected.open("phase.wav");}catch(e){getterThrew=true;}
requirePhase(getterThrew && rejected.status=="unload","throwing-interface");
rejected.filters.clear();rejected.filters.add(%[interface:phase.interface]);
var forged=false;try{rejected.open("phase.wav");}catch(e){forged=true;}
requirePhase(forged && rejected.status=="unload","forged-interface");
invalidate rejected;
var sound=new PhaseSound(),other=new WaveSoundBuffer(null);
requirePhase(sound.filters===sound.filters,"array-identity");
sound.filters.add(phase);sound.open("phase.wav");sound.filters.clear();
other.filters.add(phase);var busy=false;try{other.open("phase.wav");}catch(e){busy=true;}
requirePhase(busy,"single-owner");sound.stop();busy=false;
try{other.open("phase.wav");}catch(e){busy=true;}
requirePhase(busy,"stop-keeps-attachment");
sound.looping=true;sound.play();Debug.message("phase-native-ready");
`
      const sourceWav = Buffer.from(wave(phaseTone(1)[0]!, sourceRate))
      await info.attach('native-input-pcm16.wav', { body: sourceWav, contentType: 'audio/wav' })
      await page.locator('#files').setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            binary
              ? 'Scripts.compileStorage("phase-proof.tjs","savedata/phase-proof.cjs",false,true,false);Scripts.execStorage("savedata/phase-proof.cjs");'
              : 'Scripts.execStorage("phase-proof.tjs");',
          ),
        },
        { name: 'phase-proof.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        {
          name: 'phase.wav',
          mimeType: 'audio/wav',
          buffer: sourceWav,
        },
        {
          name: 'phase.wav.sli',
          mimeType: 'text/plain',
          buffer: Buffer.from('#2.00\nLabel {Position=24000;Name="middle";}'),
        },
      ])
      await expect(page.getByText('phase-native-ready', { exact: true })).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
        await page.locator('#sound-toggle').click()
      await openPhaseCapture(page)
      try {
        await beginPhaseCapture(page, 0.55)
        const initial = await endPhaseCapture(page),
          initialMetrics = await attachPhaseCapture(info, 'native-pitch-two', initial, {
            backend,
            binary,
            release,
          })
        assertFinite(initialMetrics)
        expect(Math.abs(initialMetrics[0]!.spectrum.peakHz / 1500 - 1)).toBeLessThan(0.01)
        // Array.clear above must not release the open snapshot. Updating the
        // retained object now changes actual output through Worker + host RPC.
        await evaluate(
          page,
          '(function(){phase.pitch=1;phase.time=2;return phase.pitch+","+phase.time;})()',
          '1,2',
        )
        const positionBefore = await nativePhasePosition(page)
        await beginPhaseCapture(page, 0.75)
        const updated = await endPhaseCapture(page),
          positionAfter = await nativePhasePosition(page),
          elapsed =
            (positionAfter.before +
              positionAfter.after -
              positionBefore.before -
              positionBefore.after) /
            2,
          sourceAdvance =
            (positionAfter.snapshot.position -
              positionBefore.snapshot.position +
              positionAfter.snapshot.sampleCount) %
            positionAfter.snapshot.sampleCount,
          sourceRatio = sourceAdvance / (elapsed * positionAfter.snapshot.sampleRate),
          elapsedLow = positionAfter.before - positionBefore.after,
          elapsedHigh = positionAfter.after - positionBefore.before,
          ratioLow = sourceAdvance / (elapsedHigh * positionAfter.snapshot.sampleRate),
          ratioHigh = sourceAdvance / (elapsedLow * positionAfter.snapshot.sampleRate),
          updatedMetrics = await attachPhaseCapture(info, 'native-retained-filter-updated', updated)
        await info.attach('native-time-two-position-slope.json', {
          body: JSON.stringify({
            positionBefore,
            positionAfter,
            elapsed,
            sourceAdvance,
            sourceRatio,
            elapsedLow,
            elapsedHigh,
            ratioLow,
            ratioHigh,
          }),
          contentType: 'application/json',
        })
        expect(elapsed).toBeLessThan(1.5)
        // Replies bracket the actual sample instant; do not mistake main
        // thread delivery jitter for a DSP time error. The measured interval
        // must still be tight enough to reject an unfiltered 1:1 source clock.
        expect(elapsedLow).toBeGreaterThan(0.5)
        expect(ratioHigh - ratioLow).toBeLessThan(0.1)
        expect(ratioLow).toBeLessThan(0.505)
        expect(ratioHigh).toBeGreaterThan(0.495)
        expect(ratioHigh).toBeLessThan(0.8)
        assertFinite(updatedMetrics)
        // Analyze the latter half, after the finite already-decoded FIFO.
        const crop = Math.floor(updated.channels[0]!.length / 2),
          late = {
            ...updated,
            startFrame: updated.startFrame + crop,
            channels: updated.channels.map((channel) => channel.slice(crop)),
          }
        const lateMetrics = await attachPhaseCapture(info, 'native-updated-steady', late)
        expect(Math.abs(lateMetrics[0]!.spectrum.peakHz / 750 - 1)).toBeLessThan(0.01)
        await expect(page.locator('#logs')).toContainText('phase-label:middle')
        await evaluate(
          page,
          '(function(){sound.stop();sound.open("phase.wav");phase.pitch=2;other.open("phase.wav");other.looping=true;other.play();return other.status+","+sound.filters.count;})()',
          'play,0',
        )
        await beginPhaseCapture(page, 0.5)
        const reused = await endPhaseCapture(page),
          reusedMetrics = await attachPhaseCapture(info, 'native-filter-reused-after-open', reused)
        expect(Math.abs(reusedMetrics[0]!.spectrum.peakHz / 1500 - 1)).toBeLessThan(0.01)
        await evaluate(page, '(function(){invalidate phase;return isvalid phase;})()', '0')
        await beginPhaseCapture(page, 0.5)
        const retained = await endPhaseCapture(page),
          retainedMetrics = await attachPhaseCapture(
            info,
            'native-invalidated-but-connected',
            retained,
          )
        assertFinite(retainedMetrics)
        expect(Math.abs(retainedMetrics[0]!.spectrum.peakHz / 1500 - 1)).toBeLessThan(0.01)
      } finally {
        await closePhaseCapture(page)
        await page.locator('#stop').click()
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
        expect(errors).toEqual([])
      }
    })
  }
}

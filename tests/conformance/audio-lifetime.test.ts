import test from 'node:test'
import assert from 'node:assert/strict'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { PortAudioBackend } from '../../src/backends/audio/port-backend.ts'
import { defaultSoundSettings, emptyLoops, type PcmAsset } from '../../src/engine/ports/audio.ts'
import type { AudioRequest } from '../../src/protocol/audio.ts'
import { AudioClock } from '../helpers/audio.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function pcm(sample = 0.5): PcmAsset {
  return {
    kind: 'pcm',
    sampleRate: 1000,
    sampleCount: 5,
    channels: 1,
    bits: 16,
    data: [Float32Array.from({ length: 5 }, () => sample)],
    loops: emptyLoops(),
  }
}
const open = (id = 7) => ({
  op: 'open' as const,
  id,
  kind: 'wave' as const,
  bytes: new Uint8Array([1]),
  loops: emptyLoops(),
  settings: defaultSoundSettings(),
})

test('headless audio sleeps without playback and rearms without advancing paused voices', async () => {
  const clock = new AudioClock(),
    frames: number[] = []
  const audio = new HeadlessAudioBackend(
    { now: () => clock.now, schedule: clock.schedule },
    (left) => frames.push(left.length),
    1000,
  )
  try {
    await audio.command({ op: 'load', id: 7, asset: pcm(), settings: defaultSoundSettings() })
    assert.equal(clock.tasks.size, 0)
    clock.advance(1000)
    await audio.command({ op: 'play', id: 7 })
    assert.equal(clock.tasks.size, 1)
    await audio.command({ op: 'pauseAll', paused: true })
    assert.equal(clock.tasks.size, 0)
    clock.advance(1000)
    await audio.command({ op: 'pauseAll', paused: false })
    assert.equal((await audio.command({ op: 'inspect', id: 7 })).snapshot?.position, 0)
    clock.advance(20)
    assert.equal((await audio.command({ op: 'inspect', id: 7 })).snapshot?.status, 'stop')
    assert.equal(
      frames.reduce((sum, count) => sum + count, 0),
      20,
    )
    assert.equal(clock.tasks.size, 0)
    await audio.command({ op: 'play', id: 7 })
    assert.equal(clock.tasks.size, 1)
    await audio.command({ op: 'close', id: 7 })
    assert.deepEqual(audio.inspect(), {
      voices: 0,
      fadingVoices: 0,
      liveMidiNotes: 0,
      clockWork: false,
      clockTasks: 0,
      pendingCreates: 0,
    })
  } finally {
    await audio.close()
  }
})

test('headless fades and live MIDI own the clock only while they have work', async () => {
  const clock = new AudioClock(),
    events: string[] = []
  const audio = new HeadlessAudioBackend(
    { now: () => clock.now, schedule: clock.schedule },
    undefined,
    1000,
  )
  audio.listen((event) => events.push(event.type))
  try {
    await audio.command({ op: 'create', id: 7, settings: defaultSoundSettings() })
    assert.equal(clock.tasks.size, 0)
    await audio.command({ op: 'fade', id: 7, target: 0, time: 10, delay: 0 })
    assert.equal(clock.tasks.size, 1)
    clock.advance(80)
    assert.deepEqual(events, ['fade'])
    assert.equal(clock.tasks.size, 0)
    await audio.command({ op: 'close', id: 7 })
    await audio.command({ op: 'midiOut', data: new Uint8Array([0x90, 60, 100]) })
    assert.equal(audio.inspect().liveMidiNotes, 1)
    assert.equal(clock.tasks.size, 1)
    await audio.command({ op: 'midiOut', data: new Uint8Array([0xb0, 120, 0]) })
    assert.equal(audio.inspect().liveMidiNotes, 0)
    assert.equal(clock.tasks.size, 0)
  } finally {
    await audio.close()
  }
})

test('a headless decoder finishing after voice close cannot publish PCM or rearm the clock', async () => {
  const clock = new AudioClock(),
    decoded = deferred<PcmAsset>()
  const audio = new HeadlessAudioBackend(
    { now: () => clock.now, schedule: clock.schedule },
    undefined,
    1000,
    () => decoded.promise,
  )
  try {
    const opening = audio.command(open())
    const outcome = assert.rejects(opening, /closed or superseded/)
    assert.equal(audio.inspect().pendingCreates, 1)
    await audio.command({ op: 'close', id: 7 })
    decoded.resolve(pcm())
    await outcome
    assert.equal(audio.inspect().voices, 0)
    assert.equal(audio.inspect().pendingCreates, 0)
    assert.equal(clock.tasks.size, 0)
  } finally {
    decoded.resolve(pcm())
    await audio.close()
  }
})

for (const operation of ['close', 'supersede', 'shutdown'] as const)
  test(`audio port ${operation} prevents an older portable decode from publishing`, async () => {
    const channel = new MessageChannel(),
      decoded = deferred<PcmAsset>()
    const posted: { op: string; sample?: number }[] = []
    let decodes = 0
    channel.port2.onmessage = ({ data }: MessageEvent<AudioRequest>) => {
      const { serial, command } = data
      posted.push({
        op: command.op,
        ...(command.op === 'load' && command.asset.kind === 'pcm'
          ? { sample: command.asset.data[0]![0] }
          : {}),
      })
      channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
    }
    channel.port2.start()
    const audio = new PortAudioBackend(channel.port1, () =>
      ++decodes === 1 ? decoded.promise : Promise.resolve(pcm(0.75)),
    )
    try {
      const opening = audio.command(open())
      const outcome = assert.rejects(opening, /closed|superseded/)
      if (operation === 'shutdown') await audio.close()
      else if (operation === 'close') await audio.command({ op: 'close', id: 7 })
      else await audio.command(open())
      decoded.resolve(pcm(0.25))
      await outcome
      assert.deepEqual(
        posted,
        operation === 'shutdown'
          ? [{ op: 'shutdown' }]
          : operation === 'close'
            ? [{ op: 'close' }]
            : [{ op: 'load', sample: 0.75 }],
      )
    } finally {
      decoded.resolve(pcm())
      await audio.close()
      channel.port2.close()
    }
  })

import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSoundSettings, type MixerCommand } from '../../src/engine/ports/audio.ts'
import type { AudioMessage, MixerRequest } from '../../src/protocol/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { wave } from '../helpers/audio.ts'

test('the real Worklet reports silent output during pause while preserving the mixer playback clock', async () => {
  const messages: AudioMessage[] = []
  interface Processor {
    port: { onmessage: (event: { data: MixerRequest }) => void }
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
  }
  let Registered: new () => Processor
  const names = ['sampleRate', 'AudioWorkletProcessor', 'registerProcessor']
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperties(globalThis, {
    sampleRate: { configurable: true, value: 1000 },
    AudioWorkletProcessor: {
      configurable: true,
      value: class {
        port = { postMessage: (message: AudioMessage) => messages.push(message) }
      },
    },
    registerProcessor: {
      configurable: true,
      value: (name: string, processor: typeof Registered) => {
        assert.equal(name, 'krkr2-mixer')
        Registered = processor
      },
    },
  })
  try {
    await import('../../src/backends/audio/web/mixer.worklet.ts')
    const processor = new Registered!()
    let serial = 0
    const command = (command: MixerCommand) =>
      processor.port.onmessage({ data: { serial: ++serial, command } })
    const left = new Float32Array(128),
      right = new Float32Array(128)
    const render = () => {
      assert.equal(processor.process([], [[left, right]]), true)
    }
    const stats = () => messages.filter((message) => message.type === 'stats')
    command({
      op: 'load',
      id: 1,
      asset: decodeWav(wave(Array(2000).fill(0.5)))!,
      settings: defaultSoundSettings(),
    })
    command({ op: 'play', id: 1 })
    render()
    render()
    assert.equal(stats().at(-1)?.peak, 0.5)
    assert.equal(stats().at(-1)?.frames, 256)
    command({ op: 'pauseAll', paused: true })
    for (let i = 0; i < 4; i++) {
      left.fill(1)
      right.fill(1)
      render()
      assert(left.every((value) => value === 0) && right.every((value) => value === 0))
    }
    assert.equal(stats().length, 3)
    assert.equal(stats().at(-1)?.peak, 0)
    assert.equal(stats().at(-1)?.frames, 256)
    command({ op: 'inspect', id: 1 })
    const inspect = messages.at(-1)!
    assert(inspect.type === 'reply')
    assert.equal(inspect.result?.snapshot?.position, 256)
    command({ op: 'pauseAll', paused: false })
    render()
    render()
    assert.equal(stats().at(-1)?.frames, 512)
    assert.equal(stats().at(-1)?.peak, 0.5)
  } finally {
    for (const [i, name] of names.entries()) {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i]!)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { PortVideoBackend } from '../../src/backends/video/port-backend.ts'
import type { VideoMixingBitmap } from '../../src/engine/ports/video.ts'
import type { VideoRequest } from '../../src/protocol/video.ts'

test(
  'mixing transport transfers private pixels without detaching a caller buffer or subarray',
  {
    timeout: 30000,
  },
  async () => {
    const channel = new MessageChannel(),
      backend = new PortVideoBackend(channel.port1),
      source = new Uint8Array([9, 8, 12, 34, 56, 255, 7, 6]),
      bitmap: VideoMixingBitmap = {
        pixels: { width: 1, height: 1, data: source.subarray(2, 6) },
        destination: { left: 0.25, top: -0.1, right: 0.75, bottom: 0.4 },
        opacity: 0.5,
      },
      received: (VideoMixingBitmap | null)[] = []
    channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
      if (data.command.op === 'mixing') received.push(data.command.bitmap)
      channel.port2.postMessage({ type: 'reply', serial: data.serial, result: { events: [] } })
    }
    try {
      const pending = backend.command({ op: 'mixing', id: 3, epoch: 2, bitmap })
      source.fill(17)
      bitmap.destination.left = 99
      bitmap.opacity = 1
      await pending
      assert.equal(source.byteLength, 8)
      assert.deepEqual([...source], new Array(8).fill(17))
      assert.equal(received.length, 1)
      assert.deepEqual([...received[0]!.pixels.data], [12, 34, 56, 255])
      assert.equal(received[0]!.pixels.data.buffer.byteLength, 4)
      assert.equal(received[0]!.destination.left, 0.25)
      assert.equal(received[0]!.opacity, 0.5)
      await backend.command({ op: 'mixing', id: 3, epoch: 2, bitmap: null })
      assert.equal(received[1], null)
    } finally {
      await backend.close()
      channel.port2.close()
    }
  },
)

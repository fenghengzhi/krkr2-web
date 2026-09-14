import test from 'node:test'
import assert from 'node:assert/strict'
import { PortVideoBackend } from '../../src/backends/video/port-backend.ts'
import {
  defaultVideoSettings,
  type VideoCommand,
  type VideoTimeline,
} from '../../src/engine/ports/video.ts'
import type { VideoRequest } from '../../src/protocol/video.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const timeline = (duration = 100): VideoTimeline => ({
  duration,
  times: [0],
  audioStreams: 0,
  videoStreams: 1,
})
const open = (epoch = 1): Extract<VideoCommand, { op: 'open' }> => ({
  op: 'open',
  id: 7,
  epoch,
  name: 'movie.mp4',
  bytes: new Uint8Array([1, 2, 3]),
  settings: defaultVideoSettings(),
})

for (const operation of ['close', 'supersede', 'cancel', 'shutdown'] as const)
  test(
    `video port ${operation} prevents stale metadata from reopening media`,
    { timeout: 30000 },
    async () => {
      const channel = new MessageChannel(),
        metadata = deferred<VideoTimeline>()
      const posted: { op: string; epoch?: number; duration?: number }[] = []
      let reads = 0
      channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
        const { serial, command } = data
        posted.push({
          op: command.op,
          ...('epoch' in command ? { epoch: command.epoch } : {}),
          ...(command.op === 'open' ? { duration: command.timeline?.duration } : {}),
        })
        channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
      }
      const video = new PortVideoBackend(channel.port1, () =>
        ++reads === 1 ? metadata.promise : Promise.resolve(timeline(200)),
      )
      try {
        const rejected = assert.rejects(video.command(open()), /closed|superseded/)
        if (operation === 'shutdown') await video.close()
        else if (operation === 'close') await video.command({ op: 'close', id: 7, epoch: 2 })
        else if (operation === 'cancel') await video.command({ op: 'cancel' })
        else await video.command(open(2))
        metadata.resolve(timeline())
        await rejected
        assert.deepEqual(
          posted,
          operation === 'shutdown'
            ? [{ op: 'shutdown' }]
            : operation === 'close'
              ? [{ op: 'close', epoch: 2 }]
              : operation === 'cancel'
                ? [{ op: 'cancel' }]
                : [{ op: 'open', epoch: 2, duration: 200 }],
        )
      } finally {
        metadata.resolve(timeline())
        await video.close()
        channel.port2.close()
      }
    },
  )

test(
  'video shutdown starts once and rejects new commands before its reply',
  { timeout: 30000 },
  async () => {
    const channel = new MessageChannel(),
      shutdown = deferred<number>()
    const posted: string[] = []
    channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
      posted.push(data.command.op)
      if (data.command.op === 'shutdown') shutdown.resolve(data.serial)
      else channel.port2.postMessage({ type: 'reply', serial: data.serial, result: { events: [] } })
    }
    const video = new PortVideoBackend(channel.port1)
    const first = video.close(),
      second = video.close()
    try {
      const serial = await shutdown.promise
      await assert.rejects(video.command({ op: 'close', id: 7, epoch: 2 }), /closed/)
      channel.port2.postMessage({ type: 'reply', serial, result: { events: [] } })
      await Promise.all([first, second])
      await video.command({ op: 'shutdown' })
      assert.deepEqual(posted, ['shutdown'])
    } finally {
      channel.port2.close()
      await Promise.allSettled([first, second])
    }
  },
)

test(
  'video metadata and transfer share a private copy of the input resource',
  { timeout: 30000 },
  async () => {
    const channel = new MessageChannel(),
      metadata = deferred<VideoTimeline>()
    const posted: number[][] = []
    let parsed: Uint8Array | undefined
    channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
      if (data.command.op === 'open') posted.push([...data.command.bytes])
      channel.port2.postMessage({ type: 'reply', serial: data.serial, result: { events: [] } })
    }
    const video = new PortVideoBackend(channel.port1, (bytes) => {
      parsed = bytes
      return metadata.promise
    })
    try {
      const command = open(),
        opening = video.command(command)
      command.bytes[0] = 9
      assert.deepEqual([...parsed!], [1, 2, 3])
      metadata.resolve(timeline())
      await opening
      assert.deepEqual(posted, [[1, 2, 3]])
      assert.deepEqual([...command.bytes], [9, 2, 3])
    } finally {
      metadata.resolve(timeline())
      await video.close()
      channel.port2.close()
    }
  },
)

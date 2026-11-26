import { WebVideoHost } from '../../src/backends/video/browser/host.ts'
import type { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import {
  defaultVideoSettings,
  type VideoCommand,
  type VideoResult,
} from '../../src/engine/ports/video.ts'
import type { VideoMessage, VideoRequest } from '../../src/protocol/video.ts'

export type WebVideoLifetimeCase =
  | 'creation-after-audio'
  | 'insertion-after-registration'
  | 'close-first-frame'
  | 'supersede-first-frame'
  | 'shutdown-failure'
  | 'cancel-failure'
  | 'hidden-first-frames'
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
async function until(ready: () => boolean) {
  const end = performance.now() + 10000
  while (!ready()) {
    if (performance.now() >= end)
      throw new Error('Video lifetime fixture did not reach its boundary')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Real DOM and native MP4 decoding; audio close failures are injected at the port boundary. */
export async function exerciseWebVideoLifetime(name: WebVideoLifetimeCase, bytes: Uint8Array) {
  const channel = new MessageChannel(),
    pending = new Map<
      number,
      {
        resolve(result: VideoResult): void
        reject(error: Error): void
      }
    >()
  let serial = 0,
    connected = 0,
    audioCloses = 0,
    observerCloses = 0,
    createdUrls = 0,
    revokedUrls = 0,
    cancelledFrames = 0,
    failAudioClose = false,
    failContainer = false,
    holdFrames = name === 'close-first-frame' || name === 'supersede-first-frame'
  const urls = new Set<string>(),
    audio = new Set<HTMLMediaElement>(),
    frames = new Set<number>(),
    held = new Map<
      number,
      { callback: VideoFrameRequestCallback; now: number; metadata: VideoFrameCallbackMetadata }
    >(),
    messages: string[] = [],
    firstFrames: Array<{ id: string | undefined; paused: boolean; clock: number;
      visibility: string; opacity: string; width: number; height: number }> = []
  const originalCreate = document.createElement,
    originalUrl = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL,
    originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback,
    originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback,
    originalDisconnect = ResizeObserver.prototype.disconnect
  const node = document.createElement('div'),
    canvas = document.createElement('canvas')
  node.append(canvas)
  document.body.append(node)
  URL.createObjectURL = (blob) => {
    const url = originalUrl.call(URL, blob)
    urls.add(url)
    createdUrls++
    return url
  }
  URL.revokeObjectURL = (url) => {
    if (urls.delete(url)) revokedUrls++
    originalRevoke.call(URL, url)
  }
  ResizeObserver.prototype.disconnect = function () {
    observerCloses++
    originalDisconnect.call(this)
  }
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const id = originalRequest.call(this, (now, metadata) => {
      const surface = this.closest<HTMLElement>('.video-presentation-surface')
      if (surface) {
        const rect = this.getBoundingClientRect()
        firstFrames.push({ id: this.dataset.videoId, paused: this.paused, clock: this.currentTime,
          visibility: getComputedStyle(this).visibility, opacity: getComputedStyle(surface).opacity,
          width: rect.width, height: rect.height })
      }
      if (holdFrames) held.set(id, { callback, now, metadata })
      else {
        frames.delete(id)
        callback(now, metadata)
      }
    })
    frames.add(id)
    return id
  }
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    if (frames.delete(id)) cancelledFrames++
    held.delete(id)
    originalCancel.call(this, id)
  }
  const output = {
    activate() {},
    connectMedia(element: HTMLMediaElement) {
      audio.add(element)
      connected++
      return {
        set() {},
        close() {
          check(audio.delete(element), 'Audio connection closed twice')
          audioCloses++
          if (failAudioClose) {
            failAudioClose = false
            throw new Error('video-audio-close')
          }
        },
      }
    },
  } as unknown as WebAudioHost
  let host: WebVideoHost | undefined
  let cancelledResources:
    { audio: number; urls: number; frames: number; videos: number; error: string } | undefined
  const send = (command: VideoCommand) =>
    new Promise<VideoResult>((resolve, reject) => {
      const id = ++serial
      pending.set(id, { resolve, reject })
      channel.port2.postMessage({ serial: id, command } satisfies VideoRequest)
    })
  channel.port2.onmessage = ({ data }: MessageEvent<VideoMessage>) => {
    if (data.type === 'reply') {
      const job = pending.get(data.serial)
      if (!job) return
      pending.delete(data.serial)
      data.error ? job.reject(new Error(data.error)) : job.resolve(data.result ?? { events: [] })
    } else if (data.type === 'event') {
      if (data.event.type === 'error') messages.push(data.event.message)
      channel.port2.postMessage({ type: 'ack', serial: data.serial } satisfies VideoMessage)
    }
  }
  const open = (id = 7, epoch = 1, settings = defaultVideoSettings()) =>
    send({
      op: 'open',
      id,
      epoch,
      name: 'colors.mp4',
      bytes,
      settings,
    })
  const rejected = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('Expected video operation to reject')
      },
      (error) => String(error),
    )
  try {
    host = new WebVideoHost(channel.port1, canvas, output)
    if (name === 'creation-after-audio') {
      failContainer = true
      failAudioClose = true
      document.createElement = function (...args: Parameters<Document['createElement']>) {
        if (failContainer && args[0] === 'div' && audio.size) {
          failContainer = false
          throw new Error('video-container-primary')
        }
        return originalCreate.apply(document, args)
      } as Document['createElement']
      check(
        (await rejected(open())).includes('video-container-primary'),
        'Cleanup replaced creation error',
      )
    } else if (name === 'insertion-after-registration') {
      failAudioClose = true
      const plane = node.querySelector('.video-plane')!
      plane.insertBefore = (() => {
        throw new Error('video-insert-primary')
      }) as typeof plane.insertBefore
      check(
        (await rejected(open())).includes('video-insert-primary'),
        'Cleanup replaced insertion error',
      )
    } else if (name === 'hidden-first-frames') {
      const results = [await open(7), await open(8, 1, { ...defaultVideoSettings(), mode: 1 })]
      check(results.every((result) => result.snapshot?.status === 'stop' && result.snapshot.position === 0),
        'First-frame loading changed a paused movie clock or status')
      check(firstFrames.length === 2 && firstFrames.every((frame) => frame.paused && frame.clock === 0 &&
        frame.visibility === 'visible' && frame.opacity === '0' && frame.width > 0 && frame.height > 0),
      'A hidden decoder had no connected presentation surface at its real first callback')
      check(!document.querySelector('.video-presentation-surface'), 'First-frame surfaces survived completion')
      const images = [...node.querySelectorAll('video')].map((video) => {
        check(video.paused && video.currentTime === 0 && getComputedStyle(video).visibility === 'hidden',
          'Completed hidden movies were played, seeked or exposed')
        check(video.videoWidth === 64 && video.videoHeight === 48, 'Wrong decoded dimensions')
        const context = new OffscreenCanvas(64, 48).getContext('2d', { willReadFrequently: true })!
        context.drawImage(video, 0, 0)
        return context.getImageData(0, 0, 64, 48).data
      })
      check(images.length === 2 && images[0]!.every((value, at) => value === images[1]![at]),
        'Sequential hidden decoders did not retain the same complete first image')
      for (let at = 0; at < images[0]!.length; at += 4)
        check(images[0]![at]! > 240 && images[0]![at + 1]! < 15 && images[0]![at + 2]! < 15 && images[0]![at + 3] === 255,
          'The authored red first frame was not decoded')
    } else if (name === 'close-first-frame') {
      const opening = rejected(open())
      await until(() => held.size === 1)
      const late = held.values().next().value!
      await send({ op: 'close', id: 7, epoch: 2 })
      check((await opening).includes('cancelled'), 'Pending open survived close')
      check(cancelledFrames === 1, 'Held first frame was not cancelled')
      check(!document.querySelector('.video-presentation-surface'), 'Close retained the first-frame surface')
      late.callback(late.now, late.metadata)
      check(!node.querySelector('video') && !document.querySelector('.video-presentation-surface'),
        'A late real callback restored retired video DOM')
    } else if (name === 'supersede-first-frame') {
      const older = rejected(open())
      await until(() => held.size === 1)
      const newer = open(7, 2)
      check((await older).includes('cancelled'), 'Superseded open did not reject')
      await until(() => held.size === 1 && createdUrls === 2)
      holdFrames = false
      for (const [id, frame] of held) {
        held.delete(id)
        frames.delete(id)
        frame.callback(frame.now, frame.metadata)
      }
      const result = await newer
      check(result.snapshot?.epoch === 2, 'Old open replaced the new resource')
      check(
        audio.size === 1 && urls.size === 1 && node.querySelectorAll('video').length === 1,
        'Replacement did not retain exactly one resource',
      )
    } else if (name === 'cancel-failure') {
      await open(7)
      await open(8)
      failAudioClose = true
      const error = await rejected(send({ op: 'cancel' }))
      check(error.includes('video-audio-close'), 'Cancellation lost its first error')
      cancelledResources = {
        audio: audio.size,
        urls: urls.size,
        frames: frames.size,
        videos: node.querySelectorAll('video').length,
        error,
      }
      check(
        !audio.size && !urls.size && !frames.size && !node.querySelector('video'),
        'Cancellation skipped later movies after a close failure',
      )
      check(observerCloses === 0, 'Cancellation prematurely shut down the video host')
      await send({ op: 'cancel' })
    } else {
      await open(7)
      await open(8)
      failAudioClose = true
      const first = host.close(),
        second = host.close()
      check(first === second, 'Shutdown did not share its outcome')
      check((await rejected(first)).includes('video-audio-close'), 'Shutdown lost its first error')
      check(
        (await rejected(second)).includes('video-audio-close'),
        'Repeated shutdown hid its error',
      )
    }
    await host.close().catch((error) => {
      if (name !== 'shutdown-failure') throw error
    })
    check(
      !audio.size && !urls.size && !frames.size && !held.size,
      'Video resources survived cleanup',
    )
    check(
      !node.querySelector('video') && !node.querySelector('.video-plane') &&
        !document.querySelector('.video-presentation-surface'),
      'Video DOM survived cleanup',
    )
    check(observerCloses === 1, 'Video observer did not disconnect once')
    check(!pending.size && !messages.length, 'Unexpected pending replies or asynchronous errors')
    return {
      name,
      connected,
      audioCloses,
      createdUrls,
      revokedUrls,
      cancelledFrames,
      observerCloses,
      pendingReplies: pending.size,
      liveAudio: audio.size,
      liveUrls: urls.size,
      pendingFrames: frames.size,
      videos: node.querySelectorAll('video').length,
      messages,
      cancelledResources,
      firstFrames,
    }
  } finally {
    failContainer = false
    failAudioClose = false
    await host?.close().catch(() => {})
    document.createElement = originalCreate
    URL.createObjectURL = originalUrl
    URL.revokeObjectURL = originalRevoke
    HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest
    HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel
    ResizeObserver.prototype.disconnect = originalDisconnect
    channel.port1.close()
    channel.port2.close()
    node.remove()
  }
}

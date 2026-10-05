import { WebVideoHost } from '../../src/backends/video/browser/host.ts'
import type { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'
import { defaultVideoSettings, type VideoCommand, type VideoResult } from '../../src/engine/ports/video.ts'
import type { VideoMessage, VideoRequest } from '../../src/protocol/video.ts'

export type VideoAudioLifetimeCase = 'url-failure' | 'audio-failure' | 'frame-failure' |
  'close-candidate' | 'cancel-candidate' | 'window-candidate' | 'supersede-candidate' |
  'old-graph-cleanup' | 'opening-newer-command' | 'image-mismatch'
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(ready: () => boolean): Promise<void> {
  const end = performance.now() + 12000
  while (!ready()) {
    if (performance.now() >= end) throw new Error('Video audio lifetime observation timed out')
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}
const pixels = (video: HTMLVideoElement) => {
  const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d')!
  context.drawImage(video, 0, 0, 1, 1)
  return [...context.getImageData(0, 0, 1, 1).data].join(',')
}
interface FrameToken { element: HTMLVideoElement; id: number }

/** Real selected MP4 bytes and native decoding/clock. Acquisition and delivery
 * faults are injected; image-mismatch additionally corrupts one readback byte
 * in the last pixel, leaving the first-pixel legacy observation unchanged. */
export async function exerciseVideoAudioLifetime(name: VideoAudioLifetimeCase, bytes: Uint8Array) {
  const timeline = await readVideoTimeline(bytes)
  check(timeline?.audioStreams === 2, 'The lifetime fixture needs two actual MP4 audio tracks')
  const channel = new MessageChannel(), node = document.createElement('div'), canvas = document.createElement('canvas'),
    graphs = new Set<HTMLMediaElement>(), urls = new Set<string>(), frames = new Set<FrameToken>(),
    held = new Map<FrameToken, { callback: VideoFrameRequestCallback; now: number; metadata: VideoFrameCallbackMetadata }>(),
    pending = new Map<number, { resolve(value: VideoResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>(),
    errors: string[] = []
  canvas.width = 96; canvas.height = 64
  node.append(canvas); document.body.append(node)
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL,
    requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback,
    cancelFrame = HTMLVideoElement.prototype.cancelVideoFrameCallback,
    contextPrototype = Object.getPrototypeOf(new OffscreenCanvas(1, 1).getContext('2d')!) as OffscreenCanvasRenderingContext2D,
    drawImage = contextPrototype.drawImage, getImageData = contextPrototype.getImageData,
    imageSources = new WeakMap<OffscreenCanvasRenderingContext2D, HTMLVideoElement>()
  let createdUrls = 0, revokedUrls = 0, connected = 0, closed = 0, serial = 0,
    failUrl = false, failAudio = false, failFrame = false, failOldClose = false, hold = false, holdInitial = false,
    corruptImage = false, corruptedReadbacks = 0
  contextPrototype.drawImage = function (image: CanvasImageSource, ...coordinates: number[]) {
    if (image instanceof HTMLVideoElement) imageSources.set(this, image)
    else imageSources.delete(this)
    Reflect.apply(drawImage, this, [image, ...coordinates])
  }
  contextPrototype.getImageData = function (sx, sy, sw, sh, settings) {
    const result = getImageData.call(this, sx, sy, sw, sh, settings), source = imageSources.get(this)
    if (corruptImage && source && !source.dataset.videoId && result.data.length > 4) {
      const at = result.data.length - 4
      result.data[at] = result.data[at]! ^ 1
      corruptedReadbacks++
    }
    return result
  }
  URL.createObjectURL = (blob) => {
    if (failUrl) { failUrl = false; throw new Error('candidate-url-failure') }
    const url = createUrl.call(URL, blob)
    urls.add(url); createdUrls++
    return url
  }
  URL.revokeObjectURL = (url) => {
    if (urls.delete(url)) revokedUrls++
    revokeUrl.call(URL, url)
  }
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const candidate = !this.dataset.videoId
    if (candidate && failFrame) { failFrame = false; throw new Error('candidate-frame-failure') }
    const token: FrameToken = { element: this, id: 0 }
    const id = requestFrame.call(this, (now, metadata) => {
      if ((candidate || holdInitial) && hold) held.set(token, { callback, now, metadata })
      else { frames.delete(token); callback(now, metadata) }
    })
    token.id = id
    frames.add(token)
    return id
  }
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    for (const token of frames) if (token.element === this && token.id === id) {
      frames.delete(token); held.delete(token)
    }
    cancelFrame.call(this, id)
  }
  const output = { activate() {}, connectMedia(element: HTMLMediaElement) {
    if (failAudio) { failAudio = false; throw new Error('candidate-audio-failure') }
    // This ownership adapter has no real audio destination; silence the native
    // fallback output while retaining its actual video decoder and media clock.
    element.muted = true
    graphs.add(element); connected++
    return { set() {}, close() {
      check(graphs.delete(element), 'A media graph was closed twice')
      closed++
      if (failOldClose) { failOldClose = false; throw new Error('old-video-audio-close') }
    } }
  } } as unknown as WebAudioHost
  const host = new WebVideoHost(channel.port1, canvas, output)
  const send = (command: VideoCommand) => new Promise<VideoResult>((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`Video lifetime ${command.op} reply timed out`))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    channel.port2.postMessage({ serial: id, command } satisfies VideoRequest)
  })
  channel.port2.onmessage = ({ data }: MessageEvent<VideoMessage>) => {
    if (data.type === 'reply') {
      const job = pending.get(data.serial)
      if (!job) return
      pending.delete(data.serial); clearTimeout(job.timer)
      data.error ? job.reject(new Error(data.error)) : job.resolve(data.result ?? { events: [] })
    } else if (data.type === 'event') {
      if (data.event.type === 'error') errors.push(data.event.message)
      channel.port2.postMessage({ type: 'ack', serial: data.serial } satisfies VideoMessage)
    }
  }
  const settings = { ...defaultVideoSettings(), mode: 2 as const, visible: true, width: 64, height: 48 },
    select = (index: number, epoch: number) => send({ op: 'set', id: 7, epoch,
      settings: { ...settings, enabledAudioStream: index } }),
    rejected = (work: Promise<unknown>) => work.then(() => { throw new Error('Candidate unexpectedly succeeded') }, (error) => String(error))
  let rollbackPreserved = false, mixingPreserved = false, lateDeliverySafe = false, oldCleanupRecovered = false
  try {
    if (name === 'opening-newer-command') {
      hold = true; holdInitial = true
      const opening = send({ op: 'open', id: 7, epoch: 1, bytes, name: 'tracks.mp4', settings, timeline })
      await until(() => held.size === 1)
      for (const command of [
        { op: 'set', id: 7, epoch: 2, settings: { ...settings, left: 11 } },
        { op: 'seek', id: 7, epoch: 2, position: 500 },
        { op: 'pause', id: 7, epoch: 2 },
      ] satisfies VideoCommand[]) {
        check((await rejected(send(command))).includes('still opening'), 'A newer command silently mutated an unfinished open')
      }
      hold = false; holdInitial = false
      for (const [id, frame] of held) {
        held.delete(id); frames.delete(id); frame.callback(frame.now, frame.metadata)
      }
      const result = await opening
      rollbackPreserved = result.snapshot?.epoch === 1 && result.snapshot.left === settings.left && result.snapshot.status === 'stop'
      check(rollbackPreserved, 'The initial open was overwritten by a command that should have been rejected')
    } else {
    await send({ op: 'open', id: 7, epoch: 1, bytes, name: 'tracks.mp4', settings, timeline })
    await send({ op: 'seek', id: 7, epoch: 1, position: 500 })
    await send({ op: 'pause', id: 7, epoch: 1 })
    await send({ op: 'mixing', id: 7, epoch: 1, bitmap: {
      pixels: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
      destination: { left: 0, top: 0, right: 0.1, bottom: 0.1 }, opacity: 0.25,
    } })
    const original = node.querySelector<HTMLVideoElement>('video[data-video-id]')!, before = pixels(original),
      position = original.currentTime, mixing = node.querySelector('.video-mixing-bitmap')
    check(graphs.size === 1 && urls.size === 1, 'Initial selected video did not acquire exactly one graph/URL')
    if (name === 'old-graph-cleanup') {
      await send({ op: 'play', id: 7, epoch: 1 })
      await until(() => !original.paused)
      const start = original.currentTime
      failOldClose = true
      check((await rejected(select(1, 2))).includes('old-video-audio-close'), 'Retirement lost the old graph cleanup error')
      const current = node.querySelector<HTMLVideoElement>('video[data-video-id]')!
      await until(() => !current.paused && current.currentTime > start + 0.01)
      const result = await send({ op: 'inspect', id: 7, epoch: 2 })
      oldCleanupRecovered = current !== original && result.snapshot?.enabledAudioStream === 1 &&
        result.snapshot.status === 'play' && graphs.size === 1 && urls.size === 1
      mixingPreserved = node.querySelector('.video-mixing-bitmap') === mixing
      check(oldCleanupRecovered && mixingPreserved, 'Committed selection reported play but left its real media clock paused')
    } else if (name.endsWith('failure') || name === 'image-mismatch') {
      failUrl = name === 'url-failure'; failAudio = name === 'audio-failure'; failFrame = name === 'frame-failure'
      corruptImage = name === 'image-mismatch'
      const error = await rejected(select(1, 2))
      corruptImage = false
      check(error.includes(name === 'image-mismatch' ? 'complete presented image' : `candidate-${name.split('-')[0]}-failure`),
        `Selection lost its candidate error: ${error}`)
      if (name === 'image-mismatch') check(corruptedReadbacks > 0, 'The candidate never reached full-image validation')
      const current = node.querySelector<HTMLVideoElement>('video[data-video-id]')!, result = await send({ op: 'inspect', id: 7, epoch: 2 })
      rollbackPreserved = current === original && current.paused && Math.abs(current.currentTime - position) <= 0.001 &&
        pixels(current) === before && result.snapshot?.enabledAudioStream === 0 && graphs.size === 1 && urls.size === 1
      check(rollbackPreserved, 'A rejected candidate changed the old media clock, image, graph or selection')
      await select(1, 3)
      mixingPreserved = node.querySelector('.video-mixing-bitmap') === mixing
      check(mixingPreserved, 'Successful retry replaced or discarded the independent mixing bitmap')
      check(graphs.size === 1 && urls.size === 1 && node.querySelectorAll('video[data-video-id]').length === 1,
        'Successful retry retained a retired graph, Blob or selected media element')
    } else {
      hold = true
      const selecting = rejected(select(1, 2))
      await until(() => held.size === 1)
      const late = [...held.values()]
      if (name === 'close-candidate') await send({ op: 'close', id: 7, epoch: 3 })
      else if (name === 'cancel-candidate') await send({ op: 'cancel' })
      else if (name === 'window-candidate') host.removeWindow(0)
      else await select(0, 3)
      check((await selecting).includes('cancel'), 'Candidate presentation survived retirement')
      hold = false
      if (name === 'supersede-candidate') {
        await select(1, 4)
        mixingPreserved = node.querySelector('.video-mixing-bitmap') === mixing
        check(mixingPreserved, 'Superseding a candidate lost the mixing bitmap')
      }
      const active = node.querySelector('video[data-video-id]')
      for (const frame of late) frame.callback(frame.now, frame.metadata)
      await Promise.resolve()
      lateDeliverySafe = node.querySelector('video[data-video-id]') === active && !held.size && !frames.size &&
        graphs.size === (name === 'supersede-candidate' ? 1 : 0) && urls.size === graphs.size
      check(lateDeliverySafe, 'A late real presentation callback revived a retired candidate')
    }
    }
    await host.close()
    check(!graphs.size && !urls.size && !frames.size && !node.querySelector('video') && !document.querySelector('.video-parking'),
      'Video track resources survived shutdown')
    check(!pending.size && !errors.length, 'Unexpected host replies or asynchronous playback errors')
    return { connected, closed, createdUrls, revokedUrls, liveGraphs: graphs.size, liveUrls: urls.size,
      pendingFrames: frames.size, pendingReplies: pending.size, videos: node.querySelectorAll('video').length,
      rollbackPreserved, mixingPreserved, lateDeliverySafe, oldCleanupRecovered, corruptedReadbacks, errors }
  } finally {
    hold = false
    try { await host.close() }
    finally {
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Video lifetime fixture closed')) }
      pending.clear(); channel.port1.close(); channel.port2.close(); node.remove()
      URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl
      HTMLVideoElement.prototype.requestVideoFrameCallback = requestFrame
      HTMLVideoElement.prototype.cancelVideoFrameCallback = cancelFrame
      contextPrototype.drawImage = drawImage
      contextPrototype.getImageData = getImageData
    }
  }
}

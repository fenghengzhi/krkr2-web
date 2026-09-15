import { WebVideoHost } from '../../src/backends/video/browser/host.ts'
import type { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import {
  defaultVideoSettings,
  type VideoCommand,
  type VideoResult,
  type VideoSettings,
} from '../../src/engine/ports/video.ts'
import { WindowState, type WindowView } from '../../src/engine/scene/window.ts'
import type { VideoMessage, VideoRequest } from '../../src/protocol/video.ts'

export type WebVideoWindowsCase =
  | 'geometry-and-visibility'
  | 'close-isolation'
  | 'late-attachment'
  | 'detach-and-reattach'
  | 'stale-surfaces'
  | 'remove-during-first-frame'
  | 'remove-during-seek'

function check(value: unknown, message: string): void {
  if (!value) throw new Error(message)
}
async function until(ready: () => boolean) {
  const end = performance.now() + 10000
  while (!ready()) {
    if (performance.now() >= end) throw new Error('Video window fixture boundary timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('Expected video operation to reject')
    },
    (error) => String(error),
  )

/** Native MP4 decoding and real DOM surfaces; audio ownership is observed at its port. */
export async function exerciseWebVideoWindows(name: WebVideoWindowsCase, bytes: Uint8Array) {
  const channel = new MessageChannel(),
    pending = new Map<number, { resolve(value: VideoResult): void; reject(error: Error): void }>(),
    root = document.createElement('div'),
    videos = new Map<number, HTMLVideoElement>(),
    audio = new Set<number>(),
    closedAudio: number[] = [],
    urls = new Set<string>(),
    messages: string[] = [],
    evidence: Record<string, unknown> = {},
    held = new Map<
      HTMLVideoElement,
      {
        id: number
        callback: VideoFrameRequestCallback
        now: number
        metadata: VideoFrameCallbackMetadata
      }
    >()
  let serial = 0,
    createdUrls = 0,
    revokedUrls = 0,
    observerCloses = 0,
    cancelledHeldFrames = 0,
    failAudioId: number | undefined,
    holdVideoId: number | undefined
  root.style.cssText = 'position:relative;width:1000px;height:700px'
  document.body.append(root)
  const makeCanvas = (left: number, top: number, width: number, height: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px`
    root.append(canvas)
    return canvas
  }
  const firstCanvas = makeCanvas(17, 23, 320, 180),
    secondCanvas = makeCanvas(430, 270, 200, 100),
    firstView: WindowView = {
      ...new WindowState().view(),
      visible: true,
      width: 640,
      height: 360,
      layerLeft: 8,
      layerTop: 6,
    },
    secondView: WindowView = {
      ...new WindowState().view(),
      visible: true,
      width: 400,
      height: 200,
      layerLeft: 10,
      layerTop: 4,
      zoomNumer: 2,
    },
    settings: VideoSettings = {
      ...defaultVideoSettings(),
      visible: true,
      left: 20,
      top: 12,
      width: 100,
      height: 60,
    },
    originalCreateUrl = URL.createObjectURL,
    originalRevokeUrl = URL.revokeObjectURL,
    originalDisconnect = ResizeObserver.prototype.disconnect,
    originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback,
    originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback
  URL.createObjectURL = (blob) => {
    const url = originalCreateUrl.call(URL, blob)
    urls.add(url)
    createdUrls++
    return url
  }
  URL.revokeObjectURL = (url) => {
    if (urls.delete(url)) revokedUrls++
    originalRevokeUrl.call(URL, url)
  }
  ResizeObserver.prototype.disconnect = function () {
    observerCloses++
    originalDisconnect.call(this)
  }
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const element = this
    const id = originalRequest.call(element, (now, metadata) => {
      if (Number(element.dataset.videoId) === holdVideoId)
        held.set(element, { id, callback, now, metadata })
      else callback(now, metadata)
    })
    return id
  }
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    if (held.get(this)?.id === id) {
      held.delete(this)
      cancelledHeldFrames++
    }
    originalCancel.call(this, id)
  }
  const output = {
    activate() {},
    connectMedia(element: HTMLVideoElement) {
      const id = Number(element.dataset.videoId)
      check(!audio.has(id), 'Video acquired a second live audio connection')
      videos.set(id, element)
      audio.add(id)
      return {
        set() {},
        close() {
          check(audio.delete(id), `Video ${id} closed its audio twice`)
          closedAudio.push(id)
          if (failAudioId === id) {
            failAudioId = undefined
            throw new Error('window-video-audio-close')
          }
        },
      }
    },
  } as unknown as WebAudioHost
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
  const open = (id: number, windowId: number) =>
      send({ op: 'open', id, windowId, epoch: 1, name: 'colors.mp4', bytes, settings }),
    inspect = (id: number) => send({ op: 'inspect', id, epoch: 1 }),
    video = (id: number) => {
      const element = videos.get(id)
      if (!element) throw new Error(`Video ${id} was not created`)
      return element
    },
    plane = (id: number) => {
      const element = video(id).closest<HTMLDivElement>('.video-plane')
      if (!element) throw new Error(`Video ${id} is missing its window plane`)
      return element
    },
    geometry = (id: number) => {
      const container = video(id).parentElement!
      return ['left', 'top', 'width', 'height'].map((key) =>
        parseFloat(container.style[key as 'left']),
      )
    },
    sameGeometry = (id: number, expected: number[]) =>
      check(
        geometry(id).every((value, index) => Math.abs(value - expected[index]!) < 0.0001),
        `Unexpected movie ${id} geometry: ${geometry(id)}; expected ${expected}`,
      )
  let host: WebVideoHost | undefined
  try {
    host = new WebVideoHost(channel.port1, output)
    host.setWindow(firstView, 11)
    host.setWindow(secondView, 22)
    if (name !== 'late-attachment') host.attachWindow(11, 1, firstCanvas)
    if (
      name === 'geometry-and-visibility' ||
      name === 'close-isolation' ||
      name === 'remove-during-first-frame' ||
      name === 'remove-during-seek'
    )
      host.attachWindow(22, 1, secondCanvas)

    if (name === 'geometry-and-visibility') {
      await open(101, 11)
      await open(201, 22)
      check(plane(101) !== plane(201), 'Two windows shared a video plane')
      sameGeometry(101, [14, 9, 50, 30])
      sameGeometry(201, [25, 14, 100, 60])
      check(
        plane(101).style.left === '17px' &&
          plane(101).style.top === '23px' &&
          plane(201).style.left === '430px' &&
          plane(201).style.top === '270px',
        'Video planes did not follow their own canvas positions',
      )
      host.setWindow({ ...firstView, visible: false, layerLeft: 28 }, 11)
      sameGeometry(101, [24, 9, 50, 30])
      sameGeometry(201, [25, 14, 100, 60])
      check(
        getComputedStyle(video(101)).visibility === 'hidden',
        'Hidden Window still displayed its movie',
      )
      check(
        getComputedStyle(video(201)).visibility === 'visible',
        'Hiding one Window hid another movie',
      )
      host.setWindow(firstView, 11)
      await send({ op: 'set', id: 201, epoch: 1, settings: { ...settings, visible: false } })
      check(
        getComputedStyle(video(101)).visibility === 'visible',
        'Window visibility did not restore its movie',
      )
      check(
        getComputedStyle(video(201)).visibility === 'hidden',
        'Movie visibility ignored its own setting',
      )
      evidence.geometry = { first: geometry(101), second: geometry(201) }
    } else if (name === 'close-isolation') {
      await open(101, 11)
      await open(102, 11)
      await open(201, 22)
      const survivingVideo = video(201),
        survivingPlane = plane(201)
      await send({ op: 'seek', id: 201, epoch: 1, position: 750 })
      failAudioId = 101
      let error = ''
      try {
        host.removeWindow(11)
      } catch (caught) {
        error = String(caught)
      }
      check(
        error.includes('window-video-audio-close'),
        'Window cleanup lost its first audio failure',
      )
      check(
        closedAudio.includes(101) && closedAudio.includes(102),
        'Window cleanup skipped a later movie',
      )
      check(audio.size === 1 && audio.has(201), 'Window cleanup closed another Window audio')
      check(!video(101).isConnected && !video(102).isConnected, 'Closed Window retained movie DOM')
      check(
        video(201) === survivingVideo && plane(201) === survivingPlane,
        'Window cleanup replaced another surface',
      )
      const survivor = (await inspect(201)).snapshot!
      check(
        survivor.position === 750 && survivor.originalWidth === 64,
        'Surviving movie lost its decoded state',
      )
      await rejected(open(103, 11))
      host.attachWindow(11, 2, firstCanvas)
      check(root.querySelectorAll('.video-plane').length === 1, 'Closed Window was reattached')
      check(!videos.has(103) && audio.size === 1, 'Closed Window opened a late movie')
      evidence.survivor = survivor
      evidence.closeError = error
    } else if (name === 'late-attachment') {
      const opened = await open(101, 11),
        element = video(101)
      check(
        opened.snapshot?.originalWidth === 64,
        'Unattached movie did not decode its first frame',
      )
      check(audio.size === 1 && createdUrls === 1, 'Unattached movie did not own its resources')
      host.attachWindow(11, 1, firstCanvas)
      check(
        video(101) === element && element.isConnected,
        'Attachment failed to mount the existing video',
      )
      sameGeometry(101, [14, 9, 50, 30])
      check(
        audio.size === 1 && createdUrls === 1 && !closedAudio.length,
        'Attachment recreated a movie resource',
      )
      evidence.opened = opened.snapshot
    } else if (name === 'detach-and-reattach') {
      await open(101, 11)
      const element = video(101),
        source = element.src
      await send({ op: 'seek', id: 101, epoch: 1, position: 750 })
      await send({ op: 'pause', id: 101, epoch: 1 })
      const before = (await inspect(101)).snapshot!
      host.detachWindow(11, 1)
      check(root.querySelectorAll('.video-plane').length === 0, 'Detach retained its visible plane')
      check(observerCloses === 1, 'Detach retained its canvas observer')
      const detached = (await inspect(101)).snapshot!
      check(
        detached.position === before.position && detached.status === 'pause',
        'Detach reset paused playback',
      )
      host.attachWindow(11, 2, secondCanvas)
      check(video(101) === element && element.src === source, 'Reattach replaced the decoded video')
      check(element.currentTime === 0.75 && element.paused, 'Reattach changed native paused state')
      sameGeometry(101, [8.75, 5, 31.25, 16.666666666666668])
      // Isolate autoplay permission from the host's logical play state and lifecycle calls.
      let plays = 0,
        pauses = 0
      const nativePlay = element.play,
        nativePause = element.pause
      element.play = () => {
        plays++
        return Promise.resolve()
      }
      element.pause = () => {
        pauses++
        nativePause.call(element)
      }
      try {
        await send({ op: 'play', id: 101, epoch: 1 })
        host.detachWindow(11, 2)
        host.attachWindow(11, 3, firstCanvas)
        const restored = (await inspect(101)).snapshot!
        check(
          restored.status === 'play' && restored.position === 750,
          'Surface replacement reset logical playback',
        )
        check(plays === 1 && pauses === 0, 'Surface replacement restarted or paused the movie')
        check(
          audio.size === 1 && createdUrls === 1 && !closedAudio.length,
          'Surface replacement recreated media ownership',
        )
        evidence.restored = restored
        evidence.nativeCalls = { plays, pauses }
      } finally {
        element.play = nativePlay
        element.pause = nativePause
      }
    } else if (name === 'stale-surfaces') {
      await open(101, 11)
      const firstPlane = plane(101)
      host.detachWindow(11, 0)
      host.attachWindow(11, 0, secondCanvas)
      host.attachWindow(11, 1, secondCanvas)
      check(
        plane(101) === firstPlane && firstPlane.style.left === '17px',
        'Stale or duplicate attachment replaced the live surface',
      )
      host.detachWindow(11, 1)
      host.attachWindow(11, 1, secondCanvas)
      check(!root.querySelector('.video-plane'), 'Retired epoch reattached a surface')
      host.attachWindow(11, 2, secondCanvas)
      const replacement = plane(101)
      host.detachWindow(11, 1)
      check(
        plane(101) === replacement && replacement.style.left === '430px',
        'Stale detach removed its replacement',
      )
      host.removeWindow(11)
      host.attachWindow(11, 3, firstCanvas)
      check(
        !root.querySelector('.video-plane') && audio.size === 0,
        'Terminal Window was resurrected',
      )
      await rejected(open(102, 11))
      check(!videos.has(102), 'Terminal Window accepted a later open')
      evidence.observersBeforeShutdown = observerCloses
    } else if (name === 'remove-during-seek') {
      await open(101, 11)
      await open(201, 22)
      const element = video(101)
      let seekCompleted = false
      const holdSeek = (event: Event) => {
        seekCompleted = true
        event.stopImmediatePropagation()
      }
      element.addEventListener('seeked', holdSeek, { capture: true })
      try {
        const seeking = rejected(send({ op: 'seek', id: 101, epoch: 1, position: 750 }))
        await until(() => seekCompleted)
        host.removeWindow(11)
        const error = await seeking
        check(error.includes('cancelled'), 'Window removal did not cancel its pending seek')
        element.removeEventListener('seeked', holdSeek, { capture: true })
        element.dispatchEvent(new Event('seeked'))
        check(
          !element.isConnected && audio.size === 1 && audio.has(201),
          'Late seek completion resurrected removed media',
        )
        check(
          (await inspect(201)).snapshot?.originalWidth === 64,
          'Cancelled seek broke another Window movie',
        )
        evidence.seekError = error
      } finally {
        element.removeEventListener('seeked', holdSeek, { capture: true })
      }
    } else {
      await open(201, 22)
      holdVideoId = 101
      const opening = rejected(open(101, 11))
      await until(() => held.has(videos.get(101)!))
      const element = video(101),
        stale = held.get(element)!
      host.removeWindow(11)
      const error = await opening
      check(error.includes('cancelled'), 'Removing Window did not cancel its pending first frame')
      check(
        cancelledHeldFrames === 1 && !held.size,
        'Removing Window retained a pending frame callback',
      )
      stale.callback(stale.now, stale.metadata)
      host.attachWindow(11, 2, firstCanvas)
      check(
        !element.isConnected && audio.size === 1 && audio.has(201),
        'Late frame resurrected removed Window media',
      )
      check(
        (await inspect(201)).snapshot?.originalWidth === 64,
        'Removing pending open broke another Window movie',
      )
      evidence.openError = error
    }
    await host.close()
    check(!audio.size && !urls.size && !held.size, 'Video window resources survived shutdown')
    check(
      !root.querySelector('video') &&
        !root.querySelector('.video-plane') &&
        !document.querySelector('.video-parking'),
      'Video window DOM survived shutdown',
    )
    check(!pending.size && !messages.length, 'Unexpected pending replies or media errors')
    return {
      name,
      createdUrls,
      revokedUrls,
      createdVideos: videos.size,
      closedAudio,
      observerCloses,
      cancelledHeldFrames,
      pendingReplies: pending.size,
      liveAudio: audio.size,
      liveUrls: urls.size,
      pendingFrames: held.size,
      messages,
      evidence,
    }
  } finally {
    failAudioId = undefined
    holdVideoId = undefined
    await host?.close().catch(() => {})
    URL.createObjectURL = originalCreateUrl
    URL.revokeObjectURL = originalRevokeUrl
    ResizeObserver.prototype.disconnect = originalDisconnect
    HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest
    HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel
    channel.port1.close()
    channel.port2.close()
    root.remove()
  }
}

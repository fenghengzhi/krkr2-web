import { WebVideoHost } from '../../src/backends/video/browser/host.ts'
import {
  createVideoMixingSurface,
  releaseVideoMixingSurface,
} from '../../src/backends/video/browser/mixing-bitmap.ts'
import type { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import {
  defaultVideoSettings,
  type VideoCommand,
  type VideoMixingBitmap,
  type VideoMode,
  type VideoResult,
} from '../../src/engine/ports/video.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { VideoMessage, VideoRequest } from '../../src/protocol/video.ts'

export type WebVideoMixingCase =
  | 'replacement'
  | 'budget'
  | 'surface-and-epoch'
  | 'non-mixer'
  | 'close-failure'
  | 'cancel-failure'
  | 'retire-failure'
  | 'shutdown-failure'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('Expected mixing operation to reject')
    },
    (error) => String(error),
  )
const bitmap = (width = 2, height = 1, color = 0xff0000): VideoMixingBitmap => {
  const data = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = (color >>> 16) & 255
    data[offset + 1] = (color >>> 8) & 255
    data[offset + 2] = color & 255
    data[offset + 3] = 255
  }
  return {
    pixels: { width, height, data },
    destination: { left: -0.25, top: 0.25, right: 0.75, bottom: 0.75 },
    opacity: 0.5,
  }
}

/** Real MP4 decoding and canvases; faults are confined to the owning host's acquisition/cleanup. */
export async function exerciseWebVideoMixing(name: WebVideoMixingCase, bytes: Uint8Array) {
  const channel = new MessageChannel(),
    pending = new Map<number, { resolve(value: VideoResult): void; reject(error: Error): void }>(),
    root = document.createElement('div'),
    videos = new Map<number, HTMLVideoElement>(),
    audio = new Set<number>(),
    urls = new Set<string>(),
    frames = new Map<HTMLVideoElement, Set<number>>(),
    messages: string[] = [],
    evidence: Record<string, unknown> = {},
    released: HTMLCanvasElement[] = []
  let serial = 0,
    connected = 0,
    audioCloses = 0,
    createdUrls = 0,
    revokedUrls = 0,
    failAudioId: number | undefined
  root.style.cssText = 'position:relative;width:600px;height:300px'
  document.body.append(root)
  const canvas = (left: number) => {
    const element = document.createElement('canvas')
    element.width = 200
    element.height = 100
    element.style.cssText = `position:absolute;left:${left}px;width:200px;height:100px`
    root.append(element)
    return element
  }
  const first = canvas(0),
    second = canvas(300),
    originalCreateUrl = URL.createObjectURL,
    originalRevokeUrl = URL.revokeObjectURL,
    originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback,
    originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback,
    originalContext = HTMLCanvasElement.prototype.getContext
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
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const owned = frames.get(this) ?? new Set<number>()
    frames.set(this, owned)
    const id = originalRequest.call(this, (now, metadata) => {
      owned.delete(id)
      callback(now, metadata)
    })
    owned.add(id)
    return id
  }
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    frames.get(this)?.delete(id)
    originalCancel.call(this, id)
  }
  const output = {
    activate() {},
    connectMedia(element: HTMLVideoElement) {
      const id = Number(element.dataset.videoId)
      check(!audio.has(id), 'Duplicate audio ownership')
      audio.add(id)
      videos.set(id, element)
      connected++
      return {
        set() {},
        close() {
          check(audio.delete(id), 'Audio closed twice')
          audioCloses++
          if (failAudioId === id) {
            failAudioId = undefined
            throw new Error('mixing-audio-close')
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
  const settings = {
      ...defaultVideoSettings(),
      mode: 2 as const,
      visible: true,
      width: 100,
      height: 60,
      mixingMovieAlpha: 0.25,
    },
    open = (id: number, windowId = 1, epoch = 1, mode: VideoMode = 2) =>
      send({
        op: 'open',
        id,
        windowId,
        epoch,
        name: 'colors.mp4',
        bytes,
        settings: { ...settings, mode },
      }),
    mix = (id: number, image: VideoMixingBitmap | null = bitmap(), epoch = 1) =>
      send({ op: 'mixing', id, epoch, bitmap: image }),
    overlay = (id: number) => {
      const element = videos
        .get(id)
        ?.parentElement?.querySelector<HTMLCanvasElement>('.video-mixing-bitmap')
      check(element, `Movie ${id} lacks its mixing bitmap`)
      return element
    },
    pixel = (element: HTMLCanvasElement) =>
      Array.from(element.getContext('2d')!.getImageData(0, 0, 1, 1).data),
    wasReleased = (element: HTMLCanvasElement) => {
      check(
        !element.isConnected && element.width === 0 && element.height === 0,
        'Mixing canvas or backing survived release',
      )
      released.push(element)
    }
  let host: WebVideoHost | undefined
  try {
    host = new WebVideoHost(channel.port1, output)
    const view = { ...new WindowState().view(), visible: true, width: 200, height: 100 }
    host.setWindow(view, 1)
    host.setWindow(view, 2)
    host.attachWindow(1, 1, first)
    host.attachWindow(2, 1, second)
    if (name === 'non-mixer') {
      for (const mode of [0, 1] as const) {
        await open(11, 1, mode + 1, mode)
        const invalid = bitmap()
        invalid.opacity = NaN
        await mix(11, invalid, mode + 1)
        await mix(11, null, mode + 1)
        check(!root.querySelector('.video-mixing-bitmap'), 'Non-mixer acquired a bitmap')
        await send({ op: 'close', id: 11, epoch: mode + 1 })
      }
    } else {
      await open(11)
      await mix(11)
      const initial = overlay(11)
      check(!initial.hasAttribute('data-window-id'), 'Mixing canvas impersonates a Window surface')
      if (name === 'replacement') {
        const direct = bitmap(),
          surface = createVideoMixingSurface(direct, 1024)
        direct.pixels.data.fill(0)
        direct.destination.left = 3
        direct.opacity = 0
        check(
          pixel(surface.canvas).join(',') === '255,0,0,255',
          'Direct caller mutated captured pixels',
        )
        check(
          surface.canvas.style.left === '-25%' && surface.canvas.style.opacity === '0.5',
          'Direct caller mutated captured geometry or opacity',
        )
        releaseVideoMixingSurface(surface)
        wasReleased(surface.canvas)
        for (const field of ['size', 'length', 'geometry', 'extent', 'opacity'] as const) {
          const invalid = bitmap()
          if (field === 'size') invalid.pixels.width = 0
          if (field === 'length') invalid.pixels.data = new Uint8Array(1)
          if (field === 'geometry') invalid.destination.left = NaN
          if (field === 'extent') invalid.destination.right = invalid.destination.left
          if (field === 'opacity') invalid.opacity = 1.01
          check(
            (await rejected(mix(11, invalid))).includes('Invalid video mixing'),
            `Accepted ${field}`,
          )
          check(
            overlay(11) === initial && pixel(initial).join(',') === '255,0,0,255',
            'Invalid replacement discarded the old bitmap',
          )
        }
        let allocation: HTMLCanvasElement | undefined
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          ...args: Parameters<HTMLCanvasElement['getContext']>
        ) {
          if (this.classList.contains('video-mixing-bitmap') && this !== initial) {
            allocation = this
            return null
          }
          return originalContext.apply(this, args)
        } as HTMLCanvasElement['getContext']
        try {
          check((await rejected(mix(11))).includes('unavailable'), 'Missing context was accepted')
        } finally {
          HTMLCanvasElement.prototype.getContext = originalContext
        }
        check(allocation, 'Context failure was not reached')
        wasReleased(allocation)
        check(overlay(11) === initial, 'Failed canvas allocation discarded the old bitmap')
        const container = initial.parentElement!,
          append = container.append
        let inserted: HTMLCanvasElement | undefined
        container.append = (...nodes) => {
          inserted = nodes[0] as HTMLCanvasElement
          throw new Error('mixing-append')
        }
        try {
          check((await rejected(mix(11))).includes('mixing-append'), 'Append failure was lost')
        } finally {
          container.append = append
        }
        check(inserted, 'Insertion failure was not reached')
        wasReleased(inserted)
        check(overlay(11) === initial, 'Failed insertion discarded the old bitmap')
        await mix(11, bitmap(2, 1, 0x00ff00))
        wasReleased(initial)
        check(
          pixel(overlay(11)).join(',') === '0,255,0,255',
          'Successful replacement retained old pixels',
        )
        evidence.invalidReplacements = 7
      } else if (name === 'budget') {
        await open(22, 2)
        await mix(11, bitmap(4096, 4096))
        wasReleased(initial)
        const full = overlay(11)
        check(
          (await rejected(mix(22, bitmap(1, 1)))).includes('budget exceeded'),
          'Aggregate mixing budget admitted a second bitmap over 64 MiB',
        )
        check(overlay(11) === full, 'Budget rejection changed an existing owner')
        await mix(11, null)
        wasReleased(full)
        await mix(22, bitmap(4096, 4096, 0x00ff00))
        const next = overlay(22)
        check(pixel(next).join(',') === '0,255,0,255', 'Reset did not return its byte budget')
        await send({ op: 'close', id: 22, epoch: 1 })
        wasReleased(next)
        await mix(11, bitmap(4096, 4096))
        evidence.limitBytes = 64 * 1024 * 1024
      } else if (name === 'surface-and-epoch') {
        await open(22, 2)
        await mix(22, bitmap(2, 1, 0x00ff00))
        const other = overlay(22),
          frozen = initial.style.cssText
        host.detachWindow(1, 1)
        check(initial.isConnected && initial.width === 2, 'Surface detach released its live bitmap')
        host.attachWindow(1, 2, canvas(50))
        check(
          overlay(11) === initial && overlay(22) === other,
          'Surface replacement crossed Movie owners',
        )
        await send({
          op: 'set',
          id: 11,
          epoch: 1,
          settings: { ...settings, width: 180, height: 90 },
        })
        host.setWindow({ ...view, zoomNumer: 2 }, 1)
        check(
          initial.style.cssText === frozen && initial.width === 2,
          'Layout renormalized or redrew the captured bitmap',
        )
        check(
          initial.style.opacity === '0.5' && videos.get(11)!.style.opacity === '0.25',
          'Bitmap opacity inherited the movie opacity',
        )
        await send({
          op: 'set',
          id: 11,
          epoch: 1,
          settings: { ...settings, left: 1, top: 1, width: 3, height: 3 },
        })
        host.setWindow({ ...view, zoomNumer: 1, zoomDenom: 2 }, 1)
        const container = initial.parentElement!,
          bounds = container.getBoundingClientRect(),
          planeBounds = container.parentElement!.getBoundingClientRect(),
          fractional = [
            bounds.left - planeBounds.left,
            bounds.top - planeBounds.top,
            bounds.width,
            bounds.height,
          ]
        check(
          fractional.every((value) => Math.abs(value - 1) < 0.01),
          `Fractional zoom did not round each output edge: ${fractional}`,
        )
        check(initial.style.cssText === frozen, 'Fractional zoom renormalized the captured bitmap')
        evidence.fractionalOutput = fractional
        await send({ op: 'close', id: 11, epoch: 2 })
        wasReleased(initial)
        await open(11, 1, 3)
        check(
          !videos.get(11)!.parentElement!.querySelector('.video-mixing-bitmap'),
          'Reopen inherited the old bitmap',
        )
        await mix(11, bitmap(2, 1, 0x0000ff), 3)
        const replacement = overlay(11)
        check(
          (await rejected(mix(11, null, 2))).includes('superseded'),
          'Old epoch reset a replacement',
        )
        check(overlay(11) === replacement, 'Old epoch changed bitmap identity')
        host.removeWindow(1)
        wasReleased(replacement)
        host.attachWindow(1, 3, first)
        check(
          (await rejected(open(33))).includes('Window is closed'),
          'Retired Window accepted a Movie',
        )
        check(
          overlay(22) === other && pixel(other).join(',') === '0,255,0,255',
          'Window retirement removed another Window bitmap',
        )
        const before = (await send({ op: 'inspect', id: 22, epoch: 1 })).snapshot!
        await mix(22, null)
        await mix(22, null)
        const after = (await send({ op: 'inspect', id: 22, epoch: 1 })).snapshot!
        wasReleased(other)
        check(
          before.position === after.position &&
            before.status === after.status &&
            after.mixingMovieAlpha === 0.25,
          'Reset changed movie state',
        )
        evidence.frozen = frozen
      } else {
        await open(22, name === 'retire-failure' ? 1 : 2)
        await mix(22, bitmap(2, 1, 0x00ff00))
        let other = overlay(22)
        failAudioId = 11
        // A failed DOM detach must not skip either backing-dimension release.
        initial.remove = () => {
          throw new Error('mixing-remove')
        }
        let error: string
        if (name === 'close-failure') {
          error = await rejected(send({ op: 'close', id: 11, epoch: 1 }))
          check(overlay(22) === other, 'Closing one movie removed another bitmap')
          // A leaked eight-byte charge from the failed close would reject this
          // replacement at the exact aggregate budget boundary.
          await mix(22, bitmap(4096, 4096))
          wasReleased(other)
          other = overlay(22)
          await send({ op: 'close', id: 22, epoch: 1 })
        } else if (name === 'cancel-failure') error = await rejected(send({ op: 'cancel' }))
        else if (name === 'retire-failure') {
          error = ''
          try {
            host.removeWindow(1)
          } catch (caught) {
            error = String(caught)
          }
        } else error = await rejected(host.close())
        check(error.includes('mixing-remove'), 'Cleanup lost its first bitmap error')
        wasReleased(initial)
        wasReleased(other)
        check(!audio.size && !urls.size, 'Bitmap failure skipped audio or URL cleanup')
        evidence.cleanupError = error
      }
    }
    const remaining = [...root.querySelectorAll<HTMLCanvasElement>('.video-mixing-bitmap')]
    await host.close().catch((error) => {
      if (name !== 'shutdown-failure') throw error
    })
    for (const element of remaining) wasReleased(element)
    check(
      !audio.size && !urls.size && [...frames.values()].every((owned) => !owned.size),
      'Movie resources survived shutdown',
    )
    check(
      !document.querySelector('.video-mixing-bitmap') &&
        !document.querySelector('video') &&
        !document.querySelector('.video-parking'),
      'Movie DOM survived shutdown',
    )
    check(!pending.size && !messages.length, 'Unexpected pending replies or asynchronous errors')
    return {
      name,
      connected,
      audioCloses,
      createdUrls,
      revokedUrls,
      releasedCanvases: released.length,
      pendingReplies: pending.size,
      liveAudio: audio.size,
      liveUrls: urls.size,
      pendingFrames: [...frames.values()].reduce((count, owned) => count + owned.size, 0),
      mixingCanvases: document.querySelectorAll('.video-mixing-bitmap').length,
      messages,
      evidence,
    }
  } finally {
    failAudioId = undefined
    HTMLCanvasElement.prototype.getContext = originalContext
    await host?.close().catch(() => {})
    URL.createObjectURL = originalCreateUrl
    URL.revokeObjectURL = originalRevokeUrl
    HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest
    HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel
    channel.port1.close()
    channel.port2.close()
    root.remove()
  }
}

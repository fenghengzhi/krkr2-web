import { WebVideoHost } from '../../src/backends/video/browser/host.ts'
import type { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import {
  defaultVideoSettings,
  type VideoCommand,
  type VideoResult,
  type VideoEvent,
} from '../../src/engine/ports/video.ts'
import type { VideoMessage, VideoRequest } from '../../src/protocol/video.ts'
import { readVideoTimeline } from '../../src/formats/video/mp4.ts'

export type WebVideoLifetimeCase =
  | 'creation-after-audio'
  | 'insertion-after-registration'
  | 'close-first-frame'
  | 'supersede-first-frame'
  | 'shutdown-failure'
  | 'cancel-failure'
  | 'hidden-first-frames'
  | 'cue-callback-barrier'
  | 'switch-pause-clock'
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
    failAudioConnect = false,
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
      visibility: string; opacity: string; width: number; height: number }> = [],
    cueEvidence: unknown[] = [], cueEvents: VideoEvent[] = [],
    heldReceipts: Array<{ serial: number; event: VideoEvent & { type: 'frame' } }> = []
  const switchEvidence: unknown[] = [],
    playClocks: Array<{ element: HTMLMediaElement; position: number }> = []
  let holdReceipt = false
  const originalCreate = document.createElement,
    originalUrl = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL,
    originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback,
    originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback,
    originalPlay = HTMLMediaElement.prototype.play,
    originalPause = HTMLMediaElement.prototype.pause,
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
  if (name === 'switch-pause-clock') HTMLMediaElement.prototype.play = function () {
    if (this.dataset.videoId) playClocks.push({ element: this, position: this.currentTime })
    return originalPlay.call(this)
  }
  const output = {
    activate() {},
    connectMedia(element: HTMLMediaElement) {
      if (failAudioConnect) { failAudioConnect = false; throw new Error('selected-audio-connect') }
      if (name === 'switch-pause-clock') element.muted = true
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
      if (name === 'cue-callback-barrier') cueEvents.push(data.event)
      if (holdReceipt && data.event.type === 'frame') {
        heldReceipts.push({ serial: data.serial, event: { ...data.event, type: 'frame' } })
        return
      }
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
    } else if (name === 'switch-pause-clock') {
      const timeline = await readVideoTimeline(bytes)
      check(timeline?.audioStreams === 2, 'Track switch fixture requires two real audio streams')
      const settings = { ...defaultVideoSettings(), visible: true },
        opened = await send({ op: 'open', id: 7, epoch: 1, name: 'numbered.mp4', bytes, timeline, settings })
      check(opened.snapshot?.enabledAudioStream === 0, 'Initial track was not selected')
      await send({ op: 'seek', id: 7, epoch: 1, position: 1000 })
      await send({ op: 'play', id: 7, epoch: 1 })
      const first = node.querySelector('video')!
      await until(() => !first.paused && first.currentTime > 1.02)
      // Delay the actual pause operation, never a clock or frame observation.
      // The original decoder keeps progressing until this gate calls the real
      // DOM method and its real pause event publishes the stopped position.
      const gate: { requested?: number; release?: () => void } = {}
      Object.defineProperty(first, 'pause', { configurable: true, value() {
        delete (first as unknown as { pause?: unknown }).pause
        gate.requested = first.currentTime
        gate.release = () => originalPause.call(first)
      } })
      let frozen = -1, completed = false
      first.addEventListener('pause', () => { frozen = first.currentTime }, { once: true })
      const switching = send({ op: 'set', id: 7, epoch: 2,
        settings: { ...settings, enabledAudioStream: 1 } })
      void switching.then(() => { completed = true }, () => { completed = true })
      await until(() => gate.release !== undefined)
      await until(() => first.currentTime > gate.requested! + .12)
      check(!completed && connected === 1 && !first.paused,
        'Replacement started before the original graph actually paused')
      gate.release!()
      const selected = await switching, second = node.querySelector('video')!,
        resumed = playClocks.find((entry) => entry.element === second)
      check(second !== first && selected.snapshot?.enabledAudioStream === 1 && selected.snapshot.status === 'play',
        'Selected track was not committed as playing')
      check(frozen > gate.requested! + .12 && resumed?.position === frozen,
        'The selected graph used the pre-pause clock instead of the actual stopped position')
      await until(() => !second.paused && second.currentTime > frozen + .02)
      switchEvidence.push({ phase: 'actual-pause-before-handoff', requested: gate.requested, frozen,
        resumed: resumed?.position, selected: selected.snapshot, connected })

      // A later explicit pause owns this same decoder. The cancelled handoff
      // cannot restart it when its older pause completion is finally released.
      const cancelled: { release?: () => void } = {}
      Object.defineProperty(second, 'pause', { configurable: true, value() {
        delete (second as unknown as { pause?: unknown }).pause
        cancelled.release = () => originalPause.call(second)
      } })
      const older = rejected(send({ op: 'set', id: 7, epoch: 3, settings }))
      await until(() => cancelled.release !== undefined)
      const playsBefore = playClocks.length
      await send({ op: 'pause', id: 7, epoch: 4 })
      check((await older).includes('cancelled'), 'A newer pause did not cancel the old handoff')
      cancelled.release!()
      const stopped = await send({ op: 'inspect', id: 7, epoch: 4 })
      check(stopped.snapshot?.status === 'pause' && second.paused && playClocks.length === playsBefore && connected === 2,
        'A stale handoff resumed playback or allocated a replacement after the newer pause')
      switchEvidence.push({ phase: 'newer-pause-wins', snapshot: stopped.snapshot, connected })

      // Failure after the stopped clock was acquired restores the original
      // selected track at that clock, without seeking it to the request time.
      await send({ op: 'play', id: 7, epoch: 5 })
      await until(() => !second.paused && second.currentTime > stopped.snapshot!.position / 1000 + .02)
      let rollbackClock = -1
      second.addEventListener('pause', () => { rollbackClock = second.currentTime }, { once: true })
      const rollbackStart = playClocks.length
      failAudioConnect = true
      check((await rejected(send({ op: 'set', id: 7, epoch: 6, settings }))).includes('selected-audio-connect'),
        'The controlled replacement failure was lost')
      const rollback = playClocks.slice(rollbackStart)
      check(rollback.length === 1 && rollback[0]!.element === second && rollback[0]!.position === rollbackClock,
        'Rollback restarted the old graph from a different clock')
      await until(() => !second.paused && second.currentTime > rollbackClock + .02)
      const restored = await send({ op: 'inspect', id: 7, epoch: 6 })
      check(restored.snapshot?.enabledAudioStream === 1 && restored.snapshot.status === 'play' && connected === 2,
        'Rollback lost the original selected stream')
      switchEvidence.push({ phase: 'rollback-from-stopped-clock', clock: rollbackClock, snapshot: restored.snapshot })
      const movingClock = second.currentTime, movingPlays = playClocks.length
      Object.defineProperty(second, 'pause', { configurable: true, value() {
        delete (second as unknown as { pause?: unknown }).pause
        throw new Error('selected-pause-not-completed')
      } })
      check((await rejected(send({ op: 'set', id: 7, epoch: 7, settings }))).includes('selected-pause-not-completed'),
        'An unsuccessful pause was treated as a frozen clock')
      const movingRollback = playClocks.slice(movingPlays)
      check(movingRollback.length === 1 && movingRollback[0]!.element === second &&
        movingRollback[0]!.position >= movingClock && !second.paused && connected === 2,
      'Rollback rewound or replaced an old graph that never stopped')
      await until(() => second.currentTime > movingRollback[0]!.position + .02)
      switchEvidence.push({ phase: 'rollback-still-moving', before: movingClock,
        resumed: movingRollback[0]!.position, after: second.currentTime })
    } else if (name === 'cue-callback-barrier') {
      const timeline = await readVideoTimeline(bytes)
      check(timeline?.times.length === 18, 'Cue probe requires the actual 18-frame MP4 timeline')
      const openCue = (epoch: number, mode: 0 | 1 | 2) => send({ op: 'open', id: 7, epoch,
        name: 'colors.mp4', bytes, timeline,
        settings: { ...defaultVideoSettings(), mode, visible: true } })
      await openCue(1, 2)
      await send({ op: 'period', id: 7, epoch: 1, frame: 2 })
      holdReceipt = true
      await send({ op: 'play', id: 7, epoch: 1 })
      await until(() => heldReceipts.length === 1)
      const heldFrame = heldReceipts[0]!
      check(heldFrame.event.deferredPeriod && heldFrame.event.deliveryToken === heldFrame.serial,
        'Real frame did not carry its callback completion token')
      const element = node.querySelector('video')!
      await until(() => element.ended)
      check(!cueEvents.some((event) => event.type === 'period' || event.type === 'ended'),
        'Clock fallback or EOF bypassed an unfinished real frame callback')
      check((await send({ op: 'inspect', id: 7, epoch: 1 })).snapshot?.status === 'play', 'EOF did not wait for the callback')
      await send({ op: 'period', id: 7, epoch: 1, frame: -1 })
      await send({ op: 'frameDone', id: 7, epoch: 1, token: heldFrame.serial })
      await until(() => cueEvents.some((event) => event.type === 'ended'))
      check((await send({ op: 'inspect', id: 7, epoch: 1 })).snapshot?.status === 'stop',
        'EOF incorrectly waited for the distinct presentation receipt')
      check(!cueEvents.some((event) => event.type === 'period'), 'Cancelled cue fired after the frame callback')
      cueEvidence.push({ phase: 'callback-before-EOF', token: heldFrame.serial, actualEnded: element.ended,
        events: cueEvents.map((event) => event.type), screenReceiptHeld: true })
      holdReceipt = false
      channel.port2.postMessage({ type: 'ack', serial: heldFrame.serial } satisfies VideoMessage)
      for (const mode of [0, 1] as const) {
        const epoch = mode + 2
        holdFrames = false
        await openCue(epoch, mode)
        cueEvents.length = 0
        await send({ op: 'period', id: 7, epoch, frame: 6 })
        holdFrames = true // Actual first frame is loaded; withhold only playback callbacks.
        await send({ op: 'play', id: 7, epoch })
        await send({ op: 'frameDone', id: 7, epoch: 1, token: heldFrame.serial })
        check((await send({ op: 'inspect', id: 7, epoch })).snapshot?.status === 'play',
          'A retired graph callback completed the replacement decoder')
        await until(() => cueEvents.some((event) => event.type === 'period' && event.reason === 1))
        const event = cueEvents.find((event) => event.type === 'period')!
        check(event.type === 'period' && event.snapshot.frame >= 6, 'Clock fallback fired before its actual frame time')
        check(!cueEvents.some((event) => event.type === 'frame'), 'Playback rVFC was not actually withheld')
        cueEvidence.push({ phase: mode === 0 ? 'default-overlay-clock' : 'unbound-layer-clock', event })
        await send({ op: 'stop', id: 7, epoch })
        holdFrames = false
        if (mode === 1) {
          await send({ op: 'seek', id: 7, epoch, position: 0 })
          await send({ op: 'period', id: 7, epoch, frame: 6 })
          cueEvents.length = 0
          // VideoService drops unbound Layer frames by acknowledging their
          // receipt without running the native frame continuation/frameDone.
          await send({ op: 'play', id: 7, epoch })
          await until(() => cueEvents.some((event) => event.type === 'period' && event.reason === 1))
          check(cueEvents.some((event) => event.type === 'frame'), 'Unbound Layer control never received a real frame')
          cueEvidence.push({ phase: 'unbound-layer-discarded-frames', events: cueEvents.map((event) => event.type) })
          await send({ op: 'stop', id: 7, epoch })
        }
      }
      for (const mode of [1, 2] as const) {
        const epoch = mode + 3
        holdFrames = false; holdReceipt = true; heldReceipts.length = 0
        await openCue(epoch, mode)
        cueEvents.length = 0
        await send({ op: 'period', id: 7, epoch, frame: 6 })
        await send({ op: 'play', id: 7, epoch })
        await until(() => heldReceipts.length === 1)
        const first = heldReceipts[0]!
        check(first.event.callbackFrame! < 6, 'The first real playback frame must precede this cue')
        // Complete the callback AND receipt, then withhold the next native
        // callback while actual media time continues. This distinguishes the
        // inter-frame race from the existing unfinished-callback barrier.
        holdFrames = true
        await send({ op: 'frameDone', id: 7, epoch, token: first.serial })
        channel.port2.postMessage({ type: 'ack', serial: first.serial } satisfies VideoMessage)
        heldReceipts.length = 0
        const element = node.querySelector('video')!
        await until(() => held.size > 0 && element.currentTime >= 0.8)
        check(!cueEvents.some((event) => event.type === 'period'), 'The clock overtook the last delivered layer/mixer frame')
        const entry = held.entries().next().value!
        held.delete(entry[0]); frames.delete(entry[0]); holdFrames = false
        // Forward the genuine native callback unchanged. Delayed delivery uses
        // the original EC_UPDATE current-clock correction, not fabricated PTS.
        entry[1].callback(entry[1].now, entry[1].metadata)
        await until(() => heldReceipts.length === 1)
        const later = heldReceipts[0]!, frame = later.event.callbackFrame!
        check(frame >= 6, 'A later actual frame did not cross the cue')
        const take = await send({ op: 'periodTake', id: 7, epoch, frame }),
          again = await send({ op: 'periodTake', id: 7, epoch, frame })
        check(take.events.filter((event) => event.type === 'period' && event.reason === 1).length === 1 &&
          !again.events.some((event) => event.type === 'period'), 'The delivered-frame cue did not fire exactly once')
        await send({ op: 'frameDone', id: 7, epoch, token: later.serial })
        await until(() => element.ended)
        await until(() => cueEvents.some((event) => event.type === 'ended'))
        check((await send({ op: 'inspect', id: 7, epoch })).snapshot?.status === 'stop',
          'Natural EOF waited for a screen receipt after the completed frame callback')
        holdReceipt = false
        channel.port2.postMessage({ type: 'ack', serial: later.serial } satisfies VideoMessage)
        // Changing renderer mode clears that delivery history. With no frame
        // from the replacement mode, its established clock fallback is live.
        await send({ op: 'set', id: 7, epoch, settings: { ...defaultVideoSettings(), mode: mode === 1 ? 2 : 1, visible: true } })
        await send({ op: 'seek', id: 7, epoch, position: 0 })
        await send({ op: 'period', id: 7, epoch, frame: 6 })
        cueEvents.length = 0; holdFrames = true
        await send({ op: 'play', id: 7, epoch })
        await until(() => cueEvents.some((event) => event.type === 'period' && event.reason === 1))
        check(!cueEvents.some((event) => event.type === 'frame'), 'Replacement-mode playback callbacks were not withheld')
        cueEvidence.push({ phase: mode === 1 ? 'layer-delivered-cue' : 'mixer-delivered-cue',
          first: first.event.callbackFrame, later: frame, periods: take.events, screenReceiptHeldAtEOF: true,
          replacementModeEvents: cueEvents.map((event) => event.type) })
        await send({ op: 'stop', id: 7, epoch }); holdFrames = false
      }
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
      cueEvidence,
      switchEvidence,
    }
  } finally {
    failContainer = false
    failAudioClose = false
    failAudioConnect = false
    await host?.close().catch(() => {})
    document.createElement = originalCreate
    URL.createObjectURL = originalUrl
    URL.revokeObjectURL = originalRevoke
    HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest
    HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel
    HTMLMediaElement.prototype.play = originalPlay
    ResizeObserver.prototype.disconnect = originalDisconnect
    channel.port1.close()
    channel.port2.close()
    node.remove()
  }
}

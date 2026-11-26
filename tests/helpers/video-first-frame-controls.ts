import type { Page } from '@playwright/test'

/** Failure-only hosted controls. These never resolve a product presentation
 * promise or change its result. The source is the actual staged track Blob. */
export async function compareFirstFrameParents(page: Page) {
  return page.evaluate(async () => {
    const result: { productVerification: false; available: boolean; source?: unknown;
      controls: Record<string, unknown>[]; errors: string[] } = {
      productVerification: false, available: false, controls: [], errors: [],
    }
    const candidate = document.querySelector<HTMLVideoElement>(
      '.video-presentation-surface video:not([data-video-id]), .video-parking video:not([data-video-id])')
    if (!candidate) { result.errors.push('No live staged decoder remains for same-track controls'); return result }
    const sourceUrl = candidate.currentSrc || candidate.src, rect = candidate.getBoundingClientRect(),
      width = rect.width, height = rect.height
    if (!sourceUrl.startsWith('blob:') || !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 || width > 1024 || height > 1024) {
      result.errors.push('Staged source or nonzero presentation geometry is unavailable'); return result
    }
    const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0')).join('')
    const bounded = async <T,>(work: Promise<T>, label: string, milliseconds = 5000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds)
        })])
      } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    let blob: Blob
    try {
      const response = await bounded(fetch(sourceUrl), 'Retain actual staged Blob')
      if (!response.ok) throw new Error('Actual staged Blob is no longer readable')
      blob = await bounded(response.blob(), 'Read actual staged Blob')
      if (!blob.size || blob.size > 8 * 1024 ** 2) throw new Error('Unexpected first-frame control source size')
      if (candidate.hasAttribute('data-video-id')) throw new Error('Decoder was committed before retaining the control source')
      result.source = { uncommitted: true, bytes: blob.size, sha256: await hash(await blob.arrayBuffer()), type: blob.type,
        width, height, mediaWidth: candidate.videoWidth, mediaHeight: candidate.videoHeight,
        position: candidate.currentTime, paused: candidate.paused, readyState: candidate.readyState,
        ancestry: Array.from((function* () { for (let node: HTMLElement | null = candidate; node; node = node.parentElement) yield node })())
          .slice(0, 8).map((node) => { const css = getComputedStyle(node); return {
            tag: node.tagName, className: node.className, display: css.display, visibility: css.visibility, opacity: css.opacity,
          } }) }
    } catch (error) { result.errors.push(String(error)); return result }
    let context: AudioContext | undefined
    try {
      context = new AudioContext()
      await bounded(context.resume(), 'Start silent control graph')
      if (context.state !== 'running') throw new Error('Silent control AudioContext is not running')
      result.available = true
      for (const opacity of ['1', '0']) {
        const parent = document.createElement('div'), video = document.createElement('video'),
          url = URL.createObjectURL(blob), events: unknown[] = [], stages: unknown[] = [], cleanupErrors: string[] = [],
          pending = new Set<() => void>(), row: Record<string, unknown> = {
            parent: opacity === '1' ? 'stable-presentable' : 'stable-transparent-parking',
            registration: 'before-src-and-load', width, height, opacity, gain: 0, muted: true,
            events, stages, cleanupErrors,
          }
        result.controls.push(row)
        let audio: MediaElementAudioSourceNode | undefined, gain: GainNode | undefined
        const state = () => {
          const quality = video.getVideoPlaybackQuality()
          return { position: video.currentTime, paused: video.paused, seeking: video.seeking,
            muted: video.muted, gain: gain?.gain.value, audioState: context?.state,
            readyState: video.readyState, networkState: video.networkState, connected: video.isConnected,
            width: video.videoWidth, height: video.videoHeight,
            quality: { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames } }
        }
        const frame = (phase: string, pause: boolean) => new Promise<unknown>((resolve, reject) => {
          let handle: number | undefined, settled = false
          const finish = () => {
            if (settled) return
            settled = true; clearTimeout(timer); pending.delete(cancel)
            if (handle !== undefined) { video.cancelVideoFrameCallback(handle); handle = undefined }
          }, cancel = () => { finish(); reject(new Error(phase + ' callback retired')) },
            timer = setTimeout(() => { finish(); reject(new Error(phase + ' real rVFC timed out')) }, 2500)
          pending.add(cancel)
          try {
            handle = video.requestVideoFrameCallback((now, metadata) => {
              handle = undefined
              if (settled) return
              finish()
              try {
                if (pause) video.pause()
                const current = state(), canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
                  drawing = canvas.getContext('2d', { willReadFrequently: true })!
                drawing.drawImage(video, 0, 0)
                const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data,
                  center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4
                void hash(Uint8Array.from(pixels).buffer).then((sha256) => resolve({ now, metadata, state: current,
                  pixels: { bytes: pixels.length, sha256, center: Array.from(pixels.subarray(center, center + 4)) } }), reject)
              } catch (error) { reject(error) }
            })
          } catch (error) { finish(); reject(error) }
        })
        const event = (name: string, action: () => void) => new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true; clearTimeout(timer); video.removeEventListener(name, received); pending.delete(cancel)
          }, received = () => { finish(); resolve() }, cancel = () => { finish(); reject(new Error(name + ' listener retired')) },
            timer = setTimeout(() => { finish(); reject(new Error(name + ' timed out')) }, 2500)
          pending.add(cancel); video.addEventListener(name, received, { once: true })
          try { action() } catch (error) { finish(); reject(error) }
        })
        const inspect = async (phase: string, work: () => Promise<unknown>) => {
          try { stages.push({ phase, completed: true, observation: await work(), state: state() }) }
          catch (error) { stages.push({ phase, completed: false, error: String(error), state: state() }) }
        }
        try {
          parent.className = 'video-first-frame-parent-control'; parent.inert = true; parent.setAttribute('aria-hidden', 'true')
          Object.assign(parent.style, { position: 'fixed', left: '0', top: '0', width: width + 'px', height: height + 'px',
            overflow: 'hidden', visibility: 'visible', opacity, pointerEvents: 'none' })
          Object.assign(video.style, { display: 'block', width: '100%', height: '100%', visibility: 'visible', opacity: '1' })
          // Keep the failure fixture's withheld-callback hook away from these
          // independent real decoders. This is not a committed game video.
          video.dataset.videoId = 'first-frame-parent-control'
          video.preload = 'auto'; video.playsInline = true; video.muted = true
          parent.append(video); document.body.append(parent)
          audio = context.createMediaElementSource(video); gain = context.createGain(); gain.gain.value = 0
          audio.connect(gain); gain.connect(context.destination)
          for (const name of ['loadedmetadata', 'loadeddata', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error'])
            video.addEventListener(name, () => { if (events.length < 32) events.push({ name, at: performance.now(), state: state() }) })
          await inspect('paused-preload', () => Promise.all([frame('paused-preload', false),
            event('loadeddata', () => { video.src = url; video.load() })]))
          if (video.readyState >= 2) {
            await inspect('muted-play-and-pause', () => {
              const presented = frame('muted-play-and-pause', true)
              return Promise.all([presented, bounded(Promise.resolve().then(() => video.play()), 'Muted control play', 2500)])
            })
            video.pause()
            if (video.currentTime > 0) await inspect('paused-seek-zero', () => Promise.all([
              frame('paused-seek-zero', false), event('seeked', () => { video.currentTime = 0 }),
            ]))
            else stages.push({ phase: 'paused-seek-zero', completed: false, notRequested: 'The real clock is already zero; no new seek or frame is claimed', state: state() })
          }
          row.final = state()
        } catch (error) { row.error = String(error) }
        finally {
          for (const cancel of [...pending]) try { cancel() } catch (error) { cleanupErrors.push(String(error)) }
          for (const release of [() => video.pause(), () => audio?.disconnect(), () => gain?.disconnect(),
            () => { video.removeAttribute('src'); video.load() }, () => parent.remove(), () => URL.revokeObjectURL(url)])
            try { release() } catch (error) { cleanupErrors.push(String(error)) }
          row.retired = !video.isConnected
        }
      }
    } catch (error) { result.errors.push(String(error)) }
    finally {
      if (context && context.state !== 'closed') try { await bounded(context.close(), 'Close control audio context') }
      catch (error) { result.errors.push(String(error)) }
    }
    return result
  })
}

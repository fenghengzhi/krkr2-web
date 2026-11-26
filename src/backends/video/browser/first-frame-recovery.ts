type StartupVideo = Pick<HTMLVideoElement, 'paused' | 'muted' | 'readyState' | 'play' | 'pause' |
  'getVideoPlaybackQuality'>

/** A warmup can report paused=true before the platform has published its
 * stopped clock. Subscribe before closing recovery and wait for the actual
 * pause event, so a cached zero cannot bypass the required restoration seek. */
export function pauseRecoveredVideo(video: EventTarget & { readonly paused: boolean },
  signal: AbortSignal, options: { stop(): void; schedule(callback: () => void, delay: number): () => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const alreadyPaused = video.paused
    let settled = false, stopped = false, observed = false, cancelTimeout = () => {}
    const done = (error?: unknown) => {
      if (settled) return
      settled = true
      cancelTimeout()
      video.removeEventListener('pause', paused)
      signal.removeEventListener('abort', cancel)
      error === undefined ? resolve() : reject(error)
    }, complete = () => {
      if (!stopped || settled) return
      if (signal.aborted) cancel()
      else if (alreadyPaused || observed) {
        if (!video.paused) done(new Error('Video recovery pause did not stop playback'))
        else done()
      }
    }, paused = () => { observed = true; complete() },
      cancel = () => done(new Error('Video recovery pause cancelled'))
    try {
      if (!alreadyPaused && !signal.aborted) {
        video.addEventListener('pause', paused)
        signal.addEventListener('abort', cancel, { once: true })
        cancelTimeout = options.schedule(() => done(new Error('Video recovery pause timed out')), 15000)
        if (settled) cancelTimeout()
      }
      // Cleanup is still required for an already cancelled or paused warmup.
      // A synchronous test/event cannot publish success until stop returns.
      options.stop()
      stopped = true
      complete()
    } catch (error) { done(error) }
  })
}

/** A stalled private decoder may need to run before it submits its first image.
 * This never substitutes loadeddata, a timer or a decoded-frame count for rVFC.
 * The caller still owns that gate and must restore the starting media clock. */
export function recoverVideoFirstFrame(video: StartupVideo, options: {
  schedule(callback: () => void, delay: number): () => void
  allowed(): boolean
  started(): void
  failed(error: unknown): void
}) {
  const muted = video.muted
  let elapsed = false, started = false, closed = false, suspended = false,
    pending = false, retry = false, denied: string | undefined
  const resume = () => {
    if (!elapsed || closed || suspended || denied || !options.allowed()) return
    if (pending) { retry = true; return }
    if (!started) {
      // Match the archived Firefox stall, not a slow download or a callback
      // deliberately withheld after a frame has already been submitted.
      if (!video.paused || video.readyState !== 4 || typeof video.getVideoPlaybackQuality !== 'function' ||
          video.getVideoPlaybackQuality().totalVideoFrames !== 0) return
      options.started()
      started = true
      video.muted = true
    }
    if (!video.paused) return
    pending = true
    try {
      void video.play().then(() => {
        pending = false
        if (closed) return
        if (suspended || !options.allowed()) video.pause()
      }, (error: unknown) => {
        pending = false
        if (closed) return
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          // Retain the ordinary rVFC wait and its original deadline. A policy
          // rejection must not turn an unpresented frame into a successful open.
          denied = error.message || error.name
          video.pause()
          video.muted = muted
        } else if (error instanceof DOMException && error.name === 'AbortError') {
          if (retry) { retry = false; resume() }
        } else options.failed(error)
      })
    } catch (error) { pending = false; options.failed(error) }
  }
  // This is a recovery opportunity inside the existing 15 s first-frame
  // deadline, not an extension of that deadline or a source of frame proof.
  const cancel = options.schedule(() => { elapsed = true; resume() }, 1000)
  return {
    get started() { return started },
    get denied() { return denied },
    resume() { suspended = false; resume() },
    suspend() { suspended = true; if (started && !closed) video.pause() },
    close() {
      if (closed) return
      closed = true
      cancel()
      if (started) { try { video.pause() } finally { video.muted = muted } }
    },
  }
}

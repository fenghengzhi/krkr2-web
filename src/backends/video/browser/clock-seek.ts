/** A public frame seek sets a media clock. A fresh compositor submission is a
 * separate condition: its mediaTime need not equal that requested clock.
 * Keep this gate distinct from exact-PTS lookup and retained-image comparison. */
export function waitForClockPresentation(
  video: HTMLVideoElement,
  position: number,
  previousFrames: number,
  signal: AbortSignal,
  current: () => void,
  seek: () => Promise<void>,
  deadline: (expired: () => void) => () => void,
  observe: (metadata: VideoFrameCallbackMetadata) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let settled = false, sought = false, presented = false, callback: number | undefined
    let cancelTimeout = () => {}
    const done = (error?: unknown) => {
      if (settled) return
      settled = true
      cancelTimeout()
      if (callback !== undefined) video.cancelVideoFrameCallback(callback)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }, complete = () => {
      if (settled || !sought || !presented) return
      try {
        current()
        if (video.seeking || video.readyState < 2 ||
            Math.abs(video.currentTime * 1000 - position) > 0.001)
          throw new Error('Video frame seek changed the requested media clock')
        done()
      } catch (error) { done(error) }
    }, cancel = () => done(new Error('Video operation cancelled')),
      request = () => {
        callback = video.requestVideoFrameCallback((_now, metadata) => {
          callback = undefined
          if (settled) return
          try {
            current()
            // A delayed callback for a submission made before this seek, or a
            // repeated frame counter, cannot prove a new presentation. Both
            // timestamps use this document's performance time origin.
            if (!Number.isFinite(metadata.presentationTime) || metadata.presentationTime < startedAt ||
                !Number.isSafeInteger(metadata.presentedFrames) || metadata.presentedFrames <= previousFrames) {
              request()
              return
            }
            observe(metadata)
            presented = true
            complete()
          } catch (error) { done(error) }
        })
      }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    cancelTimeout = deadline(() => done(new Error('Video frame seek presentation timed out')))
    try {
      current()
      // Arm before assigning currentTime. The media/compositor thread can
      // publish a paused seek's sole frame during that assignment; rVFC is a
      // next-frame notification and does not replay a submission missed before
      // registration. Timestamp/counter checks above still reject old frames.
      request()
      const pending = seek()
      void pending.then(() => { sought = true; complete() }, done)
    } catch (error) { done(error) }
  })
}

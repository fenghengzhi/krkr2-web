import type { Page, Request, Response, TestInfo } from '@playwright/test'

interface WorkerFailure {
  phase: string
  message: string
  error?: { name?: string; message: string; stack?: string }
}
type WorkerOutcome<T> = { ok: true; value: T } | { ok: false; failure: WorkerFailure }

/** Keep the actual module Worker and its timeout. Import failures can produce an
 * empty ErrorEvent, so retain the requested modules as well as browser events. */
export async function runFontWorker<T>(
  page: Page,
  testInfo: TestInfo,
  options: { name: string; source: string; data: unknown; modulePrefix: string },
): Promise<T> {
  const network: { url: string; status?: number; failure?: string }[] = [],
    pageErrors: { name: string; message: string; stack?: string }[] = []
  let droppedNetwork = 0, droppedPageErrors = 0
  const observedRequest = (url: string) => {
    const path = new URL(url).pathname
    return path.startsWith(options.modulePrefix) || path.startsWith('/fonts/')
  }
  const response = (entry: Response) => {
    if (!observedRequest(entry.url())) return
    if (network.length < 128) network.push({ url: entry.url().slice(0, 2048), status: entry.status() })
    else droppedNetwork++
  }, failed = (entry: Request) => {
    if (!observedRequest(entry.url())) return
    if (network.length < 128) network.push({ url: entry.url().slice(0, 2048), failure: entry.failure()?.errorText.slice(0, 4096) })
    else droppedNetwork++
  }, pageError = (error: Error) => {
    if (pageErrors.length < 16) pageErrors.push({ name: error.name, message: error.message.slice(0, 4096), stack: error.stack?.slice(0, 8192) })
    else droppedPageErrors++
  }
  page.on('response', response)
  page.on('requestfailed', failed)
  page.on('pageerror', pageError)
  let observed: { outcome: WorkerOutcome<T>; events: unknown[]; cleanup: string[] } | undefined
  const failures: unknown[] = []
  try {
    observed = await page.evaluate(async ({ name, source, data }) => {
      const events: unknown[] = [], cleanup: string[] = []
      let worker: Worker | undefined, url: string | undefined
      const describe = (error: unknown) => {
        const value = error as { name?: unknown; message?: unknown; stack?: unknown } | null
        return value && typeof value.message === 'string'
          ? { name: typeof value.name === 'string' ? value.name.slice(0, 256) : undefined,
              message: value.message.slice(0, 4096),
              stack: typeof value.stack === 'string' ? value.stack.slice(0, 8192) : undefined }
          : { message: String(error).slice(0, 4096) }
      }
      let outcome: WorkerOutcome<T>
      try {
        outcome = await new Promise<WorkerOutcome<T>>((resolve) => {
          let settled = false, timer: ReturnType<typeof setTimeout> | undefined
          const finish = (value: WorkerOutcome<T>) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          }
          try {
            url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            worker = new Worker(url, { type: 'module', name })
            events.push({ type: 'created', name, url })
            worker.addEventListener('error', (event) => {
              // A failed module fetch may dispatch a plain Event, not an
              // ErrorEvent. Keep the missing fields; do not throw while
              // trying to diagnose the original import failure.
              const message = typeof event.message === 'string' ? event.message : '',
                error = describe(event.error)
              events.push({ type: 'error', eventClass: event.constructor.name,
                message: message.slice(0, 4096), messageType: typeof event.message,
                filename: typeof event.filename === 'string' ? event.filename.slice(0, 2048) : undefined,
                lineno: event.lineno, colno: event.colno, errorType: typeof event.error, error })
              finish({ ok: false, failure: { phase: 'error',
                message: message.slice(0, 4096) || 'Module Worker emitted an empty error event', error } })
            }, { once: true })
            worker.addEventListener('messageerror', (event) => {
              events.push({ type: 'messageerror',
                origin: typeof event.origin === 'string' ? event.origin.slice(0, 2048) : undefined,
                lastEventId: typeof event.lastEventId === 'string' ? event.lastEventId.slice(0, 256) : undefined })
              finish({ ok: false, failure: { phase: 'messageerror', message: 'Worker reply could not be deserialized' } })
            }, { once: true })
            worker.addEventListener('message', ({ data: value }: MessageEvent<T>) => {
              const reply = value as { error?: unknown; stack?: unknown } | null
              events.push({ type: 'message', replyType: typeof value,
                error: typeof reply?.error === 'string' ? reply.error.slice(0, 4096) : undefined,
                stack: typeof reply?.stack === 'string' ? reply.stack.slice(0, 8192) : undefined })
              finish({ ok: true, value })
            }, { once: true })
            timer = setTimeout(() => {
              events.push({ type: 'timeout', milliseconds: 12000 })
              finish({ ok: false, failure: { phase: 'timeout', message: 'Font Worker timed out after 12000 ms' } })
            }, 12000)
            worker.postMessage(data)
            events.push({ type: 'input-posted' })
          } catch (error) {
            const detail = describe(error)
            events.push({ type: 'construction-or-post', error: detail })
            finish({ ok: false, failure: { phase: 'construction-or-post', message: detail.message, error: detail } })
          }
        })
      } finally {
        try { worker?.terminate(); cleanup.push(worker ? 'terminated' : 'no-worker') }
        catch (error) { cleanup.push('terminate: ' + describe(error).message) }
        try { if (url) URL.revokeObjectURL(url); cleanup.push(url ? 'url-revoked' : 'no-object-url') }
        catch (error) { cleanup.push('revoke: ' + describe(error).message) }
      }
      return { outcome, events, cleanup }
    }, { name: options.name, source: options.source, data: options.data })
    if (!observed.outcome.ok) {
      const bad = network.filter((entry) => entry.failure || (entry.status ?? 0) >= 400)
      failures.push(new Error(`${options.name}: ${observed.outcome.failure.message}` +
        (bad.length ? '; module responses: ' + JSON.stringify(bad.slice(0, 8)) : ''), { cause: observed.outcome.failure }))
    }
    if (observed.cleanup.some((entry) => entry.startsWith('terminate: ') || entry.startsWith('revoke: ')))
      failures.push(new Error('Font Worker cleanup failed: ' + observed.cleanup.join('; ')))
  } catch (error) {
    failures.push(error)
  } finally {
    page.off('response', response)
    page.off('requestfailed', failed)
    page.off('pageerror', pageError)
    try {
      await testInfo.attach(options.name + '-worker', {
        contentType: 'application/json',
        body: JSON.stringify({ name: options.name, source: options.source.slice(0, 32768),
          sourceTruncated: options.source.length > 32768, network, droppedNetwork, pageErrors, droppedPageErrors,
          outcome: observed?.outcome.ok ? { ok: true } : observed?.outcome,
          events: observed?.events, cleanup: observed?.cleanup,
          harnessErrors: failures.map((error) => error instanceof Error
            ? { name: error.name, message: error.message.slice(0, 8192), stack: error.stack?.slice(0, 8192) }
            : { message: String(error).slice(0, 4096) }) }, null, 2),
      })
    } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Font Worker scenario or evidence cleanup failed', { cause: failures[0] })
  if (!observed?.outcome.ok) throw new Error('Font Worker did not return a result')
  return observed.outcome.value
}

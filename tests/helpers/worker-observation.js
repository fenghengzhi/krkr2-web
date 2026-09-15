// Inject this file as untransformed text before application code. This avoids
// importing tsx/esbuild function-name helpers into the browser's execution context.
// Preserved releases and their files remain unchanged; no game values are copied.
;(() => {
  const started = performance.now(),
    entries = [],
    workers = [],
    records = new WeakMap()
  let dropped = 0,
    observationErrors = 0,
    installed = false
  const safely = (read) => {
    try {
      read()
    } catch {
      observationErrors++
    }
  }
  const record = (entry) => {
    if (entries.length >= 2048) {
      dropped++
      return
    }
    entries.push({
      at: performance.now() - started,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      ...entry,
    })
  }
  // Read data properties only. Accessors are never invoked for diagnostics.
  const own = (value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  }
  const allowed = (value, choices) =>
    typeof value === 'string' && choices.includes(value) ? value : undefined
  const state = (value) =>
    allowed(value, [
      'initializing',
      'ready',
      'running',
      'paused',
      'stopping',
      'stopped',
      'failed',
      'visible',
      'hidden',
      'frozen',
      'away',
    ])
  const message = (value) => {
    const candidate = own(value, 'id'),
      id =
        typeof candidate === 'string' && /^[a-f0-9-]{1,128}$/i.test(candidate)
          ? candidate
          : undefined,
      type = allowed(own(value, 'type'), [
        'GET',
        'SET',
        'APPLY',
        'CONSTRUCT',
        'ENDPOINT',
        'RELEASE',
        'RAW',
        'HANDLER',
      ])
    return { id, type }
  }
  const request = (value) => {
    const header = message(value),
      args = own(value, 'argumentList'),
      first = own(args, '0'),
      operation =
        header.type === 'APPLY' && own(first, 'type') === 'RAW'
          ? allowed(own(first, 'value'), [
              'prepare',
              'initialize',
              'mount',
              'start',
              'stop',
              'setActivity',
              'evaluate',
              'setSystemFonts',
            ])
          : undefined
    // No prepare file lists, evaluation source, result values, or transferred
    // MessagePorts are inspected. Only initialize/activity metadata is needed.
    const argument =
        operation === 'initialize' || operation === 'setActivity'
          ? own(own(args, '1'), 'value')
          : undefined,
      generation = operation === 'initialize' ? own(argument, 'generation') : undefined,
      activity = operation === 'initialize' ? own(argument, 'activity') : argument
    return {
      ...header,
      operation,
      generation:
        typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0
          ? generation
          : undefined,
      state: state(own(activity, 'state')),
    }
  }
  Object.defineProperty(window, '__krkrWorkerObservation', {
    value: () => ({
      version: 1,
      installed,
      dropped,
      observationErrors,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      entries: entries.map((entry) => ({ ...entry })),
      workers: workers.map(({ pending, ...worker }) => ({
        ...worker,
        pending: [...pending.values()].map((entry) => ({ ...entry })),
      })),
    }),
    configurable: true,
  })
  for (const type of ['visibilitychange', 'freeze', 'resume'])
    document.addEventListener(type, () => safely(() => record({ event: type })))
  for (const type of ['focus', 'blur', 'pageshow', 'pagehide'])
    window.addEventListener(type, (event) =>
      safely(() =>
        record({
          event: type,
          ...((type === 'pageshow' || type === 'pagehide') && event instanceof PageTransitionEvent
            ? { persisted: event.persisted }
            : {}),
        }),
      ),
    )
  safely(() => {
    const NativeWorker = window.Worker,
      descriptor = Object.getOwnPropertyDescriptor(window, 'Worker'),
      post = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'postMessage'),
      terminate = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'terminate')
    if (!descriptor || !post || !terminate) throw new Error('Worker descriptors unavailable')
    Object.defineProperty(NativeWorker.prototype, 'postMessage', {
      ...post,
      value: new Proxy(post.value, {
        apply(target, receiver, args) {
          // Pass the original receiver, arguments, payload and transfer list
          // exactly once. Native return values and throws remain unchanged.
          const result = Reflect.apply(target, receiver, args)
          safely(() => {
            const worker = records.get(receiver)
            if (!worker) return
            const metadata = request(args[0])
            if (metadata.generation !== undefined) worker.generation = metadata.generation
            const generation = metadata.generation ?? worker.generation
            if (metadata.id) {
              if (worker.pending.size < 2048)
                worker.pending.set(metadata.id, {
                  id: metadata.id,
                  operation: metadata.operation,
                  generation,
                })
              else dropped++
            }
            record({ event: 'send', worker: worker.worker, ...metadata, generation })
          })
          return result
        },
      }),
    })
    Object.defineProperty(NativeWorker.prototype, 'terminate', {
      ...terminate,
      value: new Proxy(terminate.value, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args)
          safely(() => {
            const worker = records.get(receiver)
            if (!worker) return
            worker.terminated = true
            record({ event: 'terminate', worker: worker.worker, generation: worker.generation })
          })
          return result
        },
      }),
    })
    Object.defineProperty(window, 'Worker', {
      ...descriptor,
      value: new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          // Reflect preserves subclass/new.target behavior and the native
          // constructor's argument conversion and synchronous exceptions.
          const worker = Reflect.construct(target, args, newTarget)
          safely(() => {
            const info = {
              worker: workers.length + 1,
              terminated: false,
              pending: new Map(),
            }
            workers.push(info)
            records.set(worker, info)
            record({ event: 'construct', worker: info.worker })
            worker.addEventListener('message', (event) =>
              safely(() => {
                const metadata = message(event.data),
                  pending = metadata.id ? info.pending.get(metadata.id) : undefined
                if (metadata.id) info.pending.delete(metadata.id)
                record({
                  event: 'receive',
                  worker: info.worker,
                  ...metadata,
                  operation: pending?.operation,
                  generation: pending?.generation ?? info.generation,
                  state:
                    metadata.type === 'HANDLER' && own(event.data, 'name') === 'throw'
                      ? 'failed'
                      : pending?.operation &&
                          ['initialize', 'mount', 'start', 'stop'].includes(pending.operation)
                        ? state(own(own(event.data, 'value'), 'state'))
                        : undefined,
                })
              }),
            )
            for (const type of ['error', 'messageerror'])
              worker.addEventListener(type, () =>
                safely(() =>
                  record({
                    event: type,
                    worker: info.worker,
                    generation: info.generation,
                  }),
                ),
              )
          })
          return worker
        },
      }),
    })
    installed = true
    record({ event: 'installed' })
  })
})()

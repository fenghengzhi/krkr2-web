import type { Page } from '@playwright/test'
import type { SystemDisplayMetrics, SystemDisplayUpdate } from '../../src/engine/system/display.ts'
import { systemDisplayFiles, systemDisplayScript } from './system-display-script.ts'

interface DisplayEmbedding {
  player: ReturnType<typeof import('../../src/player/create-player.ts').createPlayer>
  root: HTMLElement
  desktop: HTMLElement
  errors: string[]
}
interface DisplayPacket {
  worker: number
  generation: number
  update: SystemDisplayUpdate
}
interface DisplayObservation {
  packets: DisplayPacket[]
  activeObserverTargets: string[][]
  scopedObserverTargets: Array<{ owner: string; targets: string[] }>
}
declare global {
  interface Window {
    systemDisplayEmbeddings?: DisplayEmbedding[]
    systemDisplayObservation(): DisplayObservation
    systemDisplayObserverScope(owner?: string): void
    sendRawSystemDisplay(
      worker: number,
      generation: number,
      update: SystemDisplayUpdate,
    ): Promise<string>
  }
}

/** Observe actual host calls; no Worker, DOM dimension or resize callback is simulated. */
export async function observeSystemDisplay(page: Page) {
  await page.addInitScript(() => {
    const workers: Worker[] = [],
      packets: DisplayPacket[] = [],
      templates = new Map<
        Worker,
        {
          id: string
          argumentList: { type: string; value: unknown }[]
        }
      >(),
      targets = new Map<ResizeObserver, Set<Element>>(),
      owners = new Map<ResizeObserver, string>(),
      NativeWorker = window.Worker,
      nativePost = NativeWorker.prototype.postMessage,
      nativeObserve = ResizeObserver.prototype.observe,
      nativeUnobserve = ResizeObserver.prototype.unobserve,
      nativeDisconnect = ResizeObserver.prototype.disconnect
    let owner: string | undefined
    window.systemDisplayObserverScope = (value) => { owner = value }
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker
        workers.push(worker)
        return worker
      },
    })
    NativeWorker.prototype.postMessage = new Proxy(nativePost, {
      apply(target, receiver: Worker, args) {
        const result = Reflect.apply(target, receiver, args),
          packet = args[0] as { type?: string; argumentList?: { type: string; value: unknown }[] },
          list = packet?.argumentList
        if (packet?.type === 'APPLY' && list?.[0]?.value === 'setSystemDisplay') {
          templates.set(receiver, structuredClone(args[0]))
          packets.push({
            worker: workers.indexOf(receiver),
            generation: list[1]!.value as number,
            update: structuredClone(list[2]!.value as SystemDisplayUpdate),
          })
        }
        return result
      },
    })
    ResizeObserver.prototype.observe = new Proxy(nativeObserve, {
      apply(target, receiver: ResizeObserver, args) {
        const result = Reflect.apply(target, receiver, args),
          observed = targets.get(receiver) ?? new Set<Element>()
        observed.add(args[0] as Element)
        targets.set(receiver, observed)
        if (owner !== undefined) owners.set(receiver, owner)
        return result
      },
    })
    ResizeObserver.prototype.unobserve = new Proxy(nativeUnobserve, {
      apply(target, receiver: ResizeObserver, args) {
        const result = Reflect.apply(target, receiver, args)
        targets.get(receiver)?.delete(args[0] as Element)
        return result
      },
    })
    ResizeObserver.prototype.disconnect = new Proxy(nativeDisconnect, {
      apply(target, receiver: ResizeObserver, args) {
        const result = Reflect.apply(target, receiver, args)
        targets.get(receiver)?.clear()
        return result
      },
    })
    window.systemDisplayObservation = () => ({
      packets: structuredClone(packets),
      activeObserverTargets: [...targets.values()]
        .filter((set) => set.size > 0)
        .map((set) => [...set].map((element) => element.id)),
      scopedObserverTargets: [...targets]
        .filter(([observer, set]) => owners.has(observer) && set.size > 0)
        .map(([observer, set]) => ({ owner: owners.get(observer)!, targets: [...set].map((element) => element.id) })),
    })
    // Replay the observed RPC envelope only for the explicit stale-generation
    // and stale-revision fixtures. Native Worker dispatch and acknowledgments
    // remain real, and the fixture waits for each acknowledgment before reading.
    window.sendRawSystemDisplay = (workerIndex, generation, update) => {
      const worker = workers[workerIndex]!,
        template = templates.get(worker)
      if (!template) throw new Error('No real setSystemDisplay envelope was observed')
      const packet = structuredClone(template)
      packet.id = crypto.randomUUID()
      packet.argumentList[1] = { type: 'RAW', value: generation }
      packet.argumentList[2] = { type: 'RAW', value: update }
      return new Promise<string>((resolve, reject) => {
        const receive = (event: MessageEvent<{ id?: string; type?: string; name?: string }>) => {
            if (event.data.id !== packet.id) return
            worker.removeEventListener('message', receive)
            clearTimeout(timer)
            if (event.data.type === 'HANDLER')
              reject(new Error('Raw display RPC rejected: ' + event.data.name))
            else resolve(event.data.type ?? 'missing')
          },
          timer = setTimeout(() => {
            worker.removeEventListener('message', receive)
            reject(new Error('Raw display RPC did not acknowledge'))
          }, 10000)
        worker.addEventListener('message', receive)
        worker.postMessage(packet)
      })
    }
  })
}

export async function startSystemDisplayPlayers(
  page: Page,
  entry: string,
  backend: 'asyncify' | 'jspi',
  binary: boolean,
  configurations: { explicitDesktop?: boolean; metrics?: SystemDisplayMetrics }[],
) {
  const files = systemDisplayFiles(
    binary,
    systemDisplayScript +
      `
var sdWindow=new Window();sdWindow.setInnerSize(96,64);sdWindow.visible=true;
Debug.message("system-display:ready");
`,
  )
  return page.evaluate(
    async ({ entry, backend, configurations, files }) => {
      const { createPlayer, createGameWindows } = (await import(entry)) as {
          createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
          createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
        },
        results = []
      window.systemDisplayEmbeddings ??= []
      for (const configuration of configurations) {
        const index = window.systemDisplayEmbeddings.length,
          root = document.createElement('main'),
          initialParent = document.createElement('section'),
          canvas = document.createElement('canvas'),
          errors: string[] = []
        root.id = `system-display-player-${index}`
        root.style.cssText = `width:${430 + index * 23}px;height:${281 + index * 13}px;position:relative;margin:17px;padding:7px;`
        initialParent.id = `system-display-parent-${index}`
        initialParent.style.cssText = `width:${301 + index * 19}px;height:${173 + index * 11}px;position:relative;`
        initialParent.append(canvas)
        root.append(initialParent)
        document.body.append(root)
        const desktop = configuration.explicitDesktop ? root : initialParent,
          supplied = configuration.metrics ? { ...configuration.metrics } : undefined
        let reads = 0,
          configured = supplied
        const options: import('../../src/player/create-player.ts').PlayerOptions = {
            windows: createGameWindows(desktop, canvas, () => {}),
            ...(configuration.explicitDesktop ? { desktopElement: desktop } : {}),
            get systemDisplay() {
              reads++
              if (reads > 1) throw new Error('Player reread the display option')
              return configured
            },
            set systemDisplay(value) {
              configured = value
            },
            onError: (error) => errors.push(String(error)),
          }
        // Observe synchronous Player construction separately from later Window
        // surface observers. Fixed System metrics forbid display observers,
        // while live game chrome still requires its own ResizeObservers.
        window.systemDisplayObserverScope(`player:${index}`)
        let player: ReturnType<typeof createPlayer>
        try { player = createPlayer(canvas, () => {}, () => {}, false, options) }
        finally { window.systemDisplayObserverScope() }
        const displayObservers = window.systemDisplayObservation().scopedObserverTargets
          .filter((entry) => entry.owner === `player:${index}`).length
        window.systemDisplayEmbeddings.push({ player, root, desktop, errors })
        if (supplied) {
          supplied.screenWidth = 7
          supplied.desktopLeft = 8
          supplied.desktopWidth = 9
          options.systemDisplay = { ...supplied }
        }
        options.desktopElement = document.body
        const loaded = await player.load(
          Object.entries(files).map(([path, source]) => ({ path, blob: new Blob([source]) })),
          'startup.tjs',
          backend,
        )
        results.push({
          index,
          backend: loaded.backend,
          generation: player.session.generation,
          checks: await player.session.evaluate('sdChecks'),
          initial: await player.session.evaluate('sdInitial'),
          actual: await player.session.evaluate('systemDisplayValues()'),
          saved: (await player.session.exportSaves()).map(({ path, bytes }) => ({
            path,
            header: Array.from(bytes.subarray(0, 4)),
          })),
          reads,
          displayObservers,
          canvasReparented: canvas.parentElement !== initialParent,
          errors: [...errors],
        })
      }
      return results
    },
    { entry, backend, configurations, files },
  )
}

/** Independent DOM oracle: never calls or imports the production geometry sampler. */
export function readSystemDisplayDom(page: Page, index: number, fullscreen = false) {
  return page.evaluate(
    ({ index, fullscreen }) => {
      const desktop = window.systemDisplayEmbeddings![index]!.desktop,
        width = fullscreen ? window.innerWidth : desktop.clientWidth,
        height = fullscreen ? window.innerHeight : desktop.clientHeight
      return {
        screenWidth: width,
        screenHeight: height,
        desktopLeft: 0,
        desktopTop: 0,
        desktopWidth: width,
        desktopHeight: height,
      }
    },
    { index, fullscreen },
  )
}

export function readSystemDisplay(page: Page, index: number) {
  return page.evaluate(
    (index) =>
      window.systemDisplayEmbeddings![index]!.player.session.evaluate('systemDisplayValues()'),
    index,
  )
}

export function stopSystemDisplayPlayers(page: Page) {
  return page.evaluate(async () => {
    const results = []
    for (const { player, root, errors } of window.systemDisplayEmbeddings ?? []) {
      await player.stop()
      results.push({
        disposed: player.session.isDisposed,
        liveWindows: root.querySelectorAll('.game-window').length,
        errors: [...errors],
      })
      root.remove()
    }
    delete window.systemDisplayEmbeddings
    return results
  })
}

export function rejectInvalidSystemDisplayPlayers(page: Page, entry: string) {
  return page.evaluate(async (entry) => {
    const { createPlayer, createGameWindows } = (await import(entry)) as {
        createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
        createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
      },
      valid = {
        screenWidth: 600,
        screenHeight: 400,
        desktopLeft: 0,
        desktopTop: 0,
        desktopWidth: 320,
        desktopHeight: 200,
      },
      cases: [string, unknown][] = [
        ['null', null],
        ['empty', {}],
        ['missing', { ...valid, desktopHeight: undefined }],
        ['negative size', { ...valid, screenWidth: -1 }],
        ['fraction', { ...valid, desktopWidth: 1.5 }],
        ['nan', { ...valid, screenHeight: NaN }],
        ['infinity', { ...valid, desktopTop: Infinity }],
        ['string', { ...valid, desktopLeft: '12' }],
        ['overflow', { ...valid, screenHeight: 2147483648 }],
        ['underflow', { ...valid, desktopLeft: -2147483649 }],
      ],
      results = []
    const desktopCases: [string, unknown][] = [
      ['desktop impostor', { ownerDocument: document }],
      ['desktop SVG', document.createElementNS('http://www.w3.org/2000/svg', 'svg')],
      [
        'desktop other document',
        document.implementation.createHTMLDocument('foreign').createElement('main'),
      ],
    ]
    const configurations = [
      ...cases.map(([name, metrics]) => ({ name, metrics, desktop: undefined })),
      ...desktopCases.map(([name, desktop]) => ({ name, metrics: valid, desktop })),
    ]
    for (const { name, metrics, desktop } of configurations) {
      const root = document.createElement('main'),
        canvas = document.createElement('canvas')
      root.append(canvas)
      document.body.append(root)
      const windows = createGameWindows(root, canvas, () => {}),
        before = structuredClone(window.systemEmbeddingCounters)
      let player: ReturnType<typeof createPlayer> | undefined,
        error: string | null = null
      try {
        player = createPlayer(
          canvas,
          () => {},
          () => {},
          false,
          {
            windows,
            systemDisplay: metrics as SystemDisplayMetrics,
            ...(desktop === undefined ? {} : { desktopElement: desktop as HTMLElement }),
          },
        )
      } catch (caught) {
        error = String(caught)
      } finally {
        await player?.stop()
        windows.dispose()
        root.remove()
      }
      results.push({
        name,
        error,
        constructed: !!player,
        before,
        after: structuredClone(window.systemEmbeddingCounters),
      })
    }
    return results
  }, entry)
}

/** A scoped fault in the second native observer admission checks partial setup cleanup. */
export function rejectSystemDisplayObserverFailure(page: Page, entry: string) {
  return page.evaluate(async (entry) => {
    const { createPlayer, createGameWindows } = (await import(entry)) as {
        createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
        createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
      },
      root = document.createElement('main'),
      canvas = document.createElement('canvas'),
      NativeObserver = window.ResizeObserver,
      nativeObserve = NativeObserver.prototype.observe,
      nativeDisconnect = NativeObserver.prototype.disconnect,
      observers: ResizeObserver[] = [],
      disconnected = new Set<ResizeObserver>(),
      errors: string[] = []
    root.style.cssText = 'width:320px;height:200px;position:relative;'
    root.append(canvas)
    document.body.append(root)
    const windows = createGameWindows(root, canvas, () => {}),
      before = structuredClone(window.systemEmbeddingCounters)
    let admissions = 0,
      error: string | null = null,
      player: ReturnType<typeof createPlayer> | undefined,
      disposeComplete!: () => void,
      disposed = false
    const cleanup = new Promise<void>((resolve) => {
      disposeComplete = resolve
    })
    window.ResizeObserver = new Proxy(NativeObserver, {
      construct(target, args, newTarget) {
        const observer = Reflect.construct(target, args, newTarget) as ResizeObserver
        observers.push(observer)
        return observer
      },
    })
    NativeObserver.prototype.observe = new Proxy(nativeObserve, {
      apply(target, receiver: ResizeObserver, args) {
        if (args[0] === root && observers.includes(receiver) && ++admissions === 2)
          throw new Error('synthetic system display second observe failure')
        return Reflect.apply(target, receiver, args)
      },
    })
    NativeObserver.prototype.disconnect = new Proxy(nativeDisconnect, {
      apply(target, receiver: ResizeObserver, args) {
        const result = Reflect.apply(target, receiver, args)
        if (observers.includes(receiver)) disconnected.add(receiver)
        return result
      },
    })
    try {
      player = createPlayer(
        canvas,
        () => {},
        () => {},
        false,
        {
          windows: {
            ...windows,
            dispose() {
              windows.dispose()
              disposed = true
              disposeComplete()
            },
          },
          onError: (error) => errors.push(String(error)),
        },
      )
    } catch (caught) {
      error = String(caught)
    } finally {
      window.ResizeObserver = NativeObserver
      NativeObserver.prototype.observe = nativeObserve
      NativeObserver.prototype.disconnect = nativeDisconnect
      try {
        await player?.stop()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            cleanup,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Partial Player cleanup did not dispose its window host')),
                10000,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      } finally {
        windows.dispose()
        root.remove()
      }
    }
    return {
      error,
      constructed: !!player,
      admissions,
      createdObservers: observers.length,
      disconnectedObservers: disconnected.size,
      disposed,
      errors,
      before,
      after: structuredClone(window.systemEmbeddingCounters),
    }
  }, entry)
}

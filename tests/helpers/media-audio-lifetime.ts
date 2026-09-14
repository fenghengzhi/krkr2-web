import { WebAudioHost } from '../../src/backends/audio/web/host.ts'
import type { AudioState } from '../../src/protocol/audio.ts'

export type MediaAudioFault = 'create' | 'connect' | 'disconnect'
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}

/** Exercise the real media graph builder against a controlled browser audio API. */
async function graph(fault: MediaAudioFault, at: number) {
  const channel = new MessageChannel(),
    states: AudioState[] = [],
    nodes: NodeRecord[] = [],
    intervals = new Set<ReturnType<typeof setInterval>>()
  let creations = 0,
    connects = 0,
    contextCloses = 0
  class NodeRecord {
    disconnects = 0
    connections = new Set<unknown>()
    gain = { value: 1 }
    channelCount = 0
    channelCountMode = 'max'
    fftSize = 0
    constructor(
      readonly kind: string,
      readonly index: number,
    ) {}
    connect(destination: unknown) {
      connects++
      if (fault === 'connect' && connects === at) throw new Error('media-connect-primary')
      this.connections.add(destination)
      return destination as NodeRecord
    }
    disconnect() {
      this.disconnects++
      this.connections.clear()
      if (fault === 'disconnect' && this.index === at) throw new Error('media-disconnect-primary')
    }
    getFloatTimeDomainData(bytes: Float32Array) {
      bytes.fill(0)
    }
  }
  class Context {
    state: AudioContextState = 'running'
    onstatechange: (() => void) | null = null
    destination = {}
    async resume() {}
    async close() {
      contextCloses++
      this.state = 'closed'
      if (fault === 'disconnect' && at) throw new Error('context-close-secondary')
    }
    private create(kind: string) {
      creations++
      if (fault === 'create' && creations === at) throw new Error('media-create-primary')
      const node = new NodeRecord(kind, creations)
      nodes.push(node)
      return node
    }
    createMediaElementSource() {
      return this.create('source')
    }
    createGain() {
      return this.create('gain')
    }
    createChannelSplitter() {
      return this.create('split')
    }
    createChannelMerger() {
      return this.create('merge')
    }
    createAnalyser() {
      return this.create('analyser')
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(window, 'AudioContext'),
    setTimer = globalThis.setInterval,
    clearTimer = globalThis.clearInterval
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: Context })
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = setTimer(...args)
    intervals.add(timer)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    intervals.delete(timer)
    clearTimer(timer)
  }) as typeof clearInterval
  let host: WebAudioHost | undefined, error: unknown
  try {
    host = new WebAudioHost(channel.port1, (state) => states.push(state))
    try {
      const first = host.connectMedia(document.createElement('video'))
      first.set(50000, -25000)
      if (fault === 'disconnect') host.connectMedia(document.createElement('video'))
    } catch (caught) {
      error = caught
    }
    if (at && fault !== 'disconnect') {
      check(
        String(error).includes(`media-${fault}-primary`),
        'Media construction did not preserve its error',
      )
      check(intervals.size === 0, 'Failed media graph retained its peak timer')
    } else check(!error, 'Media graph failed before the selected cleanup boundary')
    let closeError: unknown
    const firstClose = host.close(),
      secondClose = host.close()
    check(firstClose === secondClose, 'Audio shutdown did not share its result')
    try {
      await firstClose
    } catch (caught) {
      closeError = caught
    }
    try {
      await secondClose
    } catch {}
    if (fault === 'disconnect' && at)
      check(
        String(closeError).includes('media-disconnect-primary'),
        'Later context close replaced the first media error',
      )
    else check(!closeError, 'Unexpected graph shutdown error')
    check(
      nodes.every((node) => node.disconnects === 1 && node.connections.size === 0),
      'A created audio node was skipped or disconnected twice',
    )
    check(contextCloses === 1 && intervals.size === 0, 'Audio context or timers survived shutdown')
    check(states.at(-1)?.state === 'closed', 'Audio host did not publish its terminal state')
    return {
      fault,
      at,
      creations,
      connects,
      contextCloses,
      intervals: intervals.size,
      nodes: nodes.map((node) => ({
        kind: node.kind,
        index: node.index,
        disconnects: node.disconnects,
        connections: node.connections.size,
      })),
      error: error ? String(error) : null,
      closeError: closeError ? String(closeError) : null,
    }
  } finally {
    await host?.close().catch(() => {})
    for (const timer of intervals) clearTimer(timer)
    globalThis.setInterval = setTimer
    globalThis.clearInterval = clearTimer
    if (descriptor) Object.defineProperty(window, 'AudioContext', descriptor)
    else Reflect.deleteProperty(window, 'AudioContext')
    channel.port1.close()
    channel.port2.close()
  }
}

export async function exerciseMediaAudioLifetime(fault: MediaAudioFault) {
  const control = await graph(fault, 0),
    results = []
  const count = fault === 'connect' ? control.connects : control.creations
  for (let at = 1; at <= count; at++) results.push(await graph(fault, at))
  return { device: 'controlled Web Audio API', fault, control, results }
}

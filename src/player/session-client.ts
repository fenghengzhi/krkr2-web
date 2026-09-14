import { createRpcClient, type RpcClient } from 'vite-plugin-worker-rpc/runtime'
import { transfer } from 'vite-plugin-worker-rpc/client'
import type { SaveFile } from '../engine/ports/saves.ts'
import type { InputPacket } from '../engine/ports/input.ts'
import type { FontDescriptor } from '../engine/ports/fonts.ts'
import type { DebugPanel } from '../engine/diagnostics/panels.ts'
import { wasmManifestFile } from './build-info.ts'
import { initialActivity, type ActivityState } from '../engine/ports/activity.ts'
import {
  PROTOCOL_VERSION,
  type BackendPreference,
  type GameInput,
  type SessionApi,
  type SessionEvent,
} from '../protocol/session.ts'

let nextGeneration = 1
export class SessionClient {
  private readonly rpc: RpcClient
  private readonly generation = nextGeneration++
  private readonly channel = new MessageChannel()
  private lastSequence = 0
  private disposed = false
  private initialized = false
  private activity = initialActivity()
  private systemFonts: FontDescriptor[] = []
  constructor(onEvent: (event: SessionEvent) => void) {
    this.rpc = createRpcClient(
      () =>
        new Worker(new URL('../workers/session.worker.ts', import.meta.url), {
          type: 'module',
          name: `krkr2-session-${this.generation}`,
        }),
      { pool: 1 },
    )
    this.channel.port1.onmessage = (message: MessageEvent<SessionEvent>) => {
      const event = message.data
      if (
        this.disposed ||
        event.generation !== this.generation ||
        event.sequence <= this.lastSequence
      )
        return
      this.lastSequence = event.sequence
      onEvent(event)
    }
  }
  private call<K extends keyof SessionApi>(
    method: K,
    ...args: Parameters<SessionApi[K]>
  ): ReturnType<SessionApi[K]> {
    if (this.disposed)
      return Promise.reject(new Error('Session client is disposed')) as ReturnType<SessionApi[K]>
    return this.rpc.call(method, args) as ReturnType<SessionApi[K]>
  }
  async initialize(
    canvas: HTMLCanvasElement,
    backend: BackendPreference,
    gameId: string,
    audio: MessagePort,
    video: MessagePort,
  ) {
    const offscreen = canvas.transferControlToOffscreen()
    const request = {
      version: PROTOCOL_VERSION,
      generation: this.generation,
      canvas: offscreen,
      events: this.channel.port2,
      manifestUrl: new URL(wasmManifestFile, document.baseURI).href,
      backend,
      gameId,
      audio,
      video,
      activity: this.activity,
      systemFonts: this.systemFonts,
    }
    const snapshot = await this.call(
      'initialize',
      transfer(request, [offscreen, this.channel.port2, audio, video]),
    )
    this.initialized = true
    if (this.systemFonts !== request.systemFonts)
      await this.call('setSystemFonts', this.systemFonts)
    if (this.activity.sequence > request.activity.sequence)
      return this.call('setActivity', this.activity)
    return snapshot
  }
  setActivity(activity: ActivityState): Promise<unknown> {
    if (this.disposed) return Promise.resolve()
    this.activity = { ...activity }
    return this.initialized ? this.call('setActivity', this.activity) : Promise.resolve()
  }
  prepare(files: GameInput) {
    return this.call('prepare', files)
  }
  mount() {
    return this.call('mount')
  }
  start(entry = 'startup.tjs') {
    return this.call('start', entry)
  }
  evaluate(source: string) {
    return this.call('evaluate', source)
  }
  pause() {
    return this.call('pause')
  }
  resume() {
    return this.call('resume')
  }
  retryGraphics() {
    return this.call('retryGraphics')
  }
  click(x: number, y: number) {
    return this.call('click', x, y)
  }
  pointerMove(x: number, y: number) {
    return this.call('pointerMove', x, y)
  }
  pointerState(x: number, y: number) {
    if (!this.initialized) return Promise.resolve()
    return this.call('pointerState', x, y)
  }
  input(packet: InputPacket) {
    if (!this.initialized) return Promise.resolve()
    return this.call('input', packet)
  }
  keyState(keys: number[]) {
    if (!this.initialized) return Promise.resolve()
    return this.call('keyState', keys)
  }
  exitFullScreen() {
    return this.call('exitFullScreen')
  }
  menuClick(id: number) {
    return this.call('menuClick', id)
  }
  menuDismiss() {
    return this.call('menuDismiss')
  }
  setDebugVisibility(panel: DebugPanel, visible: boolean) {
    return this.call('setDebugVisibility', panel, visible)
  }
  setSystemFonts(fonts: FontDescriptor[]) {
    this.systemFonts = fonts
    return this.initialized ? this.call('setSystemFonts', fonts) : Promise.resolve()
  }
  selectFont(id: number, face: string | null) {
    return this.call('selectFont', id, face)
  }
  previewFont(id: number, face: string, kind: 'sample' | 'label' = 'sample') {
    return this.call('previewFont', id, face, kind)
  }
  inspect() {
    return this.call('inspect')
  }
  exportSaves() {
    return this.call('exportSaves')
  }
  importSaves(files: SaveFile[]) {
    return this.call('importSaves', files)
  }
  get isDisposed(): boolean {
    return this.disposed
  }
  async stop(): Promise<void> {
    if (this.disposed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.call('stop'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.dispose()
            reject(new Error('Worker did not stop in time and was terminated'))
          }, 2000)
        }),
      ])
      this.dispose()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rpc.dispose()
    this.channel.port1.close()
    this.channel.port2.close()
  }
}

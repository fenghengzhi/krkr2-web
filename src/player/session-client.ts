import type { PadMessage } from '../protocol/pad.ts'
import type { WindowMoveMessage } from '../engine/ports/window-move.ts'
import type { WindowPopupMessage } from '../engine/ports/window-popup.ts'
import { copySystemDisplayUpdate, type SystemDisplayUpdate } from '../engine/system/display.ts'
import { createRpcClient, type RpcClient } from 'vite-plugin-worker-rpc/runtime'
import { transfer } from 'vite-plugin-worker-rpc/client'
import type { SaveFile } from '../engine/ports/saves.ts'
import type { InputPacket } from '../engine/ports/input.ts'
import type { FontDescriptor } from '../engine/ports/fonts.ts'
import type { DebugPanel } from '../engine/diagnostics/panels.ts'
import type { MenuPopupIdentity } from '../engine/scene/menus.ts'
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
  readonly generation = nextGeneration++
  private readonly channel = new MessageChannel()
  private lastSequence = 0
  private disposed = false
  private initialized = false
  private activity = initialActivity()
  private systemFonts: FontDescriptor[] = []
  private systemDisplay?: SystemDisplayUpdate
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
    surfaces: MessagePort,
    backend: BackendPreference,
    gameId: string,
    audio: MessagePort,
    video: MessagePort,
    debugMode = false,
    clipboard?: MessagePort,
    dataPath?: string,
    systemColors?: readonly number[],
    help?: MessagePort,
    windowMoveSupported = false,
  ) {
    const request = {
      version: PROTOCOL_VERSION,
      generation: this.generation,
      surfaces,
      events: this.channel.port2,
      manifestUrl: new URL(wasmManifestFile, document.baseURI).href,
      backend,
      debugMode,
      gameId,
      audio,
      video,
      clipboard,
      help,
      windowMoveSupported,
      dataPath,
      systemColors,
      systemDisplay: this.systemDisplay?.metrics,
      activity: this.activity,
      systemFonts: this.systemFonts,
    }
    const snapshot = await this.call(
      'initialize',
      transfer(request, [
        surfaces,
        this.channel.port2,
        audio,
        video,
        ...(clipboard ? [clipboard] : []),
        ...(help ? [help] : []),
      ]),
    )
    this.initialized = true
    // Initialization carries dimensions, while this ordered update also
    // establishes the source revision and catches layout changes during load.
    if (this.systemDisplay) await this.call('setSystemDisplay', this.generation, this.systemDisplay)
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
  setSystemDisplay(update: SystemDisplayUpdate): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const next = copySystemDisplayUpdate(update)
    if (this.systemDisplay && next.revision <= this.systemDisplay.revision) return Promise.resolve()
    this.systemDisplay = next
    return this.initialized
      ? this.call('setSystemDisplay', this.generation, next)
      : Promise.resolve()
  }
  padFont(id: number, epoch: number) {
    return this.call('padFont', this.generation, id, epoch)
  }
  pad(message: PadMessage) {
    if (message.generation !== this.generation)
      return Promise.resolve({ status: 'ignored' as const })
    return this.call('pad', message)
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
  pointerState(x: number, y: number, windowId?: number, pointerSequence?: number) {
    if (!this.initialized) return Promise.resolve()
    return this.call('pointerState', x, y, windowId, pointerSequence)
  }
  /** Browser send queues await admission only; callback completion stays in the Worker. */
  async input(packet: InputPacket): Promise<void> {
    if (!this.initialized) return
    await this.call('input', packet)
  }
  keyState(keys: number[]) {
    if (!this.initialized) return Promise.resolve()
    return this.call('keyState', keys)
  }
  exitFullScreen(windowId?: number) {
    return this.call('exitFullScreen', windowId)
  }
  async activateWindow(windowId: number): Promise<void> {
    await this.call('activateWindow', windowId)
  }
  async closeWindow(windowId: number): Promise<void> {
    await this.call('closeWindow', windowId)
  }
  moveWindow(windowId: number, left: number, top: number) {
    return this.call('moveWindow', windowId, left, top)
  }
  windowMove(message: WindowMoveMessage) {
    return this.call('windowMove', message)
  }
  async windowPopup(message: WindowPopupMessage): Promise<void> {
    if (!this.initialized) return
    await this.call('windowPopup', message)
  }
  resizeWindow(windowId: number, width: number, height: number) {
    return this.call('resizeWindow', windowId, width, height)
  }
  async menuClick(id: number, popup?: MenuPopupIdentity): Promise<void> {
    await this.call('menuClick', id, popup)
  }
  menuDismiss(popup?: MenuPopupIdentity) {
    return this.call('menuDismiss', popup)
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
  selectSystemDialog(id: number, value: string | null) {
    return this.call('selectSystemDialog', id, value)
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
    const timeout = new Error('Worker did not stop in time and was terminated')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.call('stop'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // RPC disposal synchronously rejects pending calls, including Stop.
            // Settle this race with the actual timeout reason before cleanup.
            reject(timeout)
          }, 2000)
        }),
      ])
      this.dispose()
    } catch (error) {
      if (error === timeout) {
        try {
          this.dispose()
        } catch (cleanup) {
          throw new AggregateError([timeout, cleanup], timeout.message, { cause: timeout })
        }
      }
      // A real Stop failure can be retried, for example after saving failed.
      throw error
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

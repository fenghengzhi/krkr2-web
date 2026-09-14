import {
  emptyVideoSnapshot,
  type VideoBackend,
  type VideoCommand,
  type VideoEvent,
  type VideoResult,
  type VideoSnapshot,
} from '../../src/engine/ports/video.ts'
import { soundGate } from './sound-lifetime-audio.ts'
export { soundGate as videoGate } from './sound-lifetime-audio.ts'

/** The fake owns independent resources, including before a failed open returns. */
export class LifetimeVideoBackend implements VideoBackend {
  readonly movies = new Map<number, VideoSnapshot>()
  readonly commands: { op: string; id?: number }[] = []
  readonly closedIds: number[] = []
  readonly listeners = new Set<(event: VideoEvent) => void | Promise<void>>()
  terminalCloses = 0
  nextOpen?: ReturnType<typeof soundGate>
  nextClose?: ReturnType<typeof soundGate>
  failOpen?: Error
  failClose?: Error
  failShutdown?: Error
  listen(listener: (event: VideoEvent) => void | Promise<void>) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  onlyId(): number {
    if (this.movies.size !== 1) throw new Error('Expected one video resource')
    return this.movies.keys().next().value!
  }
  async emit(id: number, type: 'frame' | 'period' | 'ended'): Promise<void> {
    const current = this.movies.get(id)
    if (!current) throw new Error('Cannot emit an unknown movie')
    const snapshot = { ...current, frame: 2 }
    if (type === 'ended') snapshot.status = 'stop'
    this.movies.set(id, snapshot)
    await Promise.all(
      [...this.listeners].map((listener) =>
        listener({
          type,
          id,
          epoch: snapshot.epoch,
          snapshot,
          reason: 1,
          ...(type === 'frame'
            ? { pixels: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) } }
            : {}),
        }),
      ),
    )
  }
  async command(command: VideoCommand): Promise<VideoResult> {
    this.commands.push('id' in command ? { op: command.op, id: command.id } : { op: command.op })
    if (command.op === 'open') {
      const snapshot: VideoSnapshot = {
        ...emptyVideoSnapshot(command.id, command.epoch),
        ...command.settings,
        status: 'stop',
        originalWidth: 1,
        originalHeight: 1,
        totalTime: 100,
        fps: 30,
        numberOfFrame: 3,
      }
      this.movies.set(command.id, snapshot)
      const gate = this.nextOpen
      this.nextOpen = undefined
      await gate?.wait()
      const error = this.failOpen
      this.failOpen = undefined
      if (error) throw error
      return { snapshot: { ...snapshot }, events: [] }
    }
    if (command.op === 'close') {
      const gate = this.nextClose
      this.nextClose = undefined
      await gate?.wait()
      this.movies.delete(command.id)
      this.closedIds.push(command.id)
      const error = this.failClose
      this.failClose = undefined
      if (error) throw error
      return { events: [] }
    }
    if (command.op === 'cancel') {
      this.movies.clear()
      return { events: [] }
    }
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'pauseAll') return { events: [] }
    const snapshot = this.movies.get(command.id)
    if (!snapshot) throw new Error('Command accessed a closed video')
    snapshot.epoch = command.epoch
    if (command.op === 'play' || command.op === 'stop' || command.op === 'pause')
      snapshot.status = command.op
    else if (command.op === 'set') Object.assign(snapshot, command.settings)
    else if (command.op === 'seek') snapshot.frame = command.frame ?? 0
    else if (command.op === 'rewind') snapshot.frame = 0
    else if (command.op === 'prepare') snapshot.status = 'pause'
    return { snapshot: { ...snapshot }, events: [] }
  }
  async close(): Promise<void> {
    this.terminalCloses++
    this.movies.clear()
    this.listeners.clear()
    const error = this.failShutdown
    this.failShutdown = undefined
    if (error) throw error
  }
}

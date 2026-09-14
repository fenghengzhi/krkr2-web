import {
  defaultSoundSettings,
  type AudioBackend,
  type AudioCommand,
  type AudioEvent,
  type AudioResult,
  type SoundEvent,
  type SoundSnapshot,
} from '../../src/engine/ports/audio.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function soundGate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    async wait() {
      enter()
      await held
    },
  }
}

/** Resource-owning fake, deliberately independent of SoundService's bookkeeping. */
export class LifetimeAudioBackend implements AudioBackend {
  readonly voices = new Map<number, SoundSnapshot>()
  readonly commands: { op: AudioCommand['op']; id?: number }[] = []
  readonly closedIds: number[] = []
  readonly listeners = new Set<(event: AudioEvent) => void>()
  terminalCloses = 0
  nextClose?: ReturnType<typeof soundGate>
  nextOpen?: ReturnType<typeof soundGate>
  failOpen?: Error
  failClose?: Error
  private epoch = 0

  listen(callback: (event: AudioEvent) => void) {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  private copy(snapshot: SoundSnapshot): SoundSnapshot {
    return { ...snapshot, flags: [...snapshot.flags] }
  }
  onlyId(): number {
    assert(this.voices.size === 1, 'Expected exactly one backend resource')
    return this.voices.keys().next().value!
  }
  event(id: number, type: SoundEvent['type'], label = 'cue'): SoundEvent {
    const current = this.voices.get(id)
    assert(current, 'Cannot synthesize an event for an unknown voice')
    const snapshot = this.copy(current)
    if (type === 'ended') snapshot.status = 'stop'
    if (type === 'fade') snapshot.fading = false
    return { id, epoch: snapshot.epoch, type, label, snapshot }
  }
  emit(event: AudioEvent): void {
    if (event.type !== 'error' && this.voices.has(event.id))
      this.voices.set(event.id, this.copy(event.snapshot))
    for (const listener of [...this.listeners]) listener(event)
  }
  async command(command: AudioCommand): Promise<AudioResult> {
    this.commands.push('id' in command ? { op: command.op, id: command.id } : { op: command.op })
    if (command.op === 'open' || command.op === 'create') {
      const opened = command.op === 'open'
      const snapshot: SoundSnapshot = {
        ...defaultSoundSettings(),
        ...command.settings,
        id: command.id,
        epoch: ++this.epoch,
        status: opened ? 'stop' : 'unload',
        fading: false,
        flags: Array(16).fill(0),
        sampleRate: opened ? 1000 : 0,
        sampleCount: opened ? 100 : 0,
        channels: opened ? 1 : 0,
        bits: opened ? 16 : 0,
      }
      // The resource exists before open settles, including when open rejects.
      this.voices.set(command.id, snapshot)
      if (opened) {
        const gate = this.nextOpen
        this.nextOpen = undefined
        await gate?.wait()
        const error = this.failOpen
        this.failOpen = undefined
        if (error) throw error
      }
      return { snapshot: this.copy(snapshot), events: [] }
    }
    if (command.op === 'close') {
      const gate = this.nextClose
      this.nextClose = undefined
      await gate?.wait()
      this.voices.delete(command.id)
      this.closedIds.push(command.id)
      const error = this.failClose
      this.failClose = undefined
      if (error) throw error
      return { events: [] }
    }
    if (!('id' in command)) return { events: [] }
    const snapshot = this.voices.get(command.id)
    assert(snapshot, `${command.op} accessed a closed or unknown voice`)
    if (command.op === 'play' || command.op === 'stop') snapshot.status = command.op
    else if (command.op === 'fade') snapshot.fading = true
    else if (command.op === 'stopFade') snapshot.fading = false
    else if (command.op === 'flag') snapshot.flags[command.index] = command.value
    else if (command.op === 'set') Object.assign(snapshot, { [command.property]: command.value })
    else if (command.op !== 'inspect')
      throw new Error(`Unexpected lifetime audio command: ${command.op}`)
    return { snapshot: this.copy(snapshot), events: [] }
  }
  async close(): Promise<void> {
    this.terminalCloses++
    this.voices.clear()
    this.listeners.clear()
  }
}

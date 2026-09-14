import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import {
  defaultSoundSettings,
  type AudioBackend,
  type AudioCommand,
  type AudioEvent,
  type AudioResult,
  type SoundEvent,
  type SoundSnapshot,
} from '../../src/engine/ports/audio.ts'
import { headless } from './headless.ts'
import { AudioClock } from './audio.ts'

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
    assert.equal(this.voices.size, 1, 'Expected exactly one backend resource')
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

/** Compile class bodies as well as helper functions, keeping definitions across the baseline. */
export async function soundFixture(
  binary: boolean,
  definitions: string,
  overrides: Partial<SessionDependencies> = {},
) {
  const clock = new AudioClock(),
    audio = new LifetimeAudioBackend()
  const harness = await headless(
    {
      'startup.tjs': '',
      'sound-lifetime.tjs': `
var calls=0,finalized=0,completed=0,caught="",receiver="";
try{throw new Exception("warm sound lifetime exception");}catch(e){}
${definitions}
`,
      'tone.wav': new Uint8Array([1, 2, 3, 4]),
      'tone.wav.sli': '#2.00\nLabel {Position=20;Name="cue";}',
      'hold.tjs': 'hold-sound-lifetime-callback',
    },
    { audio, now: () => clock.now, schedule: clock.schedule, ...overrides },
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("sound-lifetime.tjs","savedata/sound-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/sound-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("sound-lifetime.tjs")')
    // Warm the shared native Array/Dictionary classes used by host replies and
    // variadic logging before measuring only the sound instances under test.
    await execute(
      'var warmSound=new WaveSoundBuffer(null);warmSound.status;invalidate warmSound;delete warmSound;',
    )
    assert.equal(await session.evaluate('6*7'), '42')
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    const assertRestored = () => {
      assert.deepEqual(session.inspectOwnership(), baseline)
      assert.equal(session.snapshot().handles, handles)
      assert.equal(audio.voices.size, 0)
      assert.equal(clock.tasks.size, 0)
      assert.equal(session.snapshot().state, 'running')
    }
    const restored = async () => {
      await session.idle()
      // Check before another native entry can mask deferred handle/resource work.
      assertRestored()
      assert.equal(await session.evaluate('6*7'), '42')
      assertRestored()
    }
    const stopped = async () => {
      await session.stop()
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      assert.equal(session.snapshot().handles, 0)
      assert.equal(session.snapshot().state, 'stopped')
      assert.equal(audio.voices.size, 0)
      assert.equal(audio.listeners.size, 0)
      assert.equal(clock.tasks.size, 0)
    }
    return {
      ...harness,
      clock,
      audio,
      execute,
      baseline,
      handles,
      restored,
      assertRestored,
      stopped,
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import { AudioClock } from './audio.ts'
import { LifetimeAudioBackend, soundGate } from './sound-lifetime-audio.ts'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const definitions = `
var calls=0,finalized=0,receiver="",caught="",failSound=false;
try{throw new Exception("warm sound runtime");}catch(e){}
class LifetimeSound extends WaveSoundBuffer {
  var marker="sound-owner";
  function LifetimeSound(){super.WaveSoundBuffer(null);}
  function finalize(){finalized++;if(failSound)throw new Exception("retry-sound");}
}
function replacement(name){receiver=this.marker+":"+name;calls++;}
function makeSound(){global.sound=new LifetimeSound();sound.open("tone.wav");sound.play();}
`

/** Run the real session and both native script backends in every supported browser. */
export async function exerciseSoundLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  binary: boolean,
) {
  const audio = new LifetimeAudioBackend(),
    clock = new AudioClock(),
    logs: string[] = []
  const session = new EngineSession({
    audio,
    now: () => clock.now,
    schedule: clock.schedule,
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary, variant, ...options }),
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    renderer: { present() {}, dispose() {} },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected sound image')
      },
      text: () => {
        throw new Error('Unexpected sound text drawing')
      },
    },
    inflateImage,
    deflateImage,
    decodeScript: readScript,
    readText,
    writeText,
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  const state = () => ({
    ...session.inspectOwnership(),
    handles: session.snapshot().handles,
    voices: audio.voices.size,
    clockTasks: clock.tasks.size,
  })
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  const cases: {
    name: string
    owned: ReturnType<typeof state>
    retired: ReturnType<typeof state>
    result: string
  }[] = []
  let baseline: ReturnType<typeof state> | undefined,
    active = 'initialize'
  let closeGate: ReturnType<typeof soundGate> | undefined
  const restored = async () => {
    await session.idle()
    const value = state()
    check(
      JSON.stringify(value) === JSON.stringify(baseline),
      'Sound resources did not return to baseline: ' + JSON.stringify(value),
    )
    check(session.snapshot().state === 'running', 'Sound ownership stopped the session')
    return value
  }
  try {
    await session.initialize()
    session.mount(
      Object.entries({
        'startup.tjs': '',
        'sound-lifetime.tjs': definitions,
        'tone.wav': new Uint8Array([1, 2, 3, 4]),
        'tone.wav.sli': '#2.00\nLabel {Position=20;Name="cue";}',
      }).map(([name, source]) => {
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source
        return { name, size: bytes.length, read: async () => bytes }
      }),
    )
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("sound-lifetime.tjs","savedata/sound-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/sound-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("sound-lifetime.tjs")')
    await execute(
      'var warmSound=new WaveSoundBuffer(null);warmSound.status;invalidate warmSound;delete warmSound;',
    )
    check((await session.evaluate('6*7')) === '42', 'Sound warmup failed')
    baseline = state()
    const owned = () => {
      const value = state()
      check(
        value.soundSources === baseline!.soundSources + 1 &&
          value.weakOwners === baseline!.weakOwners + 1,
        'Sound registration is not a weak owner',
      )
      check(value.voices === 1, 'Sound backend did not acquire its resource')
      return value
    }

    active = 'implicit-resource-release'
    await execute('makeSound();')
    const first = owned()
    await execute('delete global.sound;')
    const retired = await restored()
    check(
      (await session.evaluate('finalized')) === '1',
      'Implicit sound finalizer did not run once',
    )
    cases.push({ name: active, owned: first, retired, result: '1' })

    active = 'queued-dynamic-member'
    await execute('calls=0;finalized=0;System.eventDisabled=true;makeSound();')
    audio.emit(audio.event(audio.onlyId(), 'label'))
    await execute('sound.onLabel=replacement incontextof sound;delete global.sound;')
    const queued = owned()
    check((await session.evaluate('calls+","+finalized')) === '0,0', 'Queued sound lost its owner')
    await execute('System.eventDisabled=false;')
    const delivered = await restored()
    const result = await session.evaluate('receiver+","+calls+","+finalized')
    check(
      result === 'sound-owner:cue,1,1',
      'Sound delivery did not resolve the dynamic member and retire',
    )
    cases.push({ name: active, owned: queued, retired: delivered, result })

    active = 'flags-labels-filters'
    await execute(
      'finalized=0;makeSound();global.flags=sound.flags;global.labels=sound.labels;global.filters=sound.filters;filters.add(42);',
    )
    const dependent = owned()
    check(dependent.dependents === baseline.dependents + 1, 'Labels did not bind to their owner')
    await execute('sound.open("tone.wav");global.currentLabels=sound.labels;delete global.sound;')
    const external = state()
    check(
      external.soundSources === baseline.soundSources &&
        external.voices === 0 &&
        external.dependents === 0 &&
        external.pendingInvalidations === 0,
      'External sound properties retained a resource or binding',
    )
    const properties = await session.evaluate(
      '(isvalid flags)+","+(isvalid labels)+","+(isvalid currentLabels)+","+(isvalid filters)+","+filters[0]+","+finalized',
    )
    check(properties === '0,0,0,1,42,1', 'Sound property lifetimes differ from their ownership')
    await execute(
      'filters.add(43);delete global.flags;delete global.labels;delete global.currentLabels;delete global.filters;',
    )
    cases.push({ name: active, owned: dependent, retired: await restored(), result: properties })

    active = 'retry-invalidation'
    await execute(
      'finalized=0;failSound=true;makeSound();try{invalidate sound;}catch(e){caught=e.message;}',
    )
    const retry = owned()
    check((await session.evaluate('caught')).includes('retry-sound'), 'Lost failed sound finalizer')
    await execute('failSound=false;invalidate sound;delete global.sound;')
    const retried = await restored()
    check((await session.evaluate('finalized')) === '2', 'Sound invalidation did not retry')
    cases.push({ name: active, owned: retry, retired: retried, result: '2' })

    active = 'await-asynchronous-close'
    await execute('finalized=0;makeSound();')
    closeGate = soundGate()
    audio.nextClose = closeGate
    let settled = false
    const ending = execute('delete global.sound;').then(() => {
      settled = true
    })
    await Promise.race([
      closeGate.entered,
      ending.then(() => {
        throw new Error('Sound close did not wait')
      }),
    ])
    const closing = state()
    check(
      !settled &&
        closing.pendingSoundCloses === 1 &&
        closing.voices === 1 &&
        closing.soundSources === 0,
      'Execution crossed an unfinished sound close',
    )
    closeGate.release()
    await ending
    cases.push({ name: active, owned: closing, retired: await restored(), result: 'closed' })
    check(logs.length === 0, 'Sound lifecycle logged an unexpected error: ' + logs.join('\n'))
    await session.stop()
    const stopped = state()
    check(
      Object.values(stopped).every((value) => value === 0),
      'Sound stop retained ownership',
    )
    check(
      audio.listeners.size === 0 && audio.terminalCloses === 1,
      'Audio backend did not close once',
    )
    return {
      variant,
      binary,
      baseline,
      cases,
      stopped,
      closedIds: audio.closedIds,
      terminalCloses: audio.terminalCloses,
    }
  } catch (error) {
    throw new Error(
      String(error) +
        '; sound observations=' +
        JSON.stringify({ variant, binary, active, baseline, cases, current: state(), logs }),
    )
  } finally {
    closeGate?.release()
    await session.stop()
  }
}

import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { headless } from './headless.ts'
import { AudioClock } from './audio.ts'
import { LifetimeAudioBackend } from './sound-lifetime-audio.ts'
export { soundGate } from './sound-lifetime-audio.ts'

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

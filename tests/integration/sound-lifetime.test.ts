import test from 'node:test'
import assert from 'node:assert/strict'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import { soundFixture, soundGate } from '../helpers/sound-lifetime.ts'

const deadline = { timeout: 60_000 }

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  for (const kind of ['WaveSoundBuffer', 'MIDISoundBuffer', 'CDDASoundBuffer']) {
    for (const activity of ['unopened', 'playing', 'fading'])
      test(
        `${mode}: ${kind} without super.finalize releases ${activity} resources with its last reference`,
        deadline,
        async () => {
          const { session, audio, execute, restored, baseline } = await soundFixture(
            binary,
            `
class SoundOwner extends ${kind} {
  function SoundOwner(){super.${kind}(null);}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();${activity === 'playing' ? 'sound.open("tone.wav");sound.play();' : activity === 'fading' ? 'sound.fade(0,100);' : ''}}
`,
          )
          try {
            await execute('createSound();')
            assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
            assert.equal(session.inspectOwnership().weakOwners, baseline.weakOwners + 1)
            assert.equal(audio.voices.size, activity === 'unopened' ? 0 : 1)
            const late = activity === 'unopened' ? undefined : audio.event(audio.onlyId(), 'ended')
            await execute('delete global.sound;')
            assert.equal(audio.closedIds.length, activity === 'unopened' ? 0 : 1)
            assert.equal(await session.evaluate('finalized+","+calls'), '1,0')
            if (late) audio.emit(late)
            await restored()
          } finally {
            await session.stop()
          }
        },
      )

    test(
      `${mode}: directly calling base ${kind}.finalize leaves the object and backend resource valid`,
      deadline,
      async () => {
        const { session, audio, execute, restored, baseline } = await soundFixture(
          binary,
          `
function createSound(){global.sound=new ${kind}(null);sound.open("tone.wav");}
`,
        )
        try {
          await execute('createSound();sound.finalize();sound.finalize();sound.play();')
          assert.equal(await session.evaluate('(isvalid sound)+","+sound.status'), '1,play')
          assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
          assert.equal(audio.voices.size, 1)
          assert.equal(audio.closedIds.length, 0)
          await execute('invalidate sound;')
          assert.equal(await session.evaluate('isvalid sound'), '0')
          assert.equal(audio.voices.size, 0)
          await execute('delete global.sound;')
          await restored()
        } finally {
          await session.stop()
        }
      },
    )

    test(
      `${mode}: failed ${kind} finalization after super preserves its resource until retry`,
      deadline,
      async () => {
        const { session, audio, execute, restored, baseline } = await soundFixture(
          binary,
          `
class SoundOwner extends ${kind} {
  function SoundOwner(){super.${kind}(null);open("tone.wav");}
  function onLabel(name){calls++;}
  function finalize(){super.finalize();if(++finalized==1)throw new Exception("retry-sound-finalizer");}
}
function createSound(){global.sound=new SoundOwner();}
`,
        )
        try {
          await execute('createSound();try{invalidate sound;}catch(e){caught=e.message;}')
          assert.match(await session.evaluate('caught'), /retry-sound-finalizer/)
          assert.equal(await session.evaluate('(isvalid sound)+","+finalized'), '1,1')
          assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
          assert.equal(audio.closedIds.length, 0)
          audio.emit(audio.event(audio.onlyId(), 'label'))
          await session.idle()
          assert.equal(await session.evaluate('calls'), '1')
          await execute('invalidate sound;delete global.sound;')
          assert.equal(await session.evaluate('finalized'), '2')
          assert.equal(audio.closedIds.length, 1)
          await restored()
        } finally {
          await session.stop()
        }
      },
    )

    test(
      `${mode}: ${kind} construction after open preserves its primary error and closes partial ownership`,
      deadline,
      async () => {
        const { session, audio, execute, restored } = await soundFixture(
          binary,
          `
class SoundOwner extends ${kind} {
  function SoundOwner(){super.${kind}(null);open("tone.wav");throw new Exception("primary-sound-constructor");}
  function finalize(){finalized++;throw new Exception("secondary-sound-finalizer");}
}
function createSound(){new SoundOwner();}
`,
        )
        try {
          await execute('try{createSound();}catch(e){caught=e.message;}')
          assert.match(await session.evaluate('caught'), /primary-sound-constructor/)
          assert(!(await session.evaluate('caught')).includes('secondary-sound-finalizer'))
          assert.equal(await session.evaluate('finalized'), '1')
          assert.equal(audio.closedIds.length, 1)
          await restored()
        } finally {
          await session.stop()
        }
      },
    )

    test(
      `${mode}: ${kind} rejects numeric action owners without leaving native or host ownership`,
      deadline,
      async () => {
        const { session, execute, restored } = await soundFixture(
          binary,
          `
function createSound(){new ${kind}(7);}
`,
        )
        try {
          await execute('try{createSound();}catch(e){caught=e.message;}')
          assert.notEqual(await session.evaluate('caught'), '')
          await restored()
        } finally {
          await session.stop()
        }
      },
    )
  }

  for (const event of ['label', 'ended', 'fade'] as const)
    test(
      `${mode}: queued sound ${event} owns the last reference and resolves its member at delivery`,
      deadline,
      async () => {
        const member =
          event === 'label' ? 'onLabel' : event === 'ended' ? 'onStatusChanged' : 'onFadeCompleted'
        const { session, audio, logs, execute, restored, baseline } = await soundFixture(
          binary,
          `
class SoundOwner extends WaveSoundBuffer {
  var marker="sound-owner";
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function finalize(){finalized++;Debug.message("sound-finalized");}
}
function replacement(value=void){receiver=this.marker+":"+string(value);calls++;Debug.message("sound-event");}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");}
`,
        )
        try {
          await execute('System.eventDisabled=true;createSound();')
          audio.emit(audio.event(audio.onlyId(), event))
          await execute(`sound.${member}=replacement incontextof sound;delete global.sound;`)
          assert.equal(await session.evaluate('calls+","+finalized'), '0,0')
          assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
          assert.equal(audio.voices.size, 1)
          await execute('System.eventDisabled=false;')
          await session.idle()
          // Do not evaluate before testing the pump's own release boundary.
          assert.deepEqual(logs, ['sound-event', 'sound-finalized'])
          assert.equal(audio.voices.size, 0)
          assert.equal(session.inspectOwnership().pendingSoundCloses, 0)
          assert.equal(await session.evaluate('calls+","+finalized'), '1,1')
          assert.equal(
            await session.evaluate('receiver'),
            `sound-owner:${event === 'label' ? 'cue' : event === 'ended' ? 'stop' : ''}`,
          )
          await restored()
        } finally {
          await session.stop()
        }
      },
    )

  for (const operation of ['invalidate sound', 'sound.open("tone.wav")', 'sound.stop()'])
    test(
      `${mode}: ${operation} retires queued sound callbacks and their strong leases`,
      deadline,
      async () => {
        const { session, audio, execute, restored } = await soundFixture(
          binary,
          `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){calls++;}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");sound.play();}
`,
        )
        try {
          await execute('System.eventDisabled=true;createSound();')
          const id = audio.onlyId(),
            late = audio.event(id, 'label')
          audio.emit(late)
          audio.emit(late)
          await execute(`${operation};delete global.sound;`)
          assert.equal(await session.evaluate('calls+","+finalized'), '0,1')
          assert.equal(audio.voices.size, 0)
          audio.emit(late)
          await execute('System.eventDisabled=false;')
          await session.idle()
          assert.equal(await session.evaluate('calls'), '0')
          await restored()
        } finally {
          await session.stop()
        }
      },
    )

  test(
    `${mode}: label and ended events remain ordered while each owns the sound`,
    deadline,
    async () => {
      const { session, audio, execute, restored } = await soundFixture(
        binary,
        `
var order="";
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){order+=name+",";}
  function onStatusChanged(status){order+=status+",";}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");sound.play();}
`,
      )
      try {
        await execute('System.eventDisabled=true;createSound();order="";')
        const id = audio.onlyId()
        audio.emit(audio.event(id, 'label'))
        audio.emit(audio.event(id, 'ended'))
        await execute('delete global.sound;')
        assert.equal(await session.evaluate('finalized'), '0')
        await execute('System.eventDisabled=false;')
        await session.idle()
        assert.equal(await session.evaluate('order+finalized'), 'cue,stop,1')
        await restored()
      } finally {
        await session.stop()
      }
    },
  )

  test(
    `${mode}: self-invalidation during sound delivery cancels remaining events without losing the active lease`,
    deadline,
    async () => {
      const { session, audio, execute, restored } = await soundFixture(
        binary,
        `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){calls++;invalidate this;global.completed++;}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");}
`,
      )
      try {
        await execute('System.eventDisabled=true;createSound();')
        const id = audio.onlyId()
        audio.emit(audio.event(id, 'label'))
        audio.emit(audio.event(id, 'label'))
        await execute('delete global.sound;System.eventDisabled=false;')
        await session.idle()
        assert.equal(await session.evaluate('calls+","+completed+","+finalized'), '1,1,1')
        await restored()
      } finally {
        await session.stop()
      }
    },
  )

  test(
    `${mode}: external flags do not keep their sound alive and invalidate safely with the owner`,
    deadline,
    async () => {
      const { session, audio, execute, restored, baseline } = await soundFixture(
        binary,
        `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();global.flags=sound.flags;}
`,
      )
      try {
        await execute('createSound();flags[0]=23;')
        assert.equal(
          await session.evaluate('flags[0]+","+flags.count+","+(flags===sound.flags)'),
          '0,16,1',
        )
        await execute('sound.fade(0,100);flags[0]=42;')
        assert.equal(await session.evaluate('flags[0]'), '0')
        assert.equal(audio.commands.filter((command) => command.op === 'flag').length, 0)
        await execute('sound.open("tone.wav");flags[0]=42;')
        assert.equal(await session.evaluate('flags[0]'), '42')
        await execute('sound.open("tone.wav");')
        assert.equal(await session.evaluate('(flags===sound.flags)+","+flags[0]'), '1,0')
        await execute('delete global.sound;')
        assert.equal(session.inspectOwnership().soundSources, baseline.soundSources)
        assert.equal(audio.voices.size, 0)
        assert.equal(await session.evaluate('(isvalid flags)+","+finalized'), '0,1')
        await execute('try{flags[0];}catch(e){caught=e.message;}')
        assert.notEqual(await session.evaluate('caught'), '')
        await execute('delete global.flags;')
        await restored()
      } finally {
        await session.stop()
      }
    },
  )

  test(
    `${mode}: old sound labels invalidate on reopen and owner loss while external filters remain valid`,
    deadline,
    async () => {
      const { session, execute, restored } = await soundFixture(
        binary,
        `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");global.labels=sound.labels;global.filters=sound.filters;filters.add(42);}
`,
      )
      try {
        await execute('createSound();')
        assert.equal(
          await session.evaluate('labels.cue.samplePosition+","+(labels===sound.labels)'),
          '20,1',
        )
        await execute('sound.open("tone.wav");')
        assert.equal(
          await session.evaluate('(isvalid labels)+","+(isvalid filters)+","+filters[0]'),
          '0,1,42',
        )
        await execute('global.currentLabels=sound.labels;delete global.sound;')
        assert.equal(
          await session.evaluate(
            '(isvalid currentLabels)+","+(isvalid filters)+","+filters[0]+","+finalized',
          ),
          '0,1,42,1',
        )
        await execute('filters.add(43);')
        assert.equal(await session.evaluate('filters.join(",")'), '42,43')
        await execute('delete global.labels;delete global.currentLabels;delete global.filters;')
        await restored()
      } finally {
        await session.stop()
      }
    },
  )

  test(
    `${mode}: sound action owner remains strongly owned until its sound is released`,
    deadline,
    async () => {
      const { session, audio, logs, execute, restored } = await soundFixture(
        binary,
        `
var actionFinalized=0;
class ActionOwner {
  function action(event){if(event.type=="onLabel"){calls++;Debug.message("action-called");delete global.sound;}}
  function finalize(){actionFinalized++;Debug.message("action-finalized");}
}
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(action){super.WaveSoundBuffer(action);}
  function finalize(){finalized++;Debug.message("sound-finalized");}
}
function createSound(){var action=new ActionOwner();global.sound=new SoundOwner(action);sound.open("tone.wav");}
`,
      )
      try {
        await execute('createSound();')
        assert.equal(await session.evaluate('actionFinalized'), '0')
        audio.emit(audio.event(audio.onlyId(), 'label'))
        await session.idle()
        assert.deepEqual(logs, ['action-called', 'sound-finalized', 'action-finalized'])
        await restored()
        assert.equal(await session.evaluate('calls+","+finalized+","+actionFinalized'), '1,1,1')
      } finally {
        await session.stop()
      }
    },
  )

  for (const boundary of ['execute', 'idle', 'stop'])
    test(
      `${mode}: ${boundary} waits for asynchronous sound close after ownership retirement`,
      deadline,
      async () => {
        const { session, audio, execute, restored, stopped, baseline } = await soundFixture(
          binary,
          `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){delete global.sound;}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");}
`,
        )
        const gate = soundGate()
        let pending: Promise<unknown> | undefined
        try {
          await execute('createSound();')
          audio.nextClose = gate
          if (boundary === 'idle') {
            audio.emit(audio.event(audio.onlyId(), 'label'))
            pending = session.idle()
          } else pending = boundary === 'stop' ? session.stop() : execute('delete global.sound;')
          let settled = false
          const outcome = pending.then(
            () => {
              settled = true
            },
            (error: unknown) => {
              settled = true
              throw error
            },
          )
          await Promise.race([
            gate.entered,
            outcome.then(() => {
              throw new Error('Boundary completed without starting close')
            }),
          ])
          assert.equal(settled, false)
          assert.equal(session.inspectOwnership().soundSources, baseline.soundSources)
          assert.equal(session.inspectOwnership().pendingSoundCloses, 1)
          assert.equal(audio.voices.size, 1)
          gate.release()
          await outcome
          assert.equal(audio.voices.size, 0)
          assert.equal(session.inspectOwnership().pendingSoundCloses, 0)
          if (boundary === 'stop') await stopped()
          else await restored()
        } finally {
          gate.release()
          await session.stop()
          await pending?.catch(() => {})
        }
      },
    )

  for (const primary of [false, true])
    test(
      `${mode}: close rejection ${primary ? 'preserves the script primary error' : 'reaches the caller'} after releasing resources`,
      deadline,
      async () => {
        const { session, audio, execute, stopped } = await soundFixture(
          binary,
          `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);open("tone.wav");}
}
function failure(){var sound=new SoundOwner();${primary ? 'throw new Exception("primary-script-error");' : ''}}
`,
        )
        try {
          audio.failClose = new Error('secondary-close-error')
          const error = await execute('failure();').then(
            () => undefined,
            (error: unknown) => error,
          )
          assert(error instanceof Error)
          assert.match(error.message, primary ? /primary-script-error/ : /secondary-close-error/)
          if (primary) assert(!error.message.includes('secondary-close-error'))
          assert.equal(audio.voices.size, 0)
          assert.equal(session.inspectOwnership().soundSources, 0)
          assert.equal(session.inspectOwnership().pendingSoundCloses, 0)
          await stopped()
        } finally {
          await session.stop()
        }
      },
    )

  test(
    `${mode}: failed backend open still closes a resource acquired before the rejection`,
    deadline,
    async () => {
      const { session, audio, execute, restored } = await soundFixture(
        binary,
        `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);open("tone.wav");}
  function finalize(){finalized++;throw new Exception("secondary-finalizer");}
}
function createSound(){new SoundOwner();}
`,
      )
      try {
        audio.failOpen = new Error('primary-open-error')
        await execute('try{createSound();}catch(e){caught=e.message;}')
        assert.match(await session.evaluate('caught'), /primary-open-error/)
        assert(!(await session.evaluate('caught')).includes('secondary-finalizer'))
        assert.equal(audio.closedIds.length, 1)
        assert.equal(await session.evaluate('finalized'), '1')
        await restored()
      } finally {
        await session.stop()
      }
    },
  )

  test(
    `${mode}: terminal sound cleanup closes resources without running script finalizers or callbacks`,
    deadline,
    async () => {
      const { session, audio, logs, execute, stopped } = await soundFixture(
        binary,
        `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){Debug.message("unexpected-terminal-callback");}
  function finalize(){Debug.message("unexpected-terminal-finalizer");throw new Exception("terminal-script-finalizer");}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");sound.play();}
`,
      )
      try {
        await execute('System.eventDisabled=true;createSound();')
        audio.emit(audio.event(audio.onlyId(), 'label'))
        await stopped()
        assert.deepEqual(logs, [])
        assert.equal(audio.terminalCloses, 1)
      } finally {
        await session.stop()
      }
    },
  )

  for (const cancel of [false, true])
    test(
      `${mode}: ${cancel ? 'stopping' : 'pausing and resuming'} suspended sound delivery settles its last event lease`,
      deadline,
      async () => {
        let entered!: () => void, finish!: (source: string) => void
        const ready = new Promise<void>((resolve) => {
          entered = resolve
        })
        const held = new Promise<string>((resolve) => {
          finish = resolve
        })
        const { session, audio, execute, restored, stopped, baseline } = await soundFixture(
          binary,
          `
class SoundOwner extends WaveSoundBuffer {
  function SoundOwner(){super.WaveSoundBuffer(null);}
  function onLabel(name){calls++;Scripts.evalStorage("hold.tjs");global.completed++;}
  function finalize(){finalized++;}
}
function createSound(){global.sound=new SoundOwner();sound.open("tone.wav");}
`,
          {
            async decodeScript(bytes, mode, encoding) {
              const source = await readScript(bytes, mode, encoding)
              if (source === 'hold-sound-lifetime-callback') {
                entered()
                return held
              }
              return source
            },
          },
        )
        let delivery: Promise<string> | undefined
        try {
          await execute('System.eventDisabled=true;createSound();')
          audio.emit(audio.event(audio.onlyId(), 'label'))
          await execute('delete global.sound;')
          delivery = execute('System.eventDisabled=false;')
          let settled = false
          const outcome = delivery.then(
            () => {
              settled = true
              return undefined
            },
            (error: unknown) => {
              settled = true
              return error
            },
          )
          await Promise.race([
            ready,
            outcome.then(() => {
              throw new Error('Sound callback did not suspend')
            }),
          ])
          assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
          assert.equal(audio.voices.size, 1)
          if (cancel) {
            const stopping = session.stop()
            finish('0')
            await stopping
            const error = await outcome
            assert(error instanceof Error && error.name === 'AbortError')
            await stopped()
          } else {
            session.pause()
            finish('0')
            await new Promise((resolve) => setTimeout(resolve, 20))
            assert.equal(settled, false)
            assert.equal(session.inspectOwnership().soundSources, baseline.soundSources + 1)
            assert.equal(audio.voices.size, 1)
            session.resume()
            assert.equal(await outcome, undefined)
            await session.idle()
            assert.equal(await session.evaluate('calls+","+completed+","+finalized'), '1,1,1')
            await restored()
          }
        } finally {
          finish('0')
          await session.stop()
          await delivery?.catch(() => {})
        }
      },
    )
}

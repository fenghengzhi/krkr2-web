import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import type { AudioCommand, AudioResult } from '../../src/engine/ports/audio.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless, createHeadlessRuntime } from '../helpers/headless.ts'
import { cddaChangeDiscs, cddaChangeFiles, cddaChangeSource } from '../helpers/cdda-change.ts'

function files(binary: boolean): Record<string, string | Uint8Array> {
  return { ...cddaChangeFiles(), 'change.tjs': cddaChangeSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("change.tjs","savedata/change.cjs",false,true,false);Scripts.execStorage("savedata/change.cjs");'
      : 'Scripts.execStorage("change.tjs");' }
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve: () => resolve() }
}
function observed<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Disc change fixture cancelled'))
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
    work.then((value) => { signal.removeEventListener('abort', cancel); resolve(value) },
      (error) => { signal.removeEventListener('abort', cancel); reject(error) })
  })
}
class ExchangeAudio extends HeadlessAudioBackend {
  nextUnload?: { entered: ReturnType<typeof gate>; held: ReturnType<typeof gate> }
  override async command(command: AudioCommand): Promise<AudioResult> {
    const result = await super.command(command)
    if (command.op === 'unload' && command.id === 1 && this.nextUnload) {
      const barrier = this.nextUnload
      this.nextUnload = undefined
      barrier.entered.resolve(); await barrier.held.promise
    }
    return result
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: changing a real CD drive removes only its old PCM, preserves fade controls and opens the new disc through script`, { timeout: 60000 }, async (t) => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [], entered = gate(), held = gate(),
      audio = new ExchangeAudio({ now: () => clock.now, schedule: clock.schedule },
        (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 1000),
      { session } = await headless(files(binary), { audio, now: () => clock.now, schedule: clock.schedule, cddaDiscs: cddaChangeDiscs }),
      take = async (ms: number, left: number, right: number) => {
        await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
        clock.advance(ms); await session.idle()
        assert.deepEqual(output, [Array(ms).fill(left), Array(ms).fill(right)])
      }
    let changing: Promise<void> | undefined
    try {
      await session.start(); assert.equal(await session.evaluate('changeStart()'), 'play,play,play,play')
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((entry) => entry.path === 'savedata/change.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      await take(20, .46875, .046875)
      await session.evaluate('changeD.fade(0,120)')
      audio.nextUnload = { entered, held }
      changing = session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-two.cue' }); void changing.catch(() => {})
      await observed(t.signal, Promise.race([entered.promise, changing.then(() => { throw new Error('Unload reply was not held') })]))
      assert.equal(audio.mixer.inspectStreams().voices, 3)
      await take(60, .21875, -.078125)
      assert.equal(audio.mixer.snapshot(1).volume, 50000)
      await take(60, .21875, -.078125)
      assert.equal(audio.mixer.snapshot(1).volume, 0)
      held.resolve(); await changing; await session.idle()
      assert.equal(await session.evaluate('changeState()+"|"+changeD.states.join(",")'), 'unload,play,play,play|stop,play,unload')
      assert.equal(await session.evaluate('changeD.volume+":"+changeD.fades'), '0:1')
      assert.equal(await session.evaluate('(changeD.volume=100000,changeD.open("D:1"),changeD.play(),changeState())'), 'play,play,play,play')
      await take(20, -.03125, -.203125)
      assert.equal(await session.evaluate('changeE.states.join(",")'), 'stop,play')

      await session.changeDisc({ kind: 'eject', drive: 'D' }); await session.idle()
      assert.equal(await session.evaluate('changeState()'), 'unload,play,play,play')
      await take(20, .21875, -.078125)
      assert.equal(await session.evaluate('changeAttempt("D:1")'), 'rejected:unload')
      await session.changeDisc({ kind: 'reset', drive: 'D' })
      await session.evaluate('(changeD.open("D:1"),changeD.play(),0)'); await take(20, .46875, .046875)

      // The unload callback may immediately open the just-inserted disc. No
      // older retirement or queued old-source event may close that new voice.
      await session.evaluate('(changeD.reopenOnUnload=true,0)')
      await session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-two.cue' }); await session.idle()
      assert.equal(await session.evaluate('changeState()'), 'play,play,play,play')
      await take(20, -.03125, -.203125)
      assert.equal(audio.mixer.inspectStreams().voices, 4)
      assert.equal(await session.evaluate('changeD.fades'), '1')
    } catch (error) { failures.push(error) }
    held.resolve(); await changing?.catch(() => {})
    try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(audio.inspect().voices, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Live CDDA exchange or cleanup failed', { cause: failures[0] })
  })

  test(`${mode}: disc exchange cancels a held old CUE or decoder before release and late input cannot replace the new music`, { timeout: 60000 }, async (t) => {
    let holdCue = false, holdOther = false, holdTicket = false, first = true
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [], pending: Promise<unknown>[] = [],
      cueEntered = gate(), cueHeld = gate(), decoderEntered = gate(), decoderHeld = gate(), otherEntered = gate(), otherHeld = gate(),
      ticketEntered = gate(), ticketHeld = gate(), contents = files(binary),
      cue = new TextEncoder().encode(contents['disc-one.cue'] as string), otherCue = new TextEncoder().encode(contents['disc-e.cue'] as string),
      pcm = contents['held.wav'] as Uint8Array,
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (left, right) => { output[0]!.push(...left); output[1]!.push(...right) }, 1000),
      { session } = await headless(contents, { audio, now: () => clock.now, schedule: clock.schedule, cddaDiscs: cddaChangeDiscs,
        createRuntime: (handler, control, options) => createHeadlessRuntime(async (operation, args, context) => {
          const reply = await handler(operation, args, context)
          if (holdTicket && operation === 'Sound.call' && args[1] === 'prepareCdda') {
            holdTicket = false; ticketEntered.resolve(); await ticketHeld.promise
          }
          return reply
        }, control, options) })
    session.mount([
      { name: 'disc-one.cue', size: cue.length, async read() {
        if (holdCue) { cueEntered.resolve(); await cueHeld.promise }
        return cue.slice()
      } },
      { name: 'disc-e.cue', size: otherCue.length, async read() {
        if (holdOther) { otherEntered.resolve(); await otherHeld.promise }
        return otherCue.slice()
      } },
      { name: 'held.wav', size: pcm.length, async read() { throw new Error('Expected range source') },
        source: { size: pcm.length, async read(at, count) {
          if (first && at === 0 && count === 12) { first = false; decoderEntered.resolve(); await decoderHeld.promise }
          return pcm.slice(at, at + count)
        } } },
    ])
    const start = (name: string) => {
      const opening = session.evaluate(`changeAttempt(${JSON.stringify(name)})`)
      pending.push(opening); void opening.catch(() => {}); return opening
    }, hearNew = async () => {
      await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
      clock.advance(20); await session.idle()
      assert.deepEqual(output, [Array(20).fill(-.03125), Array(20).fill(-.203125)])
    }
    try {
      await session.start(); await session.evaluate('changeStart()'); await settleAudioPages(audio)
      holdCue = true
      const preparing = start('D:1')
      await observed(t.signal, Promise.race([cueEntered.promise, preparing.then(() => { throw new Error('CUE was not held') })]))
      await observed(t.signal, session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-two.cue' }))
      assert.equal(await observed(t.signal, preparing), 'rejected:unload')
      await session.evaluate('(changeD.open("D:1"),changeD.play(),0)'); await hearNew()
      cueHeld.resolve(); await session.idle(); await hearNew()

      await session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-held.cue' })
      const decoding = start('D:1')
      await observed(t.signal, Promise.race([decoderEntered.promise, decoding.then(() => { throw new Error('Decoder was not held') })]))
      assert.equal(audio.inspect().pendingCreates, 1)
      await observed(t.signal, session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-two.cue' }))
      assert.equal(await observed(t.signal, decoding), 'rejected:unload')
      assert.equal(audio.inspect().pendingCreates, 0)
      await session.evaluate('(changeD.open("D:1"),changeD.play(),0)'); await hearNew()
      decoderHeld.resolve(); await session.idle(); await hearNew()
      assert.equal(await session.evaluate('changeState()'), 'play,play,play,play')
      assert.equal(audio.mixer.inspectStreams().voices, 4)

      // The same object can already be selecting E while its old D is
      // exchanged. Only the old D voice retires; the independent E selection
      // must finish normally when its own provider becomes available.
      holdOther = true
      const otherOpening = start('E:1')
      let otherSettled = false
      void otherOpening.then(() => { otherSettled = true }, () => { otherSettled = true })
      await observed(t.signal, Promise.race([otherEntered.promise, otherOpening.then(() => { throw new Error('Other drive was not held') })]))
      await observed(t.signal, session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-one.cue' }))
      assert.equal(otherSettled, false, 'Changing D must not cancel a pending E selection')
      otherHeld.resolve(); assert.equal(await observed(t.signal, otherOpening), 'opened:stop')
      await session.evaluate('changeD.play()'); await settleAudioPages(audio)
      output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
      assert.deepEqual(output, [Array(20).fill(.34375), Array(20).fill(-.203125)])

      // Hold only delivery of the real prepared ticket to TJS. The drive can
      // change in this scheduling gap while the same object still plays E.
      holdTicket = true
      const obsolete = start('D:1')
      await observed(t.signal, Promise.race([ticketEntered.promise, obsolete.then(() => { throw new Error('Prepared ticket was not held') })]))
      await session.changeDisc({ kind: 'insert', drive: 'D', cue: 'disc-two.cue' })
      ticketHeld.resolve(); assert.equal(await observed(t.signal, obsolete), 'rejected:play')
      output.forEach((plane) => { plane.length = 0 }); clock.advance(20); await session.idle()
      assert.deepEqual(output, [Array(20).fill(.34375), Array(20).fill(-.203125)], 'An obsolete D ticket cannot stop the playing E source')
    } catch (error) { failures.push(error) }
    cueHeld.resolve(); decoderHeld.resolve(); otherHeld.resolve(); ticketHeld.resolve()
    for (const work of pending) await work.catch(() => {})
    try { await session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(audio.inspect().pendingCreates, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Held changed-disc input or cleanup failed', { cause: failures[0] })
  })
}

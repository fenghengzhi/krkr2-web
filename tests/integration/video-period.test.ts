import assert from 'node:assert/strict'
import test from 'node:test'
import type { VideoCommand, VideoResult } from '../../src/engine/ports/video.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import { headless } from '../helpers/headless.ts'
import { AudioClock } from '../helpers/audio.ts'

/** This port records the real VM/Worker contract. Actual frame production and
 * cue delivery are separately exercised in video-period.spec.ts. */
class CueBackend extends LifetimeVideoBackend {
  readonly periods: number[] = []
  readonly opens: Array<{ frame: number; past: boolean }> = []
  override async command(command: VideoCommand): Promise<VideoResult> {
    const result = await super.command(command)
    if (command.op === 'open') {
      this.opens.push({ frame: command.settings.periodEventFrame, past: command.periodEventPast ?? false })
      const snapshot = this.movies.get(command.id)!
      snapshot.periodEventPast = command.periodEventPast ?? false
      result.snapshot = { ...snapshot }
    } else if (command.op === 'period') {
      this.periods.push(command.frame)
      const snapshot = this.movies.get(command.id)!
      snapshot.periodEventFrame = command.frame
      snapshot.periodEventPast = command.frame <= snapshot.frame
      result.snapshot = { ...snapshot }
    }
    return result
  }
}

async function fixture(binary: boolean, body: (session: Awaited<ReturnType<typeof headless>>['session'], backend: CueBackend) => Promise<void>) {
  const clock = new AudioClock(), backend = new CueBackend(), failures: unknown[] = [],
    { session } = await headless({ 'startup.tjs': '', 'movie.mp4': new Uint8Array([1]),
      'cue.tjs': 'System.exitOnNoWindowStartup=false;var win=new Window();var movie=new VideoOverlay(win);' },
    { video: backend, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    if (binary) {
      await session.evaluate('Scripts.compileStorage("cue.tjs","savedata/cue.cjs",false,true,false)')
      await session.evaluate('Scripts.execStorage("savedata/cue.cjs")')
      assert.equal(new TextDecoder().decode(session.exportSaves().find((save) => save.path === 'savedata/cue.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } else await session.evaluate('Scripts.execStorage("cue.tjs")')
    await body(session, backend)
  } catch (error) { failures.push(error) }
  try {
    await session.stop()
    assert.equal(backend.movies.size, 0); assert.equal(backend.listeners.size, 0)
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Video cue binding or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: real period setters preserve native arity, signed narrowing and repeated assignments`, { timeout: 60000 },
    () => fixture(binary, async (session, backend) => {
      assert.equal(await session.evaluate('(movie.setPeriodEvent(6),movie.periodEventFrame)'), '6')
      assert.equal(await session.evaluate('(movie.setPeriodEvent(<%12%>,99),movie.periodEventFrame)'), '6', 'Two arguments are a native no-op, without converting the first')
      assert.equal(await session.evaluate('(movie.open("movie.mp4"),movie.periodEventFrame)'), '6')
      assert.deepEqual(backend.opens, [{ frame: 6, past: false }])
      await session.evaluate('(movie.periodEventFrame=6,movie.periodEventFrame=6,0)')
      assert.deepEqual(backend.periods, [6, 6])
      assert.equal(await session.evaluate('(movie.periodEventFrame=4294967302,movie.periodEventFrame)'), '6')
      assert.equal(await session.evaluate('(movie.periodEventFrame=2147483648,movie.periodEventFrame)'), '-2147483648')
      assert.equal(await session.evaluate('(movie.setPeriodEvent(void),movie.periodEventFrame)'), '0')
      assert.equal(await session.evaluate('(movie.setPeriodEvent(),movie.periodEventFrame)'), '-1')
      assert.equal(await session.evaluate('(movie.setPeriodEvent(12),movie.cancelPeriodEvent(),movie.periodEventFrame)'), '-1')
      assert.deepEqual(backend.periods, [6, 6, 6, -2147483648, 0, -1, 12, -1])
    }))
  test(`${label}: closed and reopened graphs retain past cue state without retaining media resources`, { timeout: 60000 },
    () => fixture(binary, async (session, backend) => {
      await session.evaluate('(movie.setPeriodEvent(0),movie.open("movie.mp4"),0)')
      assert.deepEqual(backend.opens, [{ frame: 0, past: true }])
      const id = backend.onlyId()
      backend.movies.get(id)!.frame = 12
      await session.evaluate('(movie.setPeriodEvent(6),movie.close(),0)')
      assert.equal(backend.movies.size, 0)
      await session.evaluate('movie.open("movie.mp4")')
      assert.deepEqual(backend.opens.at(-1), { frame: 6, past: true })
      await session.evaluate('(movie.close(),movie.periodEventFrame=6,movie.open("movie.mp4"),0)')
      assert.deepEqual(backend.opens.at(-1), { frame: 6, past: false }, 'Unopened GetFrame is zero even for the same numeric cue')
      await session.evaluate('(movie.close(),0)')
      backend.failOpen = new Error('cue-open-failure')
      await assert.rejects(session.evaluate('movie.open("movie.mp4")'), /cue-open-failure/)
      await session.evaluate('movie.open("movie.mp4")')
      assert.deepEqual(backend.opens.at(-1), { frame: 6, past: false })
    }))
}

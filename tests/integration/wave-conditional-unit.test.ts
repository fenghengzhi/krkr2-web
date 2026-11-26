import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { conditionalFiles, conditionalSource } from '../helpers/wave-conditional-unit.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a real streamed conditional BGM plays the native first phrase and restarts its branch after flag/seek controls`, { timeout: 60000 }, async () => {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left, right) => {
        output[0]!.push(...left); output[1]!.push(...right)
      }, 8000), { session } = await headless({ ...conditionalFiles(), 'branch.tjs': conditionalSource,
        'startup.tjs': binary ? 'Scripts.compileStorage("branch.tjs","savedata/branch.cjs",false,true,false);Scripts.execStorage("savedata/branch.cjs");'
          : 'Scripts.execStorage("branch.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule }),
      prefix = [...Array(400).fill(.125), ...Array(400).fill(.25), ...Array(400).fill(.125), ...Array(400).fill(.5)],
      next = [...Array(400).fill(.125), ...Array(400).fill(.5), ...Array(400).fill(.125), ...Array(400).fill(.5)],
      take = async (milliseconds: number, expected: number[]) => {
        await settleAudioPages(audio); output.forEach((plane) => { plane.length = 0 })
        clock.advance(milliseconds); await session.idle()
        assert.deepEqual(output[0], expected); assert.deepEqual(output[1], expected.map((sample) => sample ? -sample / 2 : 0))
      }
    try {
      await session.start()
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
        .find((file) => file.path === 'savedata/branch.cjs')!.bytes.subarray(0, 4)), 'TJS2')
      assert.equal(await session.evaluate('branchStart()'), 'play')
      await take(200, prefix)
      assert.equal(await session.evaluate('[branchMusic.first,branchMusic.journal.join(","),branchMusic.flags[0],branchMusic.status].join("|")'), 'middle|middle,next|1|play')
      const position = await session.evaluate('branchMusic.samplePosition')
      await session.evaluate('(branchMusic.paused=true,0)'); await take(40, [])
      assert.equal(await session.evaluate('branchMusic.samplePosition'), position)
      await session.evaluate('(branchRestart(0),0)'); await take(200, prefix)
      assert.equal(await session.evaluate('branchMusic.first'), 'middle')
      await session.evaluate('(branchRestart(1),0)'); await take(200, next)
      assert.equal(await session.evaluate('branchMusic.first'), 'next')
      await session.evaluate('(branchMusic.stop(),branchMusic.play(),0)'); await take(200, next)
      await session.evaluate('(branchMusic.stop(),branchMusic.flags.reset(),branchMusic.play(),0)'); await take(200, prefix)
      await session.evaluate('branchClose()')
      assert.equal(audio.inspect().voices, 0)
      assert.deepEqual(audio.mixer.inspectStreams(), { voices: 0, bytes: 0, pending: 0, reservedBytes: 0 })
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert.equal(clock.tasks.size, 0)
      assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Conditional music or cleanup failed', { cause: failures[0] })
  })

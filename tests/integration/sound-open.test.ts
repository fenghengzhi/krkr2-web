import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'
import { soundOpenExpected, soundOpenFiles, soundOpenSource } from '../helpers/sound-open.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: invalid sound open arguments preserve real PCM, labels, source clock and active fade`, { timeout: 60000 }, async () => {
  const clock = new AudioClock(), left: number[] = [], right: number[] = [], failures: unknown[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (l, r) => {
      left.push(...l); right.push(...r)
    }, 1000), { session } = await headless({ ...soundOpenFiles(), 'open-control.tjs': soundOpenSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("open-control.tjs","savedata/open-control.cjs",false,true,false);Scripts.execStorage("savedata/open-control.cjs");'
        : 'Scripts.execStorage("open-control.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((entry) => entry.path === 'savedata/open-control.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    for (const [kind, expected] of Object.entries(soundOpenExpected))
      assert.equal(await session.evaluate(`soundOpenObserve("${kind}")`), expected)
    assert.equal(audio.inspect().voices, 0)
    await session.evaluate('(function(){global.openSound=new OpenWave();openSound.open("open-keep.wav");global.oldOpenLabels=openSound.labels;openSound.looping=true;openSound.play();openSound.fade(0,120);return 0;})()')
    await settleAudioPages(audio)
    clock.advance(20); await session.idle()
    assert.deepEqual(left, Array(20).fill(0.25)); assert.deepEqual(right, left)
    assert.equal(await session.evaluate('soundOpenErrors(openSound)'), 'open-count|open-string')
    assert.equal(await session.evaluate('[openSound.status,openSound.samplePosition,openSound.completed,int(oldOpenLabels==openSound.labels),int(isvalid oldOpenLabels),openSound.states.join(",")].join("|")'), 'play|20|0|1|1|stop,play')
    await session.evaluate('(System.assignMessage("TJSBadParamCount","new-open-count"),System.assignMessage("TJSVariantConvertError","new-open-string"),0)')
    assert.equal(await session.evaluate('soundOpenErrors(openSound)'), 'new-open-count|new-open-string')
    clock.advance(100); await session.idle()
    assert.deepEqual(left, [...Array(59).fill(0.25), ...Array(60).fill(Math.fround(0.25 * 10 ** (-1505 / 2000))), 0])
    assert.deepEqual(right, left)
    assert.equal(await session.evaluate('[openSound.samplePosition,openSound.completed,openSound.volume,openSound.seen.join(",")].join("|")'), '120|1|0|kept')
    // A successfully converted but missing storage still reaches the existing
    // unload/open transaction; it is not treated as an argument failure.
    assert.equal(await session.evaluate('(function(){try{openSound.open("missing-open.wav");}catch(e){return openSound.status;}return "unexpected";})()'), 'unload')
    assert.equal(await session.evaluate('int(!isvalid oldOpenLabels)'), '1')
    await session.evaluate('(invalidate openSound,0)')
    assert.equal(audio.mixer.inspect().voices, 0); assert.equal(audio.mixer.inspectStreams().voices, 0)
  } catch (error) { failures.push(error) }
  try {
    await session.stop(); assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Sound argument failure or cleanup failed', { cause: failures[0] })
})

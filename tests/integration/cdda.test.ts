import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { AudioClock, wave } from '../helpers/audio.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'

const cue = 'FILE "audio/disc.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:00:02\n'
const script = String.raw`
System.exitOnNoWindowStartup=false;
var cdEvents=[];
class DiscSound extends CDDASoundBuffer {
  function DiscSound(){super.CDDASoundBuffer(null);}
  function onStatusChanged(status){global.cdEvents.add(status);}
}
var cd=new DiscSound();
function cdOpen(name){try{global.cd.open(name);return "opened";}catch(error){return error.message;}}
function cdPlay(){try{global.cd.play();return "playing";}catch(error){return error.message;}}
function cdState(){return [global.cd.status,global.cd.totalTime,global.cd.samplePosition,global.cd.channels,global.cd.bits].join(",");}
`
function pcm(): Uint8Array {
  const samples: number[] = []
  for (let frame = 0; frame < 2352; frame++) samples.push(frame < 1176 ? 0.25 : -0.5, frame < 1176 ? 0.125 : -0.25)
  return wave(samples, 44100, 2)
}
async function using(binary: boolean, discs: SessionDependencies['cddaDiscs'],
  body: (f: Awaited<ReturnType<typeof headless>> & { clock: AudioClock; audio: HeadlessAudioBackend; output: Float32Array[] }) => Promise<void>) {
  const clock = new AudioClock(), output: Float32Array[] = [],
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule }, (left) => output.push(left.slice()), 44100),
    f = await headless({ 'disc.cue': cue, 'audio/disc.wav': pcm(), 'cdda.tjs': script,
      'startup.tjs': binary ? 'Scripts.compileStorage("cdda.tjs","savedata/cdda.cjs",false,true,false);Scripts.execStorage("savedata/cdda.cjs");'
        : 'Scripts.execStorage("cdda.tjs");' }, { audio, now: () => clock.now, schedule: clock.schedule, cddaDiscs: discs }),
    failures: unknown[] = []
  try { await f.session.start(); await body({ ...f, clock, audio, output }) } catch (error) { failures.push(error) }
  try {
    await f.session.stop(); assert.equal(clock.tasks.size, 0); assert.equal(f.session.snapshot().handles, 0)
    assert.equal(audio.mixer.inspectStreams().voices, 0); assert.equal(audio.mixer.hasClockWork, false)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'CDDA script or cleanup failed', { cause: failures[0] })
}
for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: actual CDDA CUE open, seek, stop and looping stay within selected PCM sectors`, { timeout: 60000 }, async () => {
    await using(binary, undefined, async ({ session, clock, output }) => {
      let unrelatedReads = 0
      session.mount([{ name: 'unrelated.bin', size: 1024 * 1024 * 1024,
        async read() { unrelatedReads++; throw new Error('Unrelated media must not be probed') } }])
      assert.equal(await session.evaluate('cdOpen("2")'), 'opened')
      assert.equal(await session.evaluate('cdState()'), 'stop,26,0,2,16')
      assert.equal(await session.evaluate('(cd.samplePosition=588,cd.samplePosition)'), '588')
      assert.equal(await session.evaluate('(cd.position=10,cd.samplePosition)'), '441')
      assert.equal(await session.evaluate('(cd.samplePosition=0,cdPlay())'), 'playing')
      clock.advance(30); await session.idle()
      assert.equal(await session.evaluate('cd.status'), 'stop')
      assert.equal(unrelatedReads, 0)
      const heard = output.flatMap((plane) => [...plane])
      assert.deepEqual(heard.slice(0, 1176), Array(1176).fill(-0.5))
      assert(heard.slice(1176).every((sample) => sample === 0))
      output.length = 0
      assert.equal(await session.evaluate('cdOpen("D:1")'), 'opened')
      assert.equal(await session.evaluate('(cd.looping=true,cdPlay())'), 'playing')
      clock.advance(60); await session.idle()
      assert.equal(await session.evaluate('cd.status'), 'play')
      assert(output.length > 0); assert(output.every((plane) => [...plane].every((sample) => sample === 0.25)))
      assert.equal(await session.evaluate('(cd.stop(),cdState())'), 'stop,26,0,2,16')
      assert.equal(await session.evaluate('cdEvents.join(",")'), 'stop,play,stop,play,stop')
      assert.equal(await session.evaluate('cdOpen("99")'), 'opened')
      assert.match(await session.evaluate('cdPlay()'), /Imported CDDA track 99 is absent/)
      assert.equal(await session.evaluate('cd.status'), 'stop')
    })
  })
  test(`${label}: CDDA drive errors resolve current holders without breaking direct-file compatibility`, { timeout: 60000 }, async () => {
    await using(binary, [], async ({ session, clock, audio }) => {
      const numeric = pcm()
      session.mount([{ name: '2', size: numeric.length, async read() { return numeric } }])
      await session.evaluate('(System.assignMessage("TVPCDDADriveNotFound","no-disc:%1"),System.assignMessage("TVPInvalidCDDADrive","bad-drive:%%"))')
      assert.equal(await session.evaluate('cdOpen("audio/disc.wav")'), 'opened')
      assert.equal(await session.evaluate('(cd.looping=true,cdPlay())'), 'playing')
      assert.equal(await session.evaluate('cdOpen("1")'), 'no-disc:%1')
      assert.equal(await session.evaluate('cd.status'), 'play', 'default-drive rejection precedes stopping the old source')
      clock.advance(20); await session.idle(); assert(audio.mixer.peak > 0.1)
      assert.equal(await session.evaluate('cdOpen("E:1")'), 'bad-drive:%%')
      assert.equal(await session.evaluate('cd.status'), 'unload')
      assert.equal(audio.mixer.hasClockWork, false)
      assert.equal(await session.evaluate('cdOpen("audio/disc.wav")'), 'opened')
      assert.equal(await session.evaluate('cd.totalTime'), '53', 'direct-file playback keeps its entire previous extent')
      assert.equal(await session.evaluate('cdOpen("2")'), 'opened')
      assert.equal(await session.evaluate('cd.totalTime'), '53', 'an actual numeric resource takes precedence over track syntax')
      assert.equal(await session.evaluate('(invalidate cd,0)'), '0')
      await session.idle()
      assert.equal(audio.mixer.inspectStreams().voices, 0)
    })
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { AudioClock, wave } from '../helpers/audio.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'

const deadline = { timeout: 60_000 }

async function fixture(binary: boolean, source: string) {
  const clock = new AudioClock(),
    blocks: Float32Array[] = [],
    audio = new HeadlessAudioBackend(
      { now: () => clock.now, schedule: clock.schedule },
      (left, right) => blocks.push(left.slice(), right.slice()),
      44100,
    )
  // One second of real PCM is longer than the default analysis window. Tiny
  // sound fixtures can finish before any filtered output becomes available.
  const tone = wave(
    Array.from(
      { length: 44100 },
      (_, index) => Math.sin((index * 2 * Math.PI * 440) / 44100) * 0.4,
    ),
    44100,
  )
  const harness = await headless(
    {
      'startup.tjs': binary
        ? 'Scripts.compileStorage("phase-vocoder.tjs","savedata/phase-vocoder.cjs",false,true,false);Scripts.execStorage("savedata/phase-vocoder.cjs");'
        : 'Scripts.execStorage("phase-vocoder.tjs");',
      'phase-vocoder.tjs': source,
      'tone.wav': tone,
    },
    { audio, now: () => clock.now, schedule: clock.schedule },
  )
  try {
    await harness.session.start()
    const compiled = harness.session
      .exportSaves()
      .find((file) => file.path === 'savedata/phase-vocoder.cjs')
    if (binary) {
      assert(compiled, 'The bytecode variant must load the compiled fixture')
      assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      assert(compiled.bytes.length > 16)
    } else assert.equal(compiled, undefined)
  } catch (error) {
    await harness.session.stop()
    throw error
  }
  return { ...harness, clock, audio, blocks }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function expectPcm(harness: Fixture) {
  harness.blocks.length = 0
  harness.clock.advance(200)
  await harness.session.idle()
  assert.equal(harness.session.snapshot().state, 'running')
  assert(harness.blocks.length > 0, 'The real mixer must render output blocks')
  let peak = 0
  for (const block of harness.blocks) {
    for (const value of block) {
      assert(Number.isFinite(value), 'Filtered PCM must remain finite')
      peak = Math.max(peak, Math.abs(value))
    }
  }
  assert(peak > 0.001, 'The filter must produce non-silent PCM, not merely update status')
}

async function close(harness: Fixture) {
  await harness.session.stop()
  assert.equal(harness.clock.tasks.size, 0)
  assert.equal(harness.audio.inspect().voices, 0)
  assert.equal(harness.audio.inspect().pendingCreates, 0)
  assert.equal(harness.session.snapshot().handles, 0)
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(
    `PhaseVocoder session defaults, native int32 validation and float32 values (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();
var defaults=[phase.window,phase.overlap,phase.pitch,phase.time].join(",");
var windows=[64,128,256,512,1024,2048,4096,8192,16384,32768],seenWindows=[];
for(var i=0;i<windows.count;i++){phase.window=windows[i];seenWindows.add(phase.window);}
var overlaps=[0,2,4,8,16,32],seenOverlaps=[];
for(var i=0;i<overlaps.count;i++){phase.overlap=overlaps[i];seenOverlaps.add(phase.overlap);}
phase.window=4294967360;phase.overlap=4294967298;
var narrowed=[phase.window,phase.overlap].join(","),rejected=0;
try{phase.window=65;}catch(e){rejected++;}
try{phase.window=4294967295;}catch(e){rejected++;}
try{phase.overlap=3;}catch(e){rejected++;}
try{phase.overlap=4294967295;}catch(e){rejected++;}
phase.pitch=0.1;phase.time=1.1;
`,
      )
      try {
        assert.equal(await harness.session.evaluate('defaults'), '4096,0,1,1')
        assert.equal(
          await harness.session.evaluate('seenWindows.join(",")'),
          '64,128,256,512,1024,2048,4096,8192,16384,32768',
        )
        assert.equal(await harness.session.evaluate('seenOverlaps.join(",")'), '0,2,4,8,16,32')
        assert.equal(await harness.session.evaluate('narrowed'), '64,2')
        assert.equal(
          await harness.session.evaluate('[phase.window,phase.overlap,rejected].join(",")'),
          '64,2,4',
        )
        assert.equal(Number(await harness.session.evaluate('phase.pitch')), Math.fround(0.1))
        assert.equal(Number(await harness.session.evaluate('phase.time')), Math.fround(1.1))
        assert.equal(harness.audio.inspect().voices, 0)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `detached PhaseVocoder stores unchecked scales but actual open rejects an unsafe DSP domain (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder(),sound=new WaveSoundBuffer(null),rejected=0,stored=[];
sound.filters.add(phase);
var fields=["pitch","pitch","time","time"],values=[0,-1,0,100];
for(var i=0;i<values.count;i++){
  phase.pitch=1;phase.time=1;phase[fields[i]]=values[i];stored.add(phase[fields[i]]);
  try{sound.open("tone.wav");}catch(e){rejected++;}
  stored.add(sound.status);
}
phase.window=512;phase.pitch=1;phase.time=1;
var other=new WaveSoundBuffer(null);other.filters.add(phase);other.open("tone.wav");other.looping=true;other.play();
`,
      )
      try {
        assert.equal(await harness.session.evaluate('rejected'), '4')
        assert.equal(
          await harness.session.evaluate('stored.join(",")'),
          '+0.0,unload,-1,unload,+0.0,unload,100,unload',
        )
        assert.equal(await harness.session.evaluate('sound.status+","+other.status'), 'unload,play')
        assert.equal(
          harness.audio.inspect().voices,
          1,
          'Rejected opens must not retain backend voices',
        )
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `open snapshots PhaseVocoder filters, clear and stop keep ownership, reopening without filters releases it (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();phase.window=512;
class ProbeSound extends WaveSoundBuffer {
  function ProbeSound(){super.WaveSoundBuffer(null);}
  function resolveClass(){return (WaveSoundBuffer===this.WaveSoundBuffer)+","+
    (WaveSoundBuffer instanceof "Function")+","+(global.WaveSoundBuffer instanceof "Class")+","+
    (global.WaveSoundBuffer.__snapshotPhaseVocoderFilters instanceof "Function");}
}
var first=new ProbeSound(),second=new WaveSoundBuffer(null),busy=0;
var classResolution=first.resolveClass();
var sameArray=first.filters===first.filters;
first.filters.add(phase);first.open("tone.wav");first.filters.clear();second.filters.add(phase);
try{second.open("tone.wav");}catch(e){busy++;}
first.stop();try{second.open("tone.wav");}catch(e){busy++;}
function releaseAndReuse(){first.open("tone.wav");second.open("tone.wav");second.looping=true;second.play();return first.filters.count+","+second.status;}
`,
      )
      try {
        assert.equal(await harness.session.evaluate('classResolution'), '1,1,1,1')
        assert.equal(
          await harness.session.evaluate('sameArray+","+busy+","+first.status'),
          '1,2,stop',
        )
        assert.equal(await harness.session.evaluate('releaseAndReuse()'), '0,play')
        assert.equal(harness.audio.inspect().voices, 2)
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `duplicate PhaseVocoder chains roll back every earlier Source binding (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var firstFilter=new WaveSoundBuffer.PhaseVocoder(),secondFilter=new WaveSoundBuffer.PhaseVocoder();
firstFilter.window=512;secondFilter.window=512;
var rejected=new WaveSoundBuffer(null),failed=false;
rejected.filters.add(firstFilter);rejected.filters.add(secondFilter);rejected.filters.add(firstFilter);
try{rejected.open("tone.wav");}catch(e){failed=true;}
var first=new WaveSoundBuffer(null),second=new WaveSoundBuffer(null);
first.filters.add(firstFilter);second.filters.add(secondFilter);first.open("tone.wav");second.open("tone.wav");
first.looping=true;second.looping=true;first.play();second.play();
`,
      )
      try {
        assert.equal(
          await harness.session.evaluate(
            'failed+","+rejected.status+","+first.status+","+second.status',
          ),
          '1,unload,play,play',
        )
        assert.equal(harness.audio.inspect().voices, 2)
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `invalidating a connected PhaseVocoder revokes script properties while the retained DSP continues (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();phase.window=512;phase.pitch=1.5;
var sound=new WaveSoundBuffer(null);sound.filters.add(phase);sound.open("tone.wav");sound.filters.clear();sound.looping=true;sound.play();
function invalidateConnected(){
  invalidate phase;var rejected=0;
  try{var value=phase.pitch;}catch(e){rejected++;}
  try{phase.pitch=1;}catch(e){rejected++;}
  return (isvalid phase)+","+rejected+","+sound.status;
}
function reopenWithoutFilter(){sound.open("tone.wav");sound.play();return sound.status;}
`,
      )
      try {
        await expectPcm(harness)
        assert.equal(await harness.session.evaluate('invalidateConnected()'), '0,2,play')
        await expectPcm(harness)
        assert.equal(await harness.session.evaluate('reopenWithoutFilter()'), 'play')
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `a missing-resource open unloads the old stream and releases its PhaseVocoder for another sound (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();phase.window=512;
var first=new WaveSoundBuffer(null),second=new WaveSoundBuffer(null),failed=false;
first.filters.add(phase);first.open("tone.wav");first.play();
try{first.open("missing.wav");}catch(e){failed=true;}
second.filters.add(phase);second.open("tone.wav");second.looping=true;second.play();
`,
      )
      try {
        assert.equal(
          await harness.session.evaluate('failed+","+first.status+","+second.status'),
          '1,unload,play',
        )
        assert.equal(harness.audio.inspect().voices, 1)
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `connected PhaseVocoder setters commit only after actual DSP validation succeeds (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();phase.window=512;phase.overlap=4;
var sound=new WaveSoundBuffer(null);sound.filters.add(phase);sound.open("tone.wav");sound.filters.clear();sound.looping=true;sound.play();
function rejectUpdates(){
  var rejected=0;
  try{phase.pitch=0;}catch(e){rejected++;}
  try{phase.time=100;}catch(e){rejected++;}
  try{phase.time=0.00000001;}catch(e){rejected++;}
  return [rejected,phase.pitch,phase.time,sound.status].join(",");
}
function acceptUpdates(){phase.pitch=1.5;phase.time=2;return phase.pitch+","+phase.time;}
`,
      )
      try {
        await expectPcm(harness)
        assert.equal(await harness.session.evaluate('rejectUpdates()'), '3,1,1,play')
        await expectPcm(harness)
        assert.equal(await harness.session.evaluate('acceptUpdates()'), '1.5,2')
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )

  test(
    `native sound invalidation closes the real voice before another sound reuses its PhaseVocoder (${mode})`,
    deadline,
    async () => {
      const harness = await fixture(
        binary,
        String.raw`
var phase=new WaveSoundBuffer.PhaseVocoder();phase.window=512;
var first=new WaveSoundBuffer(null),second=new WaveSoundBuffer(null);
first.filters.add(phase);second.filters.add(phase);first.open("tone.wav");first.looping=true;first.play();
function retireFirst(){invalidate first;return isvalid first;}
function reuseFilter(){second.open("tone.wav");second.looping=true;second.play();return second.status;}
`,
      )
      try {
        await expectPcm(harness)
        assert.equal(await harness.session.evaluate('retireFirst()'), '0')
        await harness.session.idle()
        assert.equal(harness.audio.inspect().voices, 0)
        assert.equal(await harness.session.evaluate('reuseFilter()'), 'play')
        assert.equal(harness.audio.inspect().voices, 1)
        await expectPcm(harness)
      } finally {
        await close(harness)
      }
    },
  )
}

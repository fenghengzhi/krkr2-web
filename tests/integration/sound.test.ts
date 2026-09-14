import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { AudioClock, wave, midi } from '../helpers/audio.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'

async function setup(source: string) {
  const clock = new AudioClock(),
    audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule })
  const result = await headless(
    { 'startup.tjs': source, 'tone.wav.sli': '#2.00\nLabel {Position=20;Name="cue";}' },
    { audio, now: () => clock.now, schedule: clock.schedule },
  )
  const wav = wave(Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.2) * 0.5)),
    smf = midi([[0, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0]])
  result.session.mount([
    { name: 'tone.wav', size: wav.length, read: async () => wav },
    { name: 'tone.mid', size: smf.length, read: async () => smf },
  ])
  return { ...result, clock, audio }
}

test('sound status callbacks run inline, native indexed flags update immediately, and labels/end arrive asynchronously', async () => {
  const { session, clock } = await setup(String.raw`
var order=[];
class Sound extends WaveSoundBuffer {
  function Sound(){super.WaveSoundBuffer(null);}
  function onStatusChanged(status){order.add(status);}
  function onLabel(name){order.add(name);}
}
var sound=new Sound();order.add("before");sound.open("tone.wav");order.add("after");sound.flags[0]=2;sound.flags[0]++;sound.play();
`)
  try {
    await session.start()
    assert.equal(await session.evaluate('order.join(",")'), 'before,stop,after,play')
    assert.equal(await session.evaluate('sound.flags[0]'), '3')
    assert.equal(await session.evaluate('sound.flags.count'), '16')
    assert.equal(await session.evaluate('sound.frequency'), '1000')
    assert.equal(await session.evaluate('sound.labels.cue.samplePosition'), '20')
    assert.equal(
      await session.evaluate('sound.labels===sound.labels && sound.labels.cue.position==20'),
      '1',
    )
    clock.advance(150)
    await session.idle()
    assert.equal(await session.evaluate('order.join(",")'), 'before,stop,after,play,cue,stop')
    assert.equal(await session.evaluate('sound.status'), 'stop')
    await session.evaluate('(function(){invalidate sound;return 0;})()')
  } finally {
    await session.stop()
  }
})

test('fade completion can synchronously stop playback and failed open leaves the old stream unloaded', async () => {
  const { session, clock, logs } = await setup(String.raw`
class Sound extends WaveSoundBuffer {
  function Sound(){super.WaveSoundBuffer(null);}
  function onFadeCompleted(){Debug.message("fade-done");stop();}
}
var sound=new Sound();sound.open("tone.wav");sound.looping=true;sound.play();sound.fade(0,120);
`)
  try {
    await session.start()
    clock.advance(150)
    await session.idle()
    assert.ok(logs.includes('fade-done'))
    assert.equal(await session.evaluate('sound.status'), 'stop')
    assert.equal(
      await session.evaluate(
        '(function(){try{sound.open("missing.wav");}catch(error){return sound.status;}})()',
      ),
      'unload',
    )
  } finally {
    await session.stop()
  }
})

test('MIDI buffers play through the same sample clock and stop cleans all scheduled work', async () => {
  const { session, clock, audio } = await setup(
    'var sound=new MIDISoundBuffer(null);sound.open("tone.mid");sound.play();',
  )
  await session.start()
  clock.advance(40)
  await session.idle()
  assert.ok(audio.mixer.peak > 0.001)
  await session.stop()
  assert.equal(clock.tasks.size, 0)
  assert.equal(session.snapshot().handles, 0)
})

test('audio loop failures reach the session and all audio work can still be released', async () => {
  const { session, clock, logs } = await setup(
    'var sound=new WaveSoundBuffer(null);sound.open("tone.wav");sound.play();',
  )
  const bytes = new TextEncoder().encode('#2.00\nLink {From=0;To=0;}')
  session.mount([{ name: 'tone.wav.sli', size: bytes.length, read: async () => bytes }])
  try {
    await session.start()
    clock.advance(20)
    await session.idle()
    assert.equal(session.snapshot().state, 'failed')
    assert.ok(logs.some((log) => log.includes('no forward progress')))
  } finally {
    await session.stop()
  }
  assert.equal(clock.tasks.size, 0)
  assert.equal(session.snapshot().handles, 0)
})

test('event disabling drops synchronous sound status but defers source-clock labels and completion', async () => {
  const { session, clock } = await setup(String.raw`
var order=[];
class Sound extends WaveSoundBuffer {
  function Sound(){super.WaveSoundBuffer(null);}
  function onStatusChanged(status){order.add(status);}
  function onLabel(name){order.add(name);}
}
System.eventDisabled=true;var sound=new Sound();sound.open("tone.wav");sound.play();
`)
  try {
    await session.start()
    assert.equal(await session.evaluate('order.count'), '0')
    clock.advance(150)
    await session.idle()
    assert.equal(await session.evaluate('sound.status'), 'stop')
    assert.equal(await session.evaluate('order.count'), '0')
    await session.evaluate('System.eventDisabled=false')
    assert.equal(await session.evaluate('order.join(",")'), 'cue,stop')
  } finally {
    await session.stop()
  }
})

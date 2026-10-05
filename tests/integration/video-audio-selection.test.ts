import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import type { VideoCommand, VideoResult } from '../../src/engine/ports/video.ts'

class TrackBackend extends LifetimeVideoBackend {
  readonly selected: number[] = []
  readonly opened: number[] = []
  rejectNext = false
  override async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'open') this.opened.push(command.settings.enabledAudioStream)
    if (command.op === 'set') {
      if (this.rejectNext) { this.rejectNext = false; throw new Error('selection failed') }
      this.selected.push(command.settings.enabledAudioStream)
    }
    const result = await super.command(command)
    if (command.op === 'open' && result.snapshot) {
      result.snapshot.numberOfAudioStream = 2
      result.snapshot.enabledAudioStream = 0
      Object.assign(this.movies.get(command.id)!, result.snapshot)
    }
    return result
  }
}

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: VideoOverlay audio method and property preserve native uint32 and no-op selection semantics`, { timeout: 60000 }, async () => {
  const video = new TrackBackend(), source = String.raw`
var win=new Window(),movie=new VideoOverlay(win);
var before=movie.enabledAudioStream;
movie.enabledAudioStream=1;movie.selectAudioStream(4294967297);
var unloaded=movie.enabledAudioStream;
movie.open("fixture.mp4");
function chooseMethod(value){movie.selectAudioStream(value);return movie.enabledAudioStream;}
function chooseProperty(value){movie.enabledAudioStream=value;return movie.enabledAudioStream;}
`, { session } = await headless({
    'startup.tjs': binary
      ? 'Scripts.compileStorage("audio-selection.tjs","savedata/audio-selection.cjs",false,true,false);Scripts.execStorage("savedata/audio-selection.cjs");'
      : 'Scripts.execStorage("audio-selection.tjs");',
    'audio-selection.tjs': source, 'fixture.mp4': new Uint8Array([1]),
  }, { video })
  try {
    await session.start()
    assert.equal(await session.evaluate('[before,unloaded,movie.numberOfAudioStream,movie.enabledAudioStream].join("|")'), '-1|-1|2|0')
    assert.equal(video.selected.length, 0, 'unloaded selections must not reach a backend')
    if (binary) {
      const compiled = session.exportSaves().find((entry) => entry.path === 'savedata/audio-selection.cjs')
      assert(compiled)
      assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
    }
    assert.equal(await session.evaluate('chooseMethod(1)'), '1')
    assert.equal(await session.evaluate('chooseProperty(4294967296)'), '0')
    assert.equal(await session.evaluate('chooseMethod("4294967297")'), '1')
    assert.equal(await session.evaluate('chooseProperty(-4294967296)'), '0')
    assert.equal(await session.evaluate('chooseProperty(true)'), '1')
    assert.equal(await session.evaluate('chooseMethod(0.99)'), '0')
    assert.deepEqual([...video.selected], [1, 0, 1, 0, 1, 0])
    const count = video.selected.length
    for (const expression of ['chooseMethod(-1)', 'chooseProperty(-2)', 'chooseMethod(2)', 'chooseProperty(4294967295)'])
      assert.equal(await session.evaluate(expression), '0')
    assert.equal(video.selected.length, count, 'out-of-range uint32 selections are native no-ops')
    assert.equal(await session.evaluate('(function(){try{movie.selectAudioStream();return 0;}catch(e){return 1;}})()'), '1')
    video.rejectNext = true
    assert.equal(await session.evaluate('(function(){try{movie.enabledAudioStream=1;}catch(e){return movie.enabledAudioStream;}return -7;})()'), '0')
    assert.equal(await session.evaluate('chooseMethod(1)'), '1')
    await session.evaluate('movie.close();movie.enabledAudioStream=1;')
    assert.equal(await session.evaluate('movie.enabledAudioStream'), '-1')
    assert.equal(video.selected.length, count + 1)
    await session.evaluate('movie.open("fixture.mp4");')
    assert.equal(await session.evaluate('movie.enabledAudioStream'), '0')
    assert.deepEqual([...video.opened], [0, 0], 'a previous file selection must not become a new-file preference')
  } finally { await session.stop() }
  assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  assert.equal(video.movies.size, 0)
})

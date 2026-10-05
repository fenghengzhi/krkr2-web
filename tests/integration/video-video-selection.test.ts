import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { LifetimeVideoBackend, videoGate } from '../helpers/video-lifetime-backend.ts'
import type { VideoCommand, VideoResult, VideoSnapshot } from '../../src/engine/ports/video.ts'

/** Controller-boundary fixture, not a codec or DirectShow renderer oracle.
 * Real MP4/HTML decoded-track acceptance is covered by the browser suite. */
class Tracks extends LifetimeVideoBackend {
  readonly settings: Extract<VideoCommand, { op: 'set' }>[] = []
  readonly opened: [number, number][] = []
  rejectSelection = false
  latePixelReads = 0
  nextSelection?: ReturnType<typeof videoGate>
  private metadata(snapshot: VideoSnapshot) {
    const selected = snapshot.enabledVideoStream
    Object.assign(snapshot, { numberOfVideoStream: 2, numberOfAudioStream: 2,
      originalWidth: selected === 0 ? 2 : 1, originalHeight: selected === 0 ? 1 : 2,
      fps: selected === 0 ? 10 : 5, numberOfFrame: selected === 0 ? 20 : 10, totalTime: 2000,
      frame: Math.floor(snapshot.position / (selected === 0 ? 100 : 200)) })
  }
  override async command(command: VideoCommand): Promise<VideoResult> {
    const previous = 'id' in command ? this.movies.get(command.id) : undefined,
      changed = command.op === 'set' && previous && command.settings.enabledVideoStream !== previous.enabledVideoStream
    if (command.op === 'open') this.opened.push([command.settings.enabledAudioStream, command.settings.enabledVideoStream])
    if (command.op === 'set') {
      this.settings.push({ ...command, settings: { ...command.settings } })
      if (this.rejectSelection) {
        this.rejectSelection = false
        if (previous) previous.epoch = command.epoch
        throw new Error('candidate video selection failed')
      }
      const gate = this.nextSelection
      this.nextSelection = undefined
      await gate?.wait()
      if (gate && previous && !this.movies.has(command.id)) {
        // Model a noncancelable decoder's successful late completion, not a
        // fake that rejects before the real controller can inspect its reply.
        const snapshot = { ...previous, ...command.settings, epoch: command.epoch }
        this.metadata(snapshot)
        const fixture = this
        return { snapshot, events: [{ type: 'frame', id: snapshot.id, epoch: snapshot.epoch, snapshot,
          pixels: { width: 1, height: 2, get data() { fixture.latePixelReads++; return new Uint8Array([0,255,0,255,0,255,0,255]) } } }] }
      }
    }
    const result = await super.command(command)
    if (result.snapshot) {
      if (command.op === 'seek' && command.position !== undefined) result.snapshot.position = command.position
      if (command.op === 'open' || command.op === 'seek' || command.op === 'set') this.metadata(result.snapshot)
      Object.assign(this.movies.get(result.snapshot.id)!, result.snapshot)
      if (changed) result.events.push({ type: 'frame', id: result.snapshot.id, epoch: result.snapshot.epoch,
        snapshot: { ...result.snapshot }, callbackFrame: result.snapshot.frame,
        pixels: { width: result.snapshot.originalWidth, height: result.snapshot.originalHeight,
          data: new Uint8Array(result.snapshot.enabledVideoStream === 1
            ? [0, 255, 0, 255, 0, 255, 0, 255] : [255, 0, 0, 255, 255, 0, 0, 255]) } })
    }
    return result
  }
  async late(snapshot: VideoSnapshot) {
    await Promise.all([...this.listeners].map((listener) => listener({ type: 'frame', id: snapshot.id,
      epoch: snapshot.epoch, snapshot, pixels: { width: 1, height: 1, data: new Uint8Array([0,0,255,255]) } })))
  }
}
const definitions = String.raw`
System.exitOnWindowClose=false;
var win=new Window(),movie=new VideoOverlay(win),root=new Layer(win,null);win.add(root);root.setSize(80,60);
var a=new Layer(win,root),b=new Layer(win,root);a.visible=b.visible=true;a.setPos(7,9,2,1);b.setPos(11,13,2,1);
var updates=[],statuses=[];
movie.onFrameUpdate=function(frame){updates.add(frame);};movie.onStatusChanged=function(status){statuses.add(status);};
function choose(value){movie.enabledVideoStream=value;return movie.enabledVideoStream;}
function publicState(){return [movie.enabledAudioStream,movie.enabledVideoStream,movie.status,movie.position,movie.playRate,movie.loop,movie.left,movie.top,movie.width,movie.height].join("|");}
`
async function fixture(binary: boolean) {
  const video = new Tracks(), f = await headless({ 'video-selection.tjs': definitions,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("video-selection.tjs","savedata/video-selection.cjs",false,true,false);Scripts.execStorage("savedata/video-selection.cjs");'
      : 'Scripts.execStorage("video-selection.tjs");', 'fixture.mp4': new Uint8Array([1]) }, { video })
  try { await f.session.start() }
  catch (error) {
    try { await f.session.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Video selection startup failed', { cause: error }) }
    throw error
  }
  return { ...f, video, exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(program + ';')})`) }
}
async function using(binary: boolean, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), failures: unknown[] = []
  try { await body(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.video.movies.size, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Video selection and cleanup failed', { cause: failures[0] })
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: video selection is the original writable property with native uint32 conversion and absent-graph no-ops`, { timeout: 60000 }, () => using(binary, async (f) => {
    assert.equal(await f.session.evaluate('[movie.numberOfVideoStream,movie.enabledVideoStream].join(",")'), '0,-1')
    await f.exec('movie.enabledVideoStream=4294967297')
    assert.equal(f.video.settings.length, 0)
    assert.equal(await f.session.evaluate('(function(){try{movie.enabledVideoStream=%[];return 0;}catch(e){return 1;}})()'), '1', 'Conversion precedes the absent-graph test')
    assert.equal(await f.session.evaluate('(function(){var n=0;try{movie.selectVideoStream(0);}catch(e){n++;}try{movie.disableVideoStream();}catch(e){n++;}try{movie.getNumberOfVideoStream();}catch(e){n++;}try{movie.numberOfVideoStream=4;}catch(e){n++;}return n;})()'), '4')
    await f.exec('movie.open("fixture.mp4")')
    assert.equal(await f.session.evaluate('choose(4294967297)'), '1')
    assert.equal(await f.session.evaluate('choose(-4294967296)'), '0')
    assert.equal(await f.session.evaluate('choose("4294967297")'), '1')
    assert.equal(await f.session.evaluate('choose(0.99)'), '0')
    assert.equal(await f.session.evaluate('choose(true)'), '1')
    assert.equal(await f.session.evaluate('choose(void)'), '0')
    const before = f.video.settings.length
    for (const value of ['-1', '-2', '2', '4294967295']) assert.equal(await f.session.evaluate(`choose(${value})`), '0')
    assert.equal(f.video.settings.length, before)
    await f.exec('movie.enabledVideoStream=1')
    assert.equal(f.video.settings.at(-1)!.settings.enabledVideoStream, 1, 'A discarded assignment still selects the stream')
    await f.exec('movie.close();movie.enabledVideoStream=1')
    assert.equal(await f.session.evaluate('[movie.numberOfVideoStream,movie.enabledVideoStream].join(",")'), '0,-1')
    await f.exec('movie.open("fixture.mp4")')
    assert.equal(await f.session.evaluate('movie.enabledVideoStream'), '0')
    assert.deepEqual(f.video.opened, [[0,0], [0,0]])
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves().find((file) => file.path === 'savedata/video-selection.cjs')!.bytes.subarray(0,4)), 'TJS2')
  }))
  test(`${mode}: selected video frames reach both current Layer bindings and preserve the other graph controls`, { timeout: 60000 }, () => using(binary, async (f) => {
    await f.exec('movie.mode=vomLayer;movie.layer1=a;movie.layer2=b;movie.setBounds(3,4,80,60);movie.open("fixture.mp4");movie.enabledAudioStream=1;movie.position=800;movie.playRate=2;movie.loop=true;movie.pause();statuses.clear();movie.enabledVideoStream=1;')
    assert.equal(await f.session.evaluate('publicState()'), '1|1|pause|800|2|1|0|0|320|240')
    assert.equal(await f.session.evaluate('[movie.originalWidth,movie.originalHeight,movie.fps,movie.numberOfFrame,movie.totalTime,movie.frame].join("|")'), '1|2|5|10|2000|4', 'Metadata is the backend result, not synthesized in the controller')
    assert.equal(await f.session.evaluate('[movie.layer1===a,movie.layer2===b,a.left,a.top,b.left,b.top,a.width,a.height,b.width,b.height,a.getMainPixel(0,0),b.getMainPixel(0,0)].join("|")'), '1|1|7|9|11|13|1|2|1|2|65280|65280')
    assert.equal(await f.session.evaluate('statuses.count+":"+updates.join(",")'), '0:4')
    await f.exec('invalidate b;movie.enabledVideoStream=0')
    assert.equal(await f.session.evaluate('[movie.layer2===null,a.width,a.height,a.getMainPixel(0,0),movie.enabledAudioStream].join("|")'), '1|2|1|16711680|1')
  }))
  test(`${mode}: failed candidate selection retains the old graph and rejects its obsolete frame epoch`, { timeout: 60000 }, () => using(binary, async (f) => {
    await f.exec('movie.mode=vomLayer;movie.layer1=a;movie.open("fixture.mp4");movie.enabledAudioStream=1;movie.pause();movie.position=800;')
    const before = { ...f.video.movies.get(f.video.onlyId())! }
    f.video.rejectSelection = true
    assert.match(await f.session.evaluate('(function(){try{movie.enabledVideoStream=1;}catch(e){return e.message;}return "missing";})()'), /candidate video selection failed/)
    assert.equal(await f.session.evaluate('publicState()'), '1|0|pause|800|1|0|0|0|320|240')
    const current = { ...f.video.movies.get(f.video.onlyId())! }
    assert(current.epoch > before.epoch)
    await f.video.late(before)
    assert.equal(await f.session.evaluate('updates.count'), '0')
    await f.exec('movie.enabledVideoStream=1')
    const selected = { ...f.video.movies.get(f.video.onlyId())! }
    await f.exec('movie.enabledVideoStream=1')
    assert.equal(f.video.movies.get(f.video.onlyId())!.epoch, selected.epoch, 'A same-index selection does not retire current frame ownership')
    assert.equal(await f.session.evaluate('updates.count'), '1')
  }))
  test(`${mode}: Stop during a pending selection cannot publish a late candidate or resume its TJS caller`, { timeout: 60000 }, () => using(binary, async (f) => {
    await f.exec('movie.mode=vomLayer;movie.layer1=a;movie.open("fixture.mp4")')
    const held = videoGate(); f.video.nextSelection = held
    const pending = Promise.allSettled([f.exec('movie.enabledVideoStream=1;Debug.message("after-video-switch")')])
    try {
      await Promise.race([held.entered, pending.then(() => { throw new Error('Video selection ended before the controlled candidate read') })])
      const stopped = f.session.stop()
      held.release(); await pending; await stopped
      assert(!f.logs.includes('after-video-switch'))
      assert.equal(f.video.latePixelReads, 0, 'Late canceled pixels must never enter a bound Layer')
      assert.equal(f.video.movies.size, 0)
    } finally { held.release(); await pending }
  }))
}

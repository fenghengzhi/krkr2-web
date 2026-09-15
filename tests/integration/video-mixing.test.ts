import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { videoFixture, videoGate } from '../helpers/video-lifetime.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import type { VideoCommand, VideoMixingBitmap, VideoResult } from '../../src/engine/ports/video.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const copy = (bitmap: VideoMixingBitmap): VideoMixingBitmap => ({
  pixels: { ...bitmap.pixels, data: Uint8Array.from(bitmap.pixels.data) },
  destination: { ...bitmap.destination },
  opacity: bitmap.opacity,
})

/** Independent backend ownership: source references reveal accidental sharing;
 * owned storage records what survives after source Layers are gone. */
class MixingVideoBackend extends LifetimeVideoBackend {
  readonly mixes = new Map<number, VideoMixingBitmap>()
  readonly captures: Extract<VideoCommand, { op: 'mixing' }>[] = []
  nextMix?: ReturnType<typeof videoGate>
  private heldMix?: ReturnType<typeof videoGate>

  override async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'mixing') {
      this.commands.push({ op: command.op, id: command.id })
      this.captures.push(command)
      const bitmap = command.bitmap && copy(command.bitmap),
        gate = this.nextMix
      this.nextMix = undefined
      this.heldMix = gate
      await gate?.wait()
      if (this.heldMix === gate) this.heldMix = undefined
      const movie = this.movies.get(command.id)
      // Cancellation may dispose the owned movie before a delayed reply.
      if (movie?.epoch === command.epoch) {
        if (bitmap) this.mixes.set(command.id, bitmap)
        else this.mixes.delete(command.id)
      }
      return { events: [] }
    }
    if (command.op === 'open' || command.op === 'close') this.mixes.delete(command.id)
    if (command.op === 'cancel') {
      this.mixes.clear()
      const result = await super.command(command)
      this.heldMix?.release()
      return result
    }
    return super.command(command)
  }

  override async close(): Promise<void> {
    this.mixes.clear()
    this.heldMix?.release()
    await super.close()
  }

  onlyMix(): VideoMixingBitmap {
    assert.equal(this.mixes.size, 1)
    return this.mixes.values().next().value!
  }
}

const definitions = String.raw`
var layerDeaths=0,paintCalls=0,root=new Layer(win,null);
class MixingSource extends Layer {
  function MixingSource(window,parent=null){super.Layer(window,parent);}
  function finalize(){global.layerDeaths++;}
  function onPaint(){global.paintCalls++;}
}
function createSource(window=win,parent=root){
  var result=new MixingSource(window,parent);
  result.setSize(2,1);result.setImageSize(2,1);result.visible=true;
  result.setMainPixel(0,0,0x123456);result.setMaskPixel(0,0,0);
  result.setMainPixel(1,0,0xabcdef);result.setMaskPixel(1,0,255);
  return result;
}
function openMixer(){makeMovie();movie.mode=2;movie.open("movie.mp4");}
function sourcePixels(layer){return [layer.getMainPixel(0,0),layer.getMaskPixel(0,0),layer.getMainPixel(1,0),layer.getMaskPixel(1,0)].join(",");}
`

async function fixture(binary: boolean, source: string) {
  const backend = new MixingVideoBackend(),
    f = await videoFixture(binary, definitions + source, { video: backend })
  return { ...f, backend }
}

const rgb = [0x12, 0x34, 0x56, 255, 0xab, 0xcd, 0xef, 255]
const pixels = (bitmap: VideoMixingBitmap) => [...bitmap.pixels.data]

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: mixing arguments require a native Layer before opening and reject forged identities`, async () => {
    const f = await fixture(
      binary,
      String.raw`
function scenario(){
  makeMovie();var source=createSource();var forged=%[__id:source.__id];var rejected=0;
  try{movie.setMixingLayer();}catch(e){rejected++;}
  try{movie.setMixingLayer(void);}catch(e){rejected++;}
  try{movie.setMixingLayer(42);}catch(e){rejected++;}
  try{movie.setMixingLayer("Layer");}catch(e){rejected++;}
  try{movie.setMixingLayer(win);}catch(e){rejected++;}
  try{movie.setMixingLayer(forged);}catch(e){rejected++;}
  var returns=movie.setMixingLayer(null)===void && movie.resetMixingLayer()===void;
  movie.mode=2;movie.open("movie.mp4");
  try{movie.setMixingLayer(forged);}catch(e){rejected++;}
  invalidate source;
  try{movie.setMixingLayer(source);}catch(e){rejected++;}
  return rejected+","+int(returns);
}
`,
    )
    try {
      assert.equal(await f.session.evaluate('scenario()'), '8,1')
      assert.equal(f.backend.captures.length, 0)
      assert.equal(f.backend.mixes.size, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: unopened mixing is not retained and visible image errors preserve the previous mix`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source,missing;
function unopened(){
  makeMovie();movie.mode=2;source=createSource();missing=createSource();missing.hasImage=false;
  movie.setMixingLayer(source);movie.setMixingLayer(missing);movie.resetMixingLayer();
  movie.open("movie.mp4");return 0;
}
function install(){return movie.setMixingLayer(source,"ignored")===void;}
function badVisible(){try{movie.setMixingLayer(missing);}catch(e){return e.message;}return "did not reject";}
function hiddenReset(){missing.visible=false;return movie.setMixingLayer(missing)===void;}
function nullReset(){movie.setMixingLayer(source);movie.setMixingLayer(null);return movie.resetMixingLayer()===void;}
`,
    )
    try {
      await f.session.evaluate('unopened()')
      assert.equal(f.backend.captures.length, 0)
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(await f.session.evaluate('install()'), '1')
      const original = copy(f.backend.onlyMix())
      assert.match(await f.session.evaluate('badVisible()'), /no drawable image/)
      assert.equal(f.backend.captures.length, 1)
      assert.deepEqual(f.backend.onlyMix(), original)
      assert.equal(await f.session.evaluate('hiddenReset()'), '1')
      assert.equal(f.backend.captures.at(-1)?.bitmap, null)
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(await f.session.evaluate('nullReset()'), '1')
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(f.backend.captures.length, 5)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: overlay and layer video modes still validate visible MainImage before their no-op`, async () => {
    const f = await fixture(
      binary,
      String.raw`
function scenario(){
  var source=createSource(),rejected=0,returns=0;
  for(var i=0;i<2;i++){
    makeMovie();movie.mode=i;movie.open("movie.mp4");
    if(movie.setMixingLayer(source)===void)returns++;
    source.hasImage=false;
    try{movie.setMixingLayer(source);}catch(e){rejected++;}
    source.visible=false;if(movie.setMixingLayer(source)===void)returns++;
    movie.resetMixingLayer();movie.close();invalidate movie;delete global.movie;
    source.hasImage=true;source.visible=true;
  }
  return rejected+","+returns;
}
`,
    )
    try {
      assert.equal(await f.session.evaluate('scenario()'), '2,4')
      assert.equal(f.backend.captures.length, 0)
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(f.backend.movies.size, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mixing snapshots raw MainImage RGB without ancestors, children, clips or source masks`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source,parent,child;
function scenario(){
  openMixer();parent=createSource();parent.visible=false;parent.opacity=0;parent.setPos(100,200);
  source=createSource(win,parent);source.opacity=128;source.type=ltAdditive;
  source.setSize(1,1);source.setPos(3,4);source.setImagePos(-1,0);source.setClip(1,0,1,1);
  child=createSource(win,source);child.fillRect(0,0,2,1,0xffff0000);child.visible=true;
  var before=sourcePixels(source),paints=paintCalls;movie.setMixingLayer(source);
  return before+":"+sourcePixels(source)+":"+(paintCalls-paints);
}
`,
    )
    try {
      assert.equal(
        await f.session.evaluate('scenario()'),
        '1193046,0,11259375,255:1193046,0,11259375,255:0',
      )
      const captured = f.backend.onlyMix()
      assert.deepEqual(pixels(captured), rgb)
      assert.deepEqual([captured.pixels.width, captured.pixels.height], [2, 1])
      assert.equal(captured.opacity, Math.fround(128 / 255))
      assert.deepEqual(captured.destination, {
        left: Math.fround(2.5 / 320),
        top: Math.fround(4.5 / 240),
        right: Math.fround(4.5 / 320),
        bottom: Math.fround(5.5 / 240),
      })
      assert.equal(f.backend.captures.length, 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mixing normalization uses current Window zoom and freezes geometry through output changes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source;
function capture(){
  openMixer();source=createSource();source.setImageSize(4,2);source.setSize(1,1);
  source.setPos(8,6);source.setImagePos(-2,-1);
  movie.setBounds(1,-1,5,3);win.setZoom(3,2);movie.setMixingLayer(source);return 0;
}
function resize(){movie.setBounds(17,21,9,7);win.setZoom(2,1);return 0;}
function recapture(){movie.setMixingLayer(source);return 0;}
function move(){movie.setPos(-11,33);movie.setMixingLayer(source);return 0;}
`,
    )
    try {
      await f.session.evaluate('capture()')
      const frozen = copy(f.backend.onlyMix())
      // MulDiv(6,3,2)-MulDiv(1,3,2)=9-2=7;
      // MulDiv(2,3,2)-MulDiv(-1,3,2)=3-(-2)=5.
      assert.deepEqual(frozen.destination, {
        left: Math.fround(6.5 / 7),
        top: Math.fround(5.5 / 5),
        right: Math.fround(10.5 / 7),
        bottom: Math.fround(7.5 / 5),
      })
      await f.session.evaluate('resize()')
      assert.equal(f.backend.captures.length, 1)
      assert.deepEqual(f.backend.onlyMix(), frozen)
      await f.session.evaluate('recapture()')
      assert.deepEqual(f.backend.onlyMix().destination, {
        left: Math.fround(6.5 / 18),
        top: Math.fround(5.5 / 14),
        right: Math.fround(10.5 / 18),
        bottom: Math.fround(7.5 / 14),
      })
      const resized = copy(f.backend.onlyMix())
      await f.session.evaluate('move()')
      assert.deepEqual(f.backend.onlyMix(), resized)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: editing, resizing and hiding a mixing source only changes a subsequent capture`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source;
function capture(){openMixer();source=createSource();movie.setMixingLayer(source);return 0;}
function edit(){
  source.setMainPixel(0,0,0x00ff00);source.setMaskPixel(1,0,0);
  source.setImageSize(1,1);source.setMainPixel(0,0,0x00ff00);source.setMaskPixel(0,0,0);
  source.setPos(9,8);source.opacity=0;source.visible=false;return 0;
}
function recapture(){source.visible=true;movie.setMixingLayer(source);return source.getMaskPixel(0,0);}
function opaque(){source.opacity=255;movie.setMixingLayer(source);return 0;}
`,
    )
    try {
      await f.session.evaluate('capture()')
      const frozen = copy(f.backend.onlyMix()),
        borrowedCommand = f.backend.captures[0]!.bitmap!
      await f.session.evaluate('edit()')
      assert.equal(f.backend.captures.length, 1)
      assert.deepEqual(f.backend.onlyMix(), frozen)
      assert.deepEqual(
        borrowedCommand,
        frozen,
        'the submitted command must not alias Layer storage',
      )
      assert.equal(await f.session.evaluate('recapture()'), '0')
      assert.deepEqual(pixels(f.backend.onlyMix()), [0, 255, 0, 255])
      assert.deepEqual(
        [f.backend.onlyMix().pixels.width, f.backend.onlyMix().pixels.height],
        [1, 1],
      )
      assert.equal(f.backend.onlyMix().opacity, 0)
      await f.session.evaluate('opaque()')
      assert.equal(f.backend.onlyMix().opacity, 1)
      assert.deepEqual(pixels(borrowedCommand), rgb)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mixing owns pixels without retaining its implicitly deleted or invalidated source Layer`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source;
function prepare(){openMixer();source=createSource();return 0;}
function capture(){movie.setMixingLayer(source);return 0;}
function drop(){delete global.source;return layerDeaths;}
function invalidateSource(){
  global.source=createSource();source.setMainPixel(0,0,0xff0000);movie.setMixingLayer(source);
  invalidate source;delete global.source;return layerDeaths;
}
`,
    )
    try {
      await f.session.evaluate('prepare()')
      const ownership = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles
      await f.session.evaluate('capture()')
      assert.deepEqual(f.session.inspectOwnership(), ownership)
      assert.equal(f.session.snapshot().handles, handles)
      assert.equal(await f.session.evaluate('drop()'), '1')
      assert.equal(f.session.inspectOwnership().layerSources, ownership.layerSources - 1)
      assert.deepEqual(pixels(f.backend.onlyMix()), rgb)
      assert.equal(await f.session.evaluate('invalidateSource()'), '2')
      assert.deepEqual(pixels(f.backend.onlyMix()), [255, 0, 0, 255, 0xab, 0xcd, 0xef, 255])
      assert.equal(f.backend.captures.length, 2)
      assert.equal(f.session.inspectOwnership().layerSources, ownership.layerSources - 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a real cross-Window Layer is accepted and its Window retirement leaves captured pixels alive`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var other,otherRoot,source,decoy;
function capture(){
  openMixer();other=new Window();otherRoot=new Layer(other,null);source=createSource(other,otherRoot);decoy=createSource(win);
  decoy.setMainPixel(0,0,0xff0000);source.__id=decoy.__id;
  movie.setMixingLayer(source);return 0;
}
function retireSource(){System.exitOnWindowClose=false;invalidate other;return (isvalid movie)+","+movie.status;}
`,
    )
    try {
      await f.session.evaluate('capture()')
      assert.deepEqual(
        pixels(f.backend.onlyMix()),
        rgb,
        'native Layer identity wins over writable __id',
      )
      const frozen = copy(f.backend.onlyMix())
      assert.equal(await f.session.evaluate('retireSource()'), '1,stop')
      assert.equal(f.backend.movies.size, 1)
      assert.equal(f.backend.captures.length, 1)
      assert.deepEqual(f.backend.onlyMix(), frozen)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mixing reset preserves movie settings and close/reopen never inherits a previous bitmap`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source,second;
function prepare(){
  openMixer();source=createSource();movie.mixingMovieAlpha=.25;movie.mixingMovieBGColor=0x102030;
  movie.play();movie.setMixingLayer(source);second=new LifetimeMovie();second.mode=2;second.open("movie.mp4");
  source.setMainPixel(0,0,0xff0000);second.setMixingLayer(source);return 0;
}
function reset(){movie.resetMixingLayer();return [movie.status,movie.mixingMovieAlpha,movie.mixingMovieBGColor].join(",");}
function reopen(){second.close();second.open("movie.mp4");return 0;}
`,
    )
    try {
      await f.session.evaluate('prepare()')
      assert.equal(f.backend.mixes.size, 2)
      const [first, second] = [...f.backend.mixes.values()]
      assert.deepEqual(pixels(first!), rgb)
      assert.deepEqual(pixels(second!), [255, 0, 0, 255, 0xab, 0xcd, 0xef, 255])
      assert.equal(await f.session.evaluate('reset()'), 'play,0.25,1056816')
      assert.equal(f.backend.mixes.size, 1)
      assert.deepEqual(f.backend.onlyMix(), second)
      await f.session.evaluate('reopen()')
      assert.equal(f.backend.movies.size, 2)
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(f.backend.captures.length, 3)
    } finally {
      await f.session.stop()
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(f.backend.movies.size, 0)
      assert.equal(f.backend.listeners.size, 0)
    }
  })

  test(`${mode}: Stop settles a held mixing reply and releases movie, Layer and native ownership`, async () => {
    const f = await fixture(
        binary,
        String.raw`
var source;
function prepare(){openMixer();source=createSource();return 0;}
function capture(){movie.setMixingLayer(source);completed++;return 0;}
`,
      ),
      gate = videoGate()
    let operation: Promise<string> | undefined,
      result: Promise<PromiseSettledResult<string>[]> | undefined
    try {
      await f.session.evaluate('prepare()')
      f.backend.nextMix = gate
      operation = f.session.evaluate('capture()')
      result = Promise.allSettled([operation])
      await Promise.race([
        gate.entered,
        operation.then(() => {
          throw new Error('Mixing command did not wait')
        }),
      ])
      assert.equal(f.backend.captures.length, 1)
      await f.session.stop()
      const [settled] = await result
      assert(settled)
      assert.equal(settled.status, 'rejected')
      if (settled.status === 'rejected') assert.match(String(settled.reason), /cancel/i)
      assert.equal(f.backend.movies.size, 0)
      assert.equal(f.backend.mixes.size, 0)
      assert.equal(f.backend.listeners.size, 0)
      assert.equal(f.backend.terminalCloses, 1)
      assert.equal(f.session.snapshot().handles, 0)
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } finally {
      gate.release()
      await result
      await f.session.stop()
    }
  })
}

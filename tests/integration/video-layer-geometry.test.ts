import test from 'node:test'
import assert from 'node:assert/strict'
import { videoFixture } from '../helpers/video-lifetime.ts'

const definitions = `
var root=new Layer(win,null);root.setSize(160,120);
var a=new Layer(win,root),b=new Layer(win,root),c=new Layer(win,root);
a.setSize(20,12);b.setSize(20,12);c.setSize(20,12);
a.visible=b.visible=c.visible=true;
makeMovie();movie.setBounds(9,10,32,24);movie.mode=vomLayer;movie.layer1=a;movie.layer2=b;
function positions(){return [a.left,a.top,b.left,b.top,movie.left,movie.top,movie.width,movie.height].join(",");}
function visibility(){return [a.visible,b.visible,c.visible,movie.visible].join(",");}
`
type Fixture = Awaited<ReturnType<typeof videoFixture>>
async function scenario(binary: boolean, body: (f: Fixture) => Promise<void>) {
  const f = await videoFixture(binary, definitions), failures: unknown[] = []
  try { await body(f) } catch (error) { failures.push(error) }
  try { await f.session.stop(); f.stopped() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Layer video geometry and cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const name = binary ? 'bytecode' : 'source'
  test(`${name}: layer video position changes both Layers while retaining its independent overlay rectangle`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('movie.setPos(17,23);')
      assert.equal(await f.session.evaluate('positions()'), '17,23,17,23,9,10,32,24')
      await f.execute('movie.left=-8;movie.top=6;movie.width=-100;movie.height=0;movie.setSize(-1,0);movie.setBounds(91,92,-1,0);')
      assert.equal(await f.session.evaluate('positions()'), '-8,6,-8,6,9,10,32,24')
      assert.equal(await f.session.evaluate('[a.width,a.height,b.width,b.height].join(",")'), '20,12,20,12')
      await f.execute('movie.layer1=null;movie.layer2=null;movie.setPos(101,102);')
      assert.equal(await f.session.evaluate('positions()'), '-8,6,-8,6,9,10,32,24')
      await f.execute('movie.layer1=a;movie.layer2=b;System.exitOnWindowClose=false;invalidate win;movie.setPos(3,4);')
      assert.equal(await f.session.evaluate('positions()'), '3,4,3,4,9,10,32,24', 'external Layers remain mutable after the media graph disconnects')
    }))
  test(`${name}: layer video visibility touches bindings only while its media graph is open`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('movie.visible=false;')
      assert.equal(await f.session.evaluate('visibility()'), '1,1,1,0')
      await f.execute('a.visible=b.visible=false;movie.visible=true;movie.open("movie.mp4");')
      assert.equal(await f.session.evaluate('visibility()'), '0,0,1,1', 'open must not replay visible into the Layers')
      await f.execute('movie.visible=true;')
      assert.equal(await f.session.evaluate('visibility()'), '1,1,1,1')
      await f.execute('movie.visible=false;')
      assert.equal(await f.session.evaluate('visibility()'), '0,0,1,0')
      await f.execute('movie.visible=0.5;')
      assert.equal(await f.session.evaluate('visibility()'), '1,1,1,1')
      await f.execute('movie.visible=void;')
      assert.equal(await f.session.evaluate('visibility()'), '0,0,1,0')
      await f.execute('movie.visible=%[];')
      assert.equal(await f.session.evaluate('visibility()'), '1,1,1,1')
      await f.execute('movie.visible=null;')
      assert.equal(await f.session.evaluate('visibility()'), '0,0,1,0')
      await f.execute('movie.close();a.visible=b.visible=true;movie.visible=false;')
      assert.equal(await f.session.evaluate('visibility()'), '1,1,1,0')
    }))
  test(`${name}: layer video preserves native first-slot effects when a later primary Layer rejects the operation`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('movie.layer2=root;movie.open("movie.mp4");')
      assert.equal(await f.session.evaluate('(function(){try{movie.setPos(12,13);}catch(e){return 1;}return 0;})()'), '1')
      assert.equal(await f.session.evaluate('[a.left,a.top,root.left,root.top,movie.left,movie.top].join(",")'), '12,13,0,0,9,10')
      assert.equal(await f.session.evaluate('(function(){try{movie.visible=false;}catch(e){return 1;}return 0;})()'), '1')
      assert.equal(await f.session.evaluate('[a.visible,root.visible,movie.visible].join(",")'), '0,1,0')
      await f.execute('movie.layer2=b;movie.visible=true;movie.setPos(4,5);')
      assert.equal(await f.session.evaluate('positions()'), '4,5,4,5,9,10,32,24')
    }))
  test(`${name}: a synchronous Layer blur can rebind the second video slot before it is read`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");a.focusable=true;a.focus();var blurCount=0;a.onBlur=function(next){global.blurCount++;global.movie.layer2=global.c;};movie.visible=false;')
      assert.equal(await f.session.evaluate('blurCount+":"+visibility()'), '1:0,1,0,0')
      assert.equal(await f.session.evaluate('movie.layer2===c'), '1')
      await f.execute('movie.layer2=b;movie.visible=true;a.focus();a.onBlur=function(next){global.movie.visible=true;};movie.visible=false;')
      assert.equal(await f.session.evaluate('[a.visible,b.visible,movie.visible].join(",")'), '1,1,1', 'Layer2 receives the visibility member after the reentrant first-slot callback')
    }))
  test(`${name}: invalidating a video in its first Layer callback retires the second mutation and releases native ownership`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");a.focusable=true;a.focus();a.onBlur=function(next){invalidate global.movie;};movie.visible=false;')
      assert.equal(await f.session.evaluate('[isvalid movie,a.visible,b.visible,finalized].join(",")'), '0,0,1,1')
      await f.session.idle()
      assert.equal(f.video.movies.size, 0)
      assert.equal(f.session.inspectOwnership().videoSources, 0)
    }))
  test(`${name}: video geometry enforces native arity and int32 conversion while decoded frames own layer dimensions`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      assert.equal(await f.session.evaluate('(function(){var n=0;try{movie.setPos(1);}catch(e){n++;}try{movie.setSize();}catch(e){n++;}try{movie.setBounds(1,2,3);}catch(e){n++;}return n;})()'), '3')
      await f.execute('movie.setPos(4294967303,-4294967287,"ignored");movie.open("movie.mp4");movie.play();')
      assert.equal(await f.session.evaluate('positions()'), '7,9,7,9,9,10,32,24')
      await f.video.emit(f.video.onlyId(), 'frame')
      assert.equal(await f.session.evaluate('[a.width,a.height,b.width,b.height,a.getMainPixel(0,0),b.getMainPixel(0,0)].join(",")'), '1,1,1,1,16711680,16711680')
      await f.execute('movie.setSize(99,88);movie.setBounds(40,50,99,88);')
      assert.equal(await f.session.evaluate('positions()'), '7,9,7,9,9,10,32,24')
      assert.equal(await f.session.evaluate('[a.width,a.height,b.width,b.height].join(",")'), '1,1,1,1')
    }))
  test(`${name}: video Layer binding uses native identity and can route geometry to another Window`,
    { timeout: 60000 }, () => scenario(binary, async (f) => {
      await f.execute('var otherWindow=new Window(),otherRoot=new Layer(otherWindow,null),other=new Layer(otherWindow,otherRoot);other.visible=true;movie.layer2=other;')
      await f.execute('movie.setPos(11,12);movie.open("movie.mp4");movie.visible=false;')
      assert.equal(await f.session.evaluate('[a.left,a.top,other.left,other.top,a.visible,other.visible,movie.layer2===other].join(",")'), '11,12,11,12,0,0,1')
      await f.execute('var forged=%[__id:a.__id,window:win];var errors=0;')
      assert.equal(await f.session.evaluate('(function(){try{movie.layer1=forged;}catch(e){global.errors++;}try{movie.layer1=win;}catch(e){global.errors++;}try{movie.layer1=42;}catch(e){global.errors++;}return global.errors+":"+(movie.layer1===a);})()'), '3:1')
      await f.execute('invalidate other;')
      assert.equal(await f.session.evaluate('movie.layer2===null'), '1')
      await f.execute('movie.setPos(7,8);movie.visible=true;')
      assert.equal(await f.session.evaluate('[a.left,a.top,a.visible].join(",")'), '7,8,1')
    }))
}

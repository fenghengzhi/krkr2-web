import test from 'node:test'
import assert from 'node:assert/strict'
import { videoFixture } from '../helpers/video-lifetime.ts'

const source = `
makeMovie();movie.mode=vomMixer;movie.setBounds(3,4,32,24);
function controls(){return [movie.playRate,movie.audioVolume,movie.audioBalance,movie.mixingMovieAlpha,movie.enabledAudioStream,movie.enabledVideoStream].join(",");}
function preferences(){return [movie.left,movie.top,movie.width,movie.height,movie.visible,movie.loop,movie.mode,movie.segmentLoopStartFrame,movie.segmentLoopEndFrame,movie.periodEventFrame].join(",");}
function changeGraph(){movie.playRate=2;movie.audioVolume=25000;movie.audioBalance=-50000;movie.mixingMovieAlpha=.25;movie.mixingMovieBGColor=0x102030;}
function closedWrites(){movie.playRate=-200;movie.audioVolume=-999;movie.audioBalance=1234567;movie.mixingMovieAlpha=4;movie.mixingMovieBGColor=0xaabbcc;}
`
type Fixture = Awaited<ReturnType<typeof videoFixture>>
async function scenario(binary: boolean, body: (f: Fixture) => Promise<void>) {
  const f = await videoFixture(binary, source), failures: unknown[] = []
  try { await body(f) } catch (error) { failures.push(error) }
  try { await f.session.stop(); f.stopped() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Graph-owned video settings and cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: unopened graph controls are no-ops while VideoOverlay retains its object preferences`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      assert.equal(await f.session.evaluate('controls()'), '0,100000,0,0,-1,-1')
      await f.execute('closedWrites();movie.visible=.5;movie.loop=.5;movie.setSegmentLoop(1,2);movie.setPeriodEvent(2);')
      assert.equal(await f.session.evaluate('controls()'), '0,100000,0,0,-1,-1')
      assert.equal(await f.session.evaluate('preferences()'), '3,4,32,24,1,1,2,1,2,2')
      assert.equal(f.video.commands.length, 0)
      await f.execute('movie.open("movie.mp4");')
      const graph = f.video.movies.get(f.video.onlyId())!
      assert.deepEqual([graph.playRate, graph.audioVolume, graph.audioBalance, graph.mixingMovieAlpha, graph.mixingMovieBGColor], [1, 100000, 0, 1, 0])
      assert.equal(await f.session.evaluate('preferences()'), '3,4,32,24,1,1,2,1,2,2')
    }))
  test(`${label}: close and reopen reset graph-owned controls without erasing the independent object rectangle and loop`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.loop=true;movie.open("movie.mp4");changeGraph();')
      let graph = f.video.movies.get(f.video.onlyId())!
      assert.deepEqual([graph.playRate, graph.audioVolume, graph.audioBalance, graph.mixingMovieAlpha, graph.mixingMovieBGColor], [2, 25000, -50000, .25, 0x102030])
      await f.execute('movie.close();')
      assert.equal(await f.session.evaluate('controls()'), '0,100000,0,0,-1,-1')
      assert.equal(f.video.movies.size, 0)
      await f.execute('closedWrites();movie.open("movie.mp4");')
      graph = f.video.movies.get(f.video.onlyId())!
      assert.deepEqual([graph.playRate, graph.audioVolume, graph.audioBalance, graph.mixingMovieAlpha, graph.mixingMovieBGColor], [1, 100000, 0, 1, 0])
      assert.equal(await f.session.evaluate('preferences()'), '3,4,32,24,0,1,2,-1,-1,-1')
    }))
  test(`${label}: zero and negative active play rates are native no-ops and still preserve binding conversion errors`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");movie.playRate=2;')
      const changes = f.video.commands.filter((entry) => entry.op === 'set').length
      await f.execute('movie.playRate=0;movie.playRate=-1;')
      assert.equal(await f.session.evaluate('movie.playRate'), '2')
      assert.equal(f.video.commands.filter((entry) => entry.op === 'set').length, changes)
      assert.equal(await f.session.evaluate('(function(){try{movie.playRate=%[];}catch(e){return 1;}return 0;})()'), '1')
      await f.execute('movie.close();')
      assert.equal(await f.session.evaluate('(function(){try{movie.playRate=%[];}catch(e){return 1;}return 0;})()'), '1', 'the TJS conversion precedes the no-graph early return')
    }))
  test(`${label}: a failed new graph cannot retain controls from the old graph or closed writes before retry`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");changeGraph();')
      f.video.failOpen = new Error('new-graph-open-failure')
      await assert.rejects(f.execute('movie.open("movie.mp4");'), /new-graph-open-failure/)
      assert.equal(await f.session.evaluate('controls()'), '0,100000,0,0,-1,-1')
      await f.execute('closedWrites();movie.open("movie.mp4");')
      const graph = f.video.movies.get(f.video.onlyId())!
      assert.deepEqual([graph.playRate, graph.audioVolume, graph.audioBalance, graph.mixingMovieAlpha], [1, 100000, 0, 1])
      assert.equal(f.video.movies.size, 1)
    }))
  test(`${label}: Window disconnect exposes closed graph defaults and boolean loop conversion remains independent`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.loop=%[];movie.open("movie.mp4");changeGraph();System.exitOnWindowClose=false;invalidate win;')
      assert.equal(await f.session.evaluate('movie.loop+"|"+controls()'), '1|0,100000,0,0,-1,-1')
      await f.execute('closedWrites();movie.loop=null;')
      assert.equal(await f.session.evaluate('movie.loop+"|"+controls()'), '0|0,100000,0,0,-1,-1')
      assert.equal(f.video.movies.size, 0)
      await assert.rejects(f.execute('movie.open("movie.mp4");'), /disconnected/)
    }))
}

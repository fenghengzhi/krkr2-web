import assert from 'node:assert/strict'
import test from 'node:test'
import type { VideoCommand, VideoEvent, VideoResult } from '../../src/engine/ports/video.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import { headless } from '../helpers/headless.ts'
import { AudioClock } from '../helpers/audio.ts'

/** Frame tokens are supplied independently by this controlled producer. The
 * browser suite separately proves real rVFC, decoded pixels and two Layers. */
class PrepareBackend extends LifetimeVideoBackend {
  readonly tokens = new Map<number, number>()
  readonly wire: VideoCommand[] = []
  override async command(command: VideoCommand): Promise<VideoResult> {
    this.wire.push(command)
    const result = await super.command(command)
    if (command.op === 'open') {
      this.tokens.set(command.id, command.prepareToken ?? 0)
      Object.assign(this.movies.get(command.id)!, { originalWidth: 2, originalHeight: 1,
        numberOfVideoStream: 2, numberOfAudioStream: 2 })
      result.snapshot = { ...this.movies.get(command.id)! }
    } else if (command.op === 'prepare') this.tokens.set(command.id, command.token)
    else if (command.op === 'close') this.tokens.delete(command.id)
    return result
  }
  frame(token = this.tokens.get(this.onlyId()) ?? 0): VideoEvent & { type: 'frame' } {
    const id = this.onlyId(), snapshot = { ...this.movies.get(id)!, frame: 1, position: 33 }
    return { type: 'frame', id, epoch: snapshot.epoch, snapshot, callbackFrame: 1, prepareToken: token,
      pixels: { width: 2, height: 1, data: Uint8Array.of(193, 41, 23, 255, 17, 83, 149, 255) } }
  }
  deliver(event: VideoEvent): Promise<void> {
    return Promise.all([...this.listeners].map((listener) => listener(event))).then(() => {})
  }
}

const source = String.raw`
System.exitOnNoWindowStartup=false;
var win=new Window();win.visible=true;win.setInnerSize(4,1);
var left=new Layer(win,null),right=new Layer(win,left);
left.setSize(2,1);right.setSize(2,1);right.left=2;
left.fillRect(0,0,2,1,0xff0000ff);right.fillRect(0,0,2,1,0xff0000ff);
var trace=[],action="",errors=[];
function prepareAction(movie,where){
 var selected=global.action;
 if(selected==where+"-play"){movie.play();global.trace.add("inner:"+movie.status);}
 else if(selected==where+"-close")movie.close();
 else if(selected==where+"-reopen"){movie.open("second.mp4");movie.play();}
 else if(selected==where+"-switch")movie.enabledVideoStream=1;
 else if(selected==where+"-prepare"){global.action="";movie.prepare();}
 else if(selected==where+"-throw")throw new Exception("prepare-"+where);
}
class PreparedMovie extends VideoOverlay {
 function PreparedMovie(w){super.VideoOverlay(w);}
 function onStatusChanged(value){global.trace.add("status:"+value);}
 function onFrameUpdate(frame){
  global.trace.add("frame:"+frame+":"+status+":"+global.left.getMainPixel(0,0)+":"+global.right.getMainPixel(0,0));
  global.prepareAction(this,"frame");
 }
 function onPeriod(reason){global.trace.add("period:"+reason+":"+status);global.prepareAction(this,"period");}
}
var movie=new PreparedMovie(win);movie.mode=vomLayer;movie.layer1=left;movie.layer2=right;
function ready(){movie.open("movie.mp4");global.trace=[];global.action="";}
function prepareNow(value=""){global.action=value;global.trace=[];movie.prepare();global.trace.add("return:"+movie.status);}
function handledPrepare(error){global.errors.add(error.message);return true;}
function unhandledPrepare(error){global.errors.add(error.message);return false;}
`

async function fixture(binary: boolean,
  body: (f: Awaited<ReturnType<typeof headless>>, backend: PrepareBackend) => Promise<void>) {
  const backend = new PrepareBackend(), clock = new AudioClock(), failures: unknown[] = [],
    f = await headless({ 'startup.tjs': '', 'prepare.tjs': source, 'movie.mp4': Uint8Array.of(1),
      'second.mp4': Uint8Array.of(2) }, { video: backend, now: () => clock.now, schedule: clock.schedule })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("prepare.tjs","savedata/prepare.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/prepare.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("prepare.tjs")')
    await body(f, backend)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(backend.movies.size, 0); assert.equal(backend.listeners.size, 0)
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Video prepare or cleanup failed', { cause: failures[0] })
}

async function settleDelivery(session: Awaited<ReturnType<typeof headless>>['session'], delivery: Promise<void>,
  observe: () => Promise<void>): Promise<void> {
  const errors: unknown[] = []
  // Observe immediately even if the native receipt fails before the next VM
  // checkpoint; keep its original rejection for the ordered final settlement.
  const settled = delivery.then(() => undefined, (error: unknown) => { errors.push(error) })
  let primary: unknown, failed = false
  try { await observe() } catch (error) { primary = error; failed = true }
  if (failed) {
    try { await session.stop() } catch (error) { errors.push(error) }
  }
  await settled
  if (failed) errors.unshift(primary)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Prepare observation and delivery failed', { cause: errors[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: Prepare plays until a real bound-layer frame, then reports and pauses in native order`, { timeout: 60000 },
    () => fixture(binary, async ({ session }, backend) => {
      assert.equal(await session.evaluate('(movie.prepare(),movie.status)'), 'unload')
      for (const mode of [0, 2, 3]) {
        await session.evaluate(`(movie.mode=${mode},ready(),prepareNow(),0)`)
        assert.equal(await session.evaluate('trace.join("|")'), 'return:stop')
        await session.evaluate('movie.close()')
      }
      await session.evaluate('(movie.mode=1,ready(),prepareNow(),0)')
      assert.equal(await session.evaluate('trace.join("|")'), 'status:pause|status:play|return:play')
      assert.deepEqual(backend.wire.slice(-5).map((command) => command.op), ['pause', 'rewind', 'prepare', 'play', 'inspect'])
      const frame = backend.frame(), expected = 'status:pause|status:play|return:play|frame:1:play:12658967:12658967|period:2:play|status:pause'
      await backend.deliver(frame)
      assert.equal(await session.evaluate('trace.join("|")'), expected)
      assert.equal(await session.evaluate('movie.status+":"+movie.frame'), 'pause:0')
      assert.equal(backend.tokens.get(backend.onlyId()), 0)
      assert.equal(await session.evaluate('left.getMainPixel(1,0)+":"+right.getMainPixel(1,0)'), '1135509:1135509')
      await session.evaluate('(ready(),prepareNow(),0)')
      const unindexed = backend.frame()
      unindexed.snapshot.frame = -1
      delete unindexed.callbackFrame
      await backend.deliver(unindexed)
      assert.equal(await session.evaluate('trace.join("|")'), 'status:pause|status:play|return:play|period:2:play|status:pause',
        'An actual unindexed frame completes Prepare without inventing onFrameUpdate(-1)')
      const paused = backend.frame()
      paused.snapshot.status = 'pause'; paused.prepareToken = 0
      await backend.deliver(paused)
      assert.match(await session.evaluate('trace.join("|")'), /frame:1:pause:12658967:12658967$/,
        'Legacy embedding producers can still deliver an explicit paused frame')
      await session.evaluate('(ready(),movie.layer1=null,movie.layer2=null,prepareNow(),0)')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('trace.join("|")'), 'status:pause|status:play|return:play')
      assert.equal(await session.evaluate('(movie.layer2=right,movie.status)'), 'play')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('movie.status'), 'pause')
    }))

  test(`${mode}: Prepare completion follows callback play, reopen, switch and nested prepare on the current object`, { timeout: 60000 },
    () => fixture(binary, async ({ session }, backend) => {
      for (const action of ['frame-play', 'period-play', 'frame-reopen', 'period-reopen', 'frame-switch', 'period-switch', 'frame-prepare', 'period-prepare']) {
        await session.evaluate(`(ready(),prepareNow(${JSON.stringify(action)}),0)`)
        await backend.deliver(backend.frame())
        const trace = await session.evaluate('trace.join("|")')
        assert.match(trace, /frame:1:play:12658967:12658967/)
        assert.match(trace, /period:2:play/)
        assert.equal(await session.evaluate('movie.status+":"+movie.frame'), 'pause:0', action)
        assert.equal(backend.tokens.get(backend.onlyId()), 0, action)
        if (action.endsWith('switch')) assert.equal(await session.evaluate('movie.enabledVideoStream'), '1')
        if (action.endsWith('reopen')) assert.equal(backend.wire.filter((command) => command.op === 'open').at(-1)?.name, 'second.mp4')
      }
      for (const action of ['frame-close', 'period-close']) {
        await session.evaluate(`(ready(),prepareNow(${JSON.stringify(action)}),0)`)
        await backend.deliver(backend.frame())
        assert.equal(await session.evaluate('movie.status'), 'unload')
        assert.equal(backend.movies.size, 0)
        assert.match(await session.evaluate('trace.join("|")'), action === 'frame-close' ? /period:2:unload/ : /period:2:play/)
        await session.evaluate('ready()')
        assert.equal(backend.tokens.get(backend.onlyId()), 0, 'The completed object latch is cleared after closing')
      }
    }))

  test(`${mode}: disabled immediate callbacks do not prevent native Prepare retirement`, { timeout: 60000 },
    () => fixture(binary, async ({ session }, backend) => {
      await session.evaluate('(ready(),prepareNow(),System.eventDisabled=true,0)')
      const delivery = backend.deliver(backend.frame())
      await settleDelivery(session, delivery, async () => {
        await session.idle()
        assert.equal(await session.evaluate('movie.status+":"+movie.frame'), 'pause:0')
        assert.equal(await session.evaluate('trace.join("|")'), 'status:pause|status:play|return:play')
        assert.equal(await session.evaluate('left.getMainPixel(0,0)'), '12658967')
        await session.evaluate('System.eventDisabled=false')
      })
    }))

  test(`${mode}: callback errors, stale same-epoch frames and Stop preserve Prepare ownership`, { timeout: 60000 },
    () => fixture(binary, async ({ session }, backend) => {
      await session.evaluate('(System.exceptionHandler=handledPrepare,ready(),prepareNow("frame-throw"),0)')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('errors.join("|")+":"+movie.status+":"+movie.frame'), 'prepare-frame:pause:0')
      assert.match(await session.evaluate('trace.join("|")'), /period:2:play\|status:pause$/)
      await session.evaluate('(ready(),prepareNow("period-throw"),0)')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('errors.join("|")+":"+movie.status'), 'prepare-frame|prepare-period:pause')
      await session.evaluate('(System.exceptionHandler=unhandledPrepare,ready(),prepareNow("frame-throw"),0)')
      const failed = backend.deliver(backend.frame())
      await settleDelivery(session, failed, async () => {
        await session.idle()
        assert.equal(await session.evaluate('System.eventDisabled+":"+movie.status+":"+movie.frame'), '1:pause:0')
        assert.doesNotMatch(await session.evaluate('trace.join("|")'), /period:/,
          'Unhandled immediate error disables user events before perPrepare, but native completion continues')
        await session.evaluate('(System.eventDisabled=false,System.exceptionHandler=handledPrepare,0)')
      })
      await session.evaluate('(ready(),prepareNow(),0)')
      const live = backend.frame(), stale = backend.frame(0), trace = await session.evaluate('trace.join("|")')
      await backend.deliver(stale)
      assert.equal(await session.evaluate('trace.join("|")'), trace)
      assert.equal(await session.evaluate('movie.status'), 'play')
      await backend.deliver(live)
      const completed = await session.evaluate('trace.join("|")')
      // Same current epoch, but an old prepare token: cannot resurrect play or
      // apply a decoder's old pixels after its native completion cleared it.
      const late = { ...live, epoch: backend.movies.get(backend.onlyId())!.epoch }
      if (late.type !== 'error') late.snapshot = { ...late.snapshot, epoch: late.epoch }
      await backend.deliver(late)
      assert.equal(await session.evaluate('trace.join("|")'), completed)
      assert.equal(await session.evaluate('movie.status'), 'pause')
      await session.evaluate('(ready(),prepareNow(),0)')
      const oldGraph = backend.frame(), oldToken = backend.tokens.get(backend.onlyId())
      await session.evaluate('(movie.close(),movie.prepare(),movie.open("second.mp4"),movie.play(),trace=[],0)')
      assert.equal(backend.tokens.get(backend.onlyId()), oldToken, 'Close/Open retain the object prepare latch')
      await backend.deliver(oldGraph)
      assert.equal(await session.evaluate('trace.count'), '0', 'A retired graph cannot complete the retained latch')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('movie.status'), 'pause')
      assert.match(await session.evaluate('trace.join("|")'), /period:2:play\|status:pause$/)
      await session.evaluate('(ready(),prepareNow(),0)')
      const cancelled = backend.frame(), listeners = [...backend.listeners]
      await session.stop()
      await Promise.all(listeners.map((listener) => listener(cancelled)))
      assert.equal(backend.movies.size, 0)
    }))
}

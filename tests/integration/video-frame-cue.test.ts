import assert from 'node:assert/strict'
import test from 'node:test'
import type { VideoCommand, VideoEvent, VideoResult } from '../../src/engine/ports/video.ts'
import { VideoPeriod } from '../../src/engine/media/video-period.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import { AudioClock } from '../helpers/audio.ts'
import { headless } from '../helpers/headless.ts'

class FrameCueBackend extends LifetimeVideoBackend {
  readonly takes: number[] = []
  readonly tokens = new Map<number, number>()
  readonly completions: number[] = []
  private nextDelivery = 1
  private pendingEnd?: { id: number; token: number }
  override async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'frameDone') {
      this.completions.push(command.token)
      if (this.pendingEnd?.id === command.id && this.pendingEnd.token === command.token) {
        const state = this.movies.get(command.id)
        if (state) state.status = 'stop'
        this.pendingEnd = undefined
      }
      return { events: [] }
    }
    const result = await super.command(command)
    if (!('id' in command) || command.op === 'close') return result
    const state = this.movies.get(command.id)!
    if (command.op === 'open') {
      state.periodEventPast = command.periodEventPast ?? false
      this.tokens.set(command.id, command.prepareToken ?? 0)
    } else if (command.op === 'prepare') this.tokens.set(command.id, command.token)
    else if (command.op === 'period') {
      state.periodEventFrame = command.frame; state.periodEventPast = command.frame <= state.frame
    } else if (command.op === 'periodTake') {
      this.takes.push(command.frame)
      const cue = new VideoPeriod(state.periodEventFrame, state.periodEventPast)
      if (cue.take(command.frame)) {
        state.periodEventFrame = cue.frame
        result.events.push({ type: 'period', id: command.id, epoch: state.epoch, snapshot: { ...state }, reason: 1 })
      }
    }
    result.snapshot = { ...state }
    return result
  }
  frame(frame = 6, deferredPeriod = true): VideoEvent & { type: 'frame' } {
    const id = this.onlyId(), state = this.movies.get(id)!
    state.frame = frame; state.position = frame * 1000 / 30
    return { type: 'frame', id, epoch: state.epoch, snapshot: { ...state }, callbackFrame: frame,
      prepareToken: this.tokens.get(id) ?? 0, deferredPeriod, deliveryToken: this.nextDelivery++,
      pixels: { width: 1, height: 1, data: Uint8Array.of(193, 41, 23, 255) } }
  }
  finishAfter(event: VideoEvent & { type: 'frame' }) {
    this.pendingEnd = { id: event.id, token: event.deliveryToken! }
  }
  async deliver(event: VideoEvent) { await Promise.all([...this.listeners].map((listener) => listener(event))) }
}

const source = String.raw`
System.exitOnNoWindowStartup=false;
var w=new Window();w.setInnerSize(2,1);w.visible=true;
var a=new Layer(w,null),b=new Layer(w,a);a.setSize(1,1);b.setPos(1,0,1,1);
var trace=[],action="",errors=[];
class FrameCueMovie extends VideoOverlay {
 function FrameCueMovie(w){super.VideoOverlay(w);}
 function onFrameUpdate(f){
  global.trace.add("frame:"+f+":"+status+":"+global.a.getMainPixel(0,0)+":"+global.b.getMainPixel(0,0));
  var op=global.action;global.action="";
  if(op=="cancel")cancelPeriodEvent();
  else if(op=="future")periodEventFrame=12;
  else if(op=="past")periodEventFrame=f;
  else if(op=="seek"){frame=0;periodEventFrame=1;}
  else if(op=="close")close();
  else if(op=="reopen")open("second.mp4");
  else if(op=="pause")pause();
  else if(op=="prepare")prepare();
  else if(op=="throw")throw new Exception("frame-cue-error");
  global.trace.add("return:"+status);
 }
 function onPeriod(reason){global.trace.add("period:"+reason+":"+status+":"+periodEventFrame);}
}
var movie=new FrameCueMovie(w);movie.mode=vomLayer;movie.layer1=a;movie.layer2=b;
function beginCue(op="",mode=1){
 movie.close();movie.mode=mode;movie.open("movie.mp4");movie.periodEventFrame=6;movie.play();
 global.action=op;global.trace=[];
}
function handledCue(error){global.errors.add(error.message);return true;}
function unhandledCue(error){global.errors.add(error.message);return false;}
`

async function fixture(binary: boolean, body: (session: Awaited<ReturnType<typeof headless>>['session'], backend: FrameCueBackend) => Promise<void>) {
  const clock = new AudioClock(), backend = new FrameCueBackend(), failures: unknown[] = [],
    { session } = await headless({ 'startup.tjs': '', 'cue.tjs': source,
      'movie.mp4': Uint8Array.of(1), 'second.mp4': Uint8Array.of(2) },
    { video: backend, now: () => clock.now, schedule: clock.schedule })
  try {
    await session.start()
    if (binary) {
      await session.evaluate('Scripts.compileStorage("cue.tjs","savedata/cue.cjs",false,true,false)')
      await session.evaluate('Scripts.execStorage("savedata/cue.cjs")')
    } else await session.evaluate('Scripts.execStorage("cue.tjs")')
    await body(session, backend)
  } catch (error) { failures.push(error) }
  try {
    await session.stop(); assert.equal(backend.movies.size, 0); assert.equal(backend.listeners.size, 0)
    assert.equal(clock.tasks.size, 0); assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Video frame cue or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const variant = binary ? 'bytecode' : 'source'
  test(`${variant}: movie frame callbacks cancel, rearm and consume cues on the current object in native order`, { timeout: 60000 },
    () => fixture(binary, async (session, backend) => {
      const prefix = 'frame:6:play:12658967:12658967|return:'
      for (const action of ['', 'cancel', 'past', 'seek', 'pause', 'close', 'reopen', 'prepare']) {
        await session.evaluate(`beginCue(${JSON.stringify(action)})`)
        await backend.deliver(backend.frame())
        const status = action === 'close' ? 'unload' : action === 'reopen' ? 'stop' : action === 'pause' ? 'pause' : 'play',
          suffix = action === 'cancel' || action === 'past' ? '' : action === 'prepare'
            ? '|period:2:play:6' : `|period:1:${status}:-1`
        assert.equal(await session.evaluate('trace.join("|")'), prefix + status + suffix, action)
        if (action === 'prepare') assert.equal(await session.evaluate('movie.status+":"+movie.frame'), 'pause:0')
      }
      await session.evaluate('beginCue("future")'); await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('trace.join("|")+":"+movie.periodEventFrame'), prefix + 'play:12')
      await backend.deliver(backend.frame(12))
      assert.match(await session.evaluate('trace.join("|")'), /frame:12:play:12658967:12658967\|return:play\|period:1:play:-1$/)
      // The mixer has no Layer binding requirement but still runs the same
      // immediate callback-before-cue rule.
      await session.evaluate('(movie.layer1=null,movie.layer2=null,beginCue("cancel",2),0)')
      await backend.deliver(backend.frame())
      assert.doesNotMatch(await session.evaluate('trace.join("|")'), /period:/)
      assert.equal(await session.evaluate('movie.periodEventFrame'), '-1')
    }))

  test(`${variant}: disabled/error frame continuations consume state without user delivery and retired frames cannot consume new cues`, { timeout: 60000 },
    () => fixture(binary, async (session, backend) => {
      // Internal state must finish while disabled; present-frame receipt is
      // allowed to wait until re-enabled, just as the Prepare regression does.
      const settle = async (delivery: Promise<void>, inspect: () => Promise<void>) => {
        const failures: unknown[] = [], done = delivery.catch((error: unknown) => { failures.push(error) })
        try { await inspect() } catch (error) {
          failures.unshift(error)
          try { await session.stop() } catch (cleanup) { failures.push(cleanup) }
        }
        await done
        if (failures.length) throw new AggregateError(failures, 'Cue observation and receipt failed', { cause: failures[0] })
      }
      await session.evaluate('(beginCue(),System.eventDisabled=true,0)')
      const last = backend.frame(); backend.finishAfter(last)
      await settle(backend.deliver(last), async () => {
        await session.idle()
        assert.equal(await session.evaluate('trace.count+":"+movie.periodEventFrame+":"+a.getMainPixel(0,0)+":"+movie.status'), '0:-1:12658967:stop')
        assert.equal(backend.completions.at(-1), last.deliveryToken,
          'Native completion permits EOF while the distinct screen receipt remains deferred')
        await session.evaluate('System.eventDisabled=false')
      })
      await session.evaluate('(System.exceptionHandler=handledCue,beginCue("throw"),0)')
      await backend.deliver(backend.frame())
      assert.equal(await session.evaluate('trace.join("|")'), 'frame:6:play:12658967:12658967|period:1:play:-1')
      await session.evaluate('(System.exceptionHandler=unhandledCue,beginCue("throw"),0)')
      await settle(backend.deliver(backend.frame()), async () => {
        await session.idle()
        assert.equal(await session.evaluate('System.eventDisabled+":"+movie.periodEventFrame'), '1:-1')
        assert.doesNotMatch(await session.evaluate('trace.join("|")'), /period:/)
        await session.evaluate('(System.eventDisabled=false,System.exceptionHandler=handledCue,0)')
      })
      await session.evaluate('beginCue()'); const stale = backend.frame()
      await session.evaluate('beginCue()'); const before = backend.takes.length
      await backend.deliver(stale)
      assert.equal(backend.takes.length, before); assert.equal(await session.evaluate('trace.count+":"+movie.periodEventFrame'), '0:6')
      await backend.deliver(backend.frame(6, false))
      assert.equal(backend.takes.length, before, 'Legacy embedding frames do not acquire a second cue source')
      await backend.emit(backend.onlyId(), 'period')
      assert.match(await session.evaluate('trace.join("|")'), /period:1:play:6$/)
      await session.stop(); await backend.deliver(stale)
      assert.equal(backend.takes.length, before)
    }))
}

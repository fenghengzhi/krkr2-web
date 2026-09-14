import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import { AudioClock } from './audio.ts'
import { LifetimeAudioBackend } from './sound-lifetime-audio.ts'
import { LifetimeVideoBackend, videoGate } from './video-lifetime-backend.ts'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const definitions = `
var calls=0,finalized=0,receiver="",caught="",failVideo=false;
try{throw new Exception("warm video runtime");}catch(e){}
var win=new Window();
class LifetimeMovie extends VideoOverlay {
  var marker="movie-owner";
  function LifetimeMovie(){super.VideoOverlay(win);}
  function finalize(){finalized++;if(failVideo)throw new Exception("retry-video");}
}
function makeMovie(mode=0){global.movie=new LifetimeMovie();movie.mode=mode;movie.open("movie.mp4");movie.play();}
function returnedMovie(){var result=new LifetimeMovie();result.open("movie.mp4");result.play();return result;}
function replacement(status){receiver=this.marker+":"+status;calls++;}
function lastEvent(value){calls++;delete global.movie;}
`

/** Real Session/VM ownership; deterministic media ports count independent resources. */
export async function exerciseVideoLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  binary: boolean,
) {
  const audio = new LifetimeAudioBackend(),
    video = new LifetimeVideoBackend(),
    clock = new AudioClock(),
    logs: string[] = []
  let rendererCloses = 0
  const session = new EngineSession({
    audio,
    video,
    now: () => clock.now,
    schedule: clock.schedule,
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { control, wasmBinary, variant, ...options }),
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    renderer: {
      present() {},
      dispose() {
        rendererCloses++
      },
    },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected video image decode')
      },
      text: () => {
        throw new Error('Unexpected video text drawing')
      },
    },
    inflateImage,
    deflateImage,
    decodeScript: readScript,
    readText,
    writeText,
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  const state = () => ({
    ...session.inspectOwnership(),
    handles: session.snapshot().handles,
    movies: video.movies.size,
    voices: audio.voices.size,
    clockTasks: clock.tasks.size,
  })
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  const cases: {
    name: string
    owned: ReturnType<typeof state>
    retired: ReturnType<typeof state>
    result: string
  }[] = []
  let baseline: ReturnType<typeof state> | undefined,
    active = 'initialize',
    delivery: Promise<void> | undefined,
    closeGate: ReturnType<typeof videoGate> | undefined
  const restored = async () => {
    await session.idle()
    const value = state()
    check(
      JSON.stringify(value) === JSON.stringify(baseline),
      'Video resources did not return to baseline: ' + JSON.stringify(value),
    )
    check(session.snapshot().state === 'running', 'Video ownership stopped the session')
    return value
  }
  try {
    await session.initialize()
    session.mount(
      Object.entries({
        'startup.tjs': '',
        'video-lifetime.tjs': definitions,
        'movie.mp4': new Uint8Array([1, 2, 3]),
      }).map(([name, source]) => {
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source
        return { name, size: bytes.length, read: async () => bytes }
      }),
    )
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("video-lifetime.tjs","savedata/video-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/video-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("video-lifetime.tjs")')
    await execute(
      'var warmVideo=new VideoOverlay(win);warmVideo.status;invalidate warmVideo;delete global.warmVideo;',
    )
    check((await session.evaluate('6*7')) === '42', 'Video warmup failed')
    baseline = state()
    const owned = () => {
      const value = state()
      check(
        value.videoSources === baseline!.videoSources + 1 &&
          value.weakOwners === baseline!.weakOwners + 2,
        'Video owner and window registrations are not weak',
      )
      check(value.movies === 1, 'Video backend did not acquire its resource')
      return value
    }

    active = 'implicit-resource-release'
    await execute('makeMovie();')
    const first = owned()
    check(
      (await session.evaluate('win.__windowObjects.count')) === '0',
      'Video was retained through Window.add',
    )
    await execute('delete global.movie;')
    const retired = await restored()
    check(
      (await session.evaluate('finalized')) === '1',
      'Implicit video finalizer did not run once',
    )
    cases.push({ name: active, owned: first, retired, result: '1' })

    active = 'returned-object-release'
    await execute('finalized=0;')
    const beforeReturned = state()
    const returned = await session.evaluate('returnedMovie()')
    check(returned === '[TJS object]', 'Console did not display the returned video')
    const returnedRetired = await restored()
    check(
      (await session.evaluate('finalized')) === '1',
      'Returned video result kept its last reference',
    )
    cases.push({ name: active, owned: beforeReturned, retired: returnedRetired, result: returned })

    active = 'queued-dynamic-member'
    await execute('calls=0;finalized=0;makeMovie();System.eventDisabled=true;')
    delivery = video.emit(video.onlyId(), 'ended')
    await execute('movie.onStatusChanged=replacement incontextof movie;delete global.movie;')
    const queued = owned()
    check(
      (await session.evaluate('calls+","+finalized')) === '0,0',
      'Queued video lost its receiver',
    )
    await execute('System.eventDisabled=false;')
    await delivery
    const delivered = await restored(),
      result = await session.evaluate('receiver+","+calls+","+finalized')
    check(result === 'movie-owner:stop,1,1', 'Video event did not resolve its member at delivery')
    cases.push({ name: active, owned: queued, retired: delivered, result })

    active = 'cancel-queued-event'
    await execute(
      'calls=0;finalized=0;makeMovie();movie.onStatusChanged=replacement;System.eventDisabled=true;',
    )
    delivery = video.emit(video.onlyId(), 'ended')
    const cancelling = owned()
    await execute('invalidate movie;delete global.movie;')
    await delivery
    const cancelled = await restored()
    check(
      (await session.evaluate('calls+","+finalized')) === '0,1',
      'Cancelled video event called script or retained its lease',
    )
    await execute('System.eventDisabled=false;')
    cases.push({ name: active, owned: cancelling, retired: cancelled, result: '0,1' })

    for (const event of ['frame', 'period'] as const) {
      active = event + '-last-reference'
      await execute(
        `calls=0;finalized=0;makeMovie(2);movie.${event === 'frame' ? 'onFrameUpdate' : 'onPeriod'}=lastEvent incontextof movie;`,
      )
      const receiving = owned()
      check(
        video.movies.get(video.onlyId())?.mode === 2,
        'Video frame mode must be selected before opening',
      )
      await video.emit(video.onlyId(), event)
      const completed = await restored()
      check(
        (await session.evaluate('calls+","+finalized')) === '1,1',
        'Immediate video event did not release its receiver',
      )
      cases.push({ name: active, owned: receiving, retired: completed, result: '1,1' })
    }

    active = 'retry-invalidation'
    await execute(
      'finalized=0;failVideo=true;makeMovie();try{invalidate movie;}catch(e){caught=e.message;}',
    )
    const retry = owned()
    check((await session.evaluate('caught')).includes('retry-video'), 'Lost video finalizer error')
    await execute('failVideo=false;invalidate movie;delete global.movie;')
    const retried = await restored()
    check((await session.evaluate('finalized')) === '2', 'Video invalidation did not retry')
    cases.push({ name: active, owned: retry, retired: retried, result: '2' })

    active = 'weak-layer-return'
    await execute(
      'var layer=new Layer(win,null);makeMovie();movie.layer1=layer;movie.layer2=layer;',
    )
    const layers = state()
    check(
      (await session.evaluate(
        '(function(){for(var i=0;i<100;i++)if(movie.layer1!==layer||movie.layer2!==layer)return 0;return 1;})()',
      )) === '1',
      'Weak layer result lost native identity',
    )
    check(state().handles === layers.handles, 'Layer getters accumulated host handles')
    await execute('invalidate layer;delete global.layer;')
    check(
      (await session.evaluate('movie.layer1===null && movie.layer2===null')) === '1',
      'Invalidated layer binding did not expire',
    )
    await execute('delete global.movie;')
    cases.push({ name: active, owned: layers, retired: await restored(), result: '1' })

    active = 'await-asynchronous-close'
    await execute('makeMovie();')
    closeGate = videoGate()
    video.nextClose = closeGate
    let settled = false
    const ending = execute('delete global.movie;').then(() => {
      settled = true
    })
    await Promise.race([
      closeGate.entered,
      ending.then(() => {
        throw new Error('Video close did not wait')
      }),
    ])
    const closing = state()
    check(
      !settled &&
        closing.pendingVideoCloses === 1 &&
        closing.videoSources === 0 &&
        closing.movies === 1,
      'Execution crossed an unfinished video close',
    )
    closeGate.release()
    await ending
    cases.push({ name: active, owned: closing, retired: await restored(), result: 'closed' })

    active = 'window-disconnect'
    await execute('calls=0;finalized=0;makeMovie();movie.onStatusChanged=replacement;')
    const windowOwned = owned()
    await execute('invalidate win;')
    const disconnected = state()
    check(
      disconnected.movies === 0 &&
        disconnected.videoSources === 1 &&
        disconnected.pendingVideoCloses === 0,
      'Window disconnect did not close media independently',
    )
    const windowResult = await session.evaluate(
      '(isvalid movie)+","+movie.status+","+calls+","+finalized',
    )
    check(
      windowResult === '1,unload,0,0',
      'Window disconnect invalidated its video or called an event',
    )
    await execute('try{movie.open("movie.mp4");}catch(e){caught=e.message;}')
    check(
      (await session.evaluate('caught')).includes('disconnected'),
      'Disconnected video reopened',
    )
    await execute('invalidate movie;delete global.movie;')
    check(state().videoSources === 0, 'Disconnected video did not retire')
    cases.push({ name: active, owned: windowOwned, retired: state(), result: windowResult })

    check(logs.length === 0, 'Video lifecycle logged an unexpected error: ' + logs.join('\n'))
    await session.stop()
    const stopped = state()
    check(
      Object.values(stopped).every((value) => value === 0),
      'Video stop retained ownership',
    )
    check(
      video.listeners.size === 0 &&
        video.terminalCloses === 1 &&
        audio.listeners.size === 0 &&
        audio.terminalCloses === 1 &&
        rendererCloses === 1,
      'Session did not close every backend once',
    )
    return {
      variant,
      binary,
      baseline,
      cases,
      stopped,
      closedIds: video.closedIds,
      terminalCloses: video.terminalCloses,
      rendererCloses,
    }
  } catch (error) {
    throw new Error(
      String(error) +
        '; video observations=' +
        JSON.stringify({ variant, binary, active, baseline, cases, current: state(), logs }),
    )
  } finally {
    closeGate?.release()
    await session.stop()
    await delivery
  }
}

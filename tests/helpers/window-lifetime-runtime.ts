import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { LifetimeVideoBackend, videoGate } from './video-lifetime-backend.ts'
import { windowLifetimeScript } from './window-lifetime-script.ts'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const definitions = windowLifetimeScript(`
class ReadWindow {var owner;function ReadWindow(w){owner=w;}function finalize(){trace=owner.caption+":"+owner.marker+":"+(isvalid owner);managedFinalized++;}}
class Replacer {function finalize(){global.replacement=new LifetimeWindow();replacement.caption="replacement";replacement.visible=true;trace=win.caption;}}
class MediaCheck {function finalize(){trace=movie.status+":"+win.caption+":"+(isvalid win);managedFinalized++;}}
var failManaged=true;
class ThrowingManaged {function finalize(){managedFinalized++;if(failManaged)throw new Exception("managed-finalizer");}}
class MutatingManaged {var owner,second,third;function MutatingManaged(w,s,t){owner=w;second=s;third=t;}function finalize(){owner.remove(second);owner.add(third);managedFinalized++;}}
function bound(){return this.marker;}
`)

/** Real Window/Session ownership, compiled scripts and native hooks in each browser. */
export async function exerciseWindowLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  binary: boolean,
) {
  const video = new LifetimeVideoBackend(),
    logs: string[] = [],
    timers = new Set<ReturnType<typeof setTimeout>>()
  let frames: FrameLayer[] = [],
    rendererCloses = 0,
    closeGate: ReturnType<typeof videoGate> | undefined
  const session = new EngineSession({
    video,
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { wasmBinary, variant, control, ...options }),
    renderer: {
      present(layers) {
        frames = layers
      },
      dispose() {
        rendererCloses++
      },
    },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected Window image')
      },
      text: () => {
        throw new Error('Unexpected Window text')
      },
    },
    inflateImage,
    deflateImage,
    decodeScript: readScript,
    readText,
    writeText,
    now: () => performance.now(),
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    schedule: (callback, delay) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        callback()
      }, delay)
      timers.add(timer)
      return () => {
        timers.delete(timer)
        clearTimeout(timer)
      }
    },
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  const state = () => ({
    ...session.inspectOwnership(),
    handles: session.snapshot().handles,
    layers: session.snapshot().layers,
    movies: video.movies.size,
    timers: timers.size,
  })
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  const cases: {
    name: string
    observed: ReturnType<typeof state>
    retired: ReturnType<typeof state>
    result: string
  }[] = []
  let baseline: ReturnType<typeof state> | undefined,
    active = 'initialize'
  const restored = async () => {
    await session.idle()
    const current = state()
    check(
      JSON.stringify(current) === JSON.stringify(baseline),
      'Window resources did not return to baseline: ' + JSON.stringify(current),
    )
    check(session.snapshot().state === 'running', 'Window lifecycle stopped its session')
    return current
  }
  const record = async (observed: ReturnType<typeof state>, result: string) =>
    cases.push({ name: active, observed, retired: await restored(), result })
  try {
    await session.initialize()
    session.mount(
      Object.entries({
        'startup.tjs': '',
        'window-owned.tjs': definitions,
        'movie.mp4': new Uint8Array([1, 2, 3]),
      }).map(([name, source]) => {
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source
        return { name, size: bytes.length, read: async () => bytes }
      }),
    )
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("window-owned.tjs","savedata/window-owned.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/window-owned.cjs")')
    } else await session.evaluate('Scripts.execStorage("window-owned.tjs")')
    // These ownership checks intentionally retire the main Window and continue
    // querying the same VM, beginning with the warmup Window.
    await execute(
      'System.exitOnWindowClose=false;var warm=new LifetimeWindow();warm.caption;invalidate warm;delete global.warm;finalized=0;',
    )
    baseline = state()

    active = 'implicit-window'
    await execute('makeWindow();')
    const owned = state()
    check(
      owned.windowSources === 1 && owned.weakOwners === baseline.weakOwners + 1,
      'Window owner is not independently observed',
    )
    check(
      (await session.evaluate('win.__windowMenu===null')) === '1',
      'Window eagerly created its menu cycle',
    )
    await execute('delete global.win;')
    await record(owned, 'released')
    check(
      (await session.evaluate('finalized')) === '1',
      'Implicit Window finalizer did not run once',
    )

    active = 'returned-window'
    await execute('finalized=0;')
    const before = state(),
      displayed = await session.evaluate('new LifetimeWindow()')
    check(displayed === '[TJS object]', 'Window result was not displayed')
    await record(before, displayed)
    check((await session.evaluate('finalized')) === '1', 'Returned Window remained rooted')

    active = 'native-members-before-clear'
    await execute(
      'finalized=0;managedFinalized=0;makeWindow();var item=new ReadWindow(win);win.add(item);win.add(item);',
    )
    const members = state()
    await execute('invalidate win;')
    const memberResult = await session.evaluate(
      'trace+","+finalized+","+managedFinalized+","+(isvalid item)',
    )
    check(
      memberResult === 'original:42:1,1,1,0',
      'Window native cleanup changed member visibility or registration identity',
    )
    await execute('delete global.item;delete global.win;')
    await record(members, memberResult)

    active = 'managed-error-continues'
    await execute(
      'managedFinalized=0;makeWindow();var first=new ThrowingManaged(),second=new ManagedWindowObject();win.add(first);win.add(second);',
    )
    const throwing = state()
    await execute('invalidate win;')
    const failedManaged = await session.evaluate(
      '(isvalid first)+","+(isvalid second)+","+managedFinalized',
    )
    check(failedManaged === '1,0,2', 'Managed failure prevented later Window registrations')
    const managedLogs = logs.splice(0)
    check(
      managedLogs.length === 1 && managedLogs[0]!.includes('managed-finalizer'),
      'Window did not record the managed finalizer error',
    )
    const managedDiagnostic = managedLogs.join('\n')
    await execute(
      'failManaged=false;invalidate first;delete global.first;delete global.second;delete global.win;',
    )
    await record(throwing, failedManaged + '; ' + managedDiagnostic)

    active = 'managed-registration-lock'
    await execute(
      'managedFinalized=0;makeWindow();var second=new ManagedWindowObject(),third=new ManagedWindowObject(),first=new MutatingManaged(win,second,third);win.add(first);win.add(second);',
    )
    const locked = state()
    await execute('invalidate win;')
    const lockedResult = await session.evaluate(
      '(isvalid second)+","+(isvalid third)+","+managedFinalized',
    )
    check(lockedResult === '0,1,2', 'Window registrations changed during native invalidation')
    await execute(
      'invalidate third;delete global.first;delete global.second;delete global.third;delete global.win;',
    )
    await record(locked, lockedResult)

    active = 'finalizer-retry'
    await execute(
      'finalized=0;managedFinalized=0;makeWindow();var item=new ManagedWindowObject();win.add(item);failWindow=true;try{invalidate win;}catch(e){caught=e.message;}',
    )
    const retry = state()
    check(
      retry.windowSources === 1 && retry.closingWindows === 0,
      'Failed script finalizer retired native Window state',
    )
    check(
      (await session.evaluate('caught')).includes('window-finalizer'),
      'Lost Window finalizer error',
    )
    check(
      (await session.evaluate('(isvalid item)+","+managedFinalized')) === '1,0',
      'Failed Window invalidated its registered object',
    )
    await execute('failWindow=false;invalidate win;delete global.win;delete global.item;')
    await record(retry, 'retried')
    check(
      (await session.evaluate('finalized+","+managedFinalized')) === '2,1',
      'Window native invalidation did not retry',
    )

    active = 'closure-registration'
    await execute(
      'makeWindow();var a=%[marker:1],b=%[marker:2],first=bound incontextof a,second=bound incontextof b;win.add(first);win.add(second);win.add(first);',
    )
    const closures = state()
    check(
      (await session.evaluate('win.__windowObjects.count')) === '2',
      'Bound contexts were deduplicated together',
    )
    await execute('win.remove(first);')
    check(
      (await session.evaluate('win.__windowObjects[0]()')) === '2',
      'Window.remove selected the wrong closure',
    )
    await execute(
      'win.remove(second);delete global.first;delete global.second;delete global.a;delete global.b;delete global.win;',
    )
    await record(closures, 'distinct-contexts')

    active = 'lazy-menu-action-owner'
    await execute('finalized=0;makeWindow();var menu=win.menu;delete global.win;')
    const menu = state()
    check(
      (await session.evaluate('finalized')) === '0' && menu.windowSources === 1,
      'Live Menu lost its native Window action owner',
    )
    await execute('invalidate menu;delete global.menu;')
    await record(menu, 'released')
    check(
      (await session.evaluate('finalized')) === '1',
      'Menu left an extra permanent Window host callback',
    )

    active = 'weak-queued-input'
    await execute(
      'calls=0;finalized=0;System.eventDisabled=true;makeWindow();win.setInnerSize(100,80);win.postInputEvent("onKeyDown",%[key:65]);',
    )
    const queued = state()
    await execute('delete global.win;')
    await record(queued, 'cancelled')
    await execute('System.eventDisabled=false;')
    check(
      (await session.evaluate('finalized+","+calls')) === '1,0',
      'Queued native input kept or called a dead Window',
    )

    active = 'resize-last-reference'
    await execute(
      'calls=0;finalized=0;makeWindow();win.onResize=dropWindow incontextof win;win.setInnerSize(100,80);',
    )
    await record(state(), 'released')
    check(
      (await session.evaluate('finalized+","+calls')) === '1,1',
      'Resize callback did not release its Window receiver',
    )

    active = 'replacement-during-retirement'
    await execute('makeWindow();win.add(new Replacer());')
    const replacing = state()
    await execute('invalidate win;delete global.win;')
    const replacement = await session.evaluate(
      'trace+","+replacement.caption+","+replacement.visible',
    )
    check(
      replacement === 'original,replacement,1' && session.snapshot().title === 'replacement',
      'Old Window cleanup changed the replacement',
    )
    await execute('invalidate replacement;delete global.replacement;')
    await record(replacing, replacement)

    active = 'independent-primary-layer'
    await execute(
      'makeWindow();win.visible=true;var oldLayer=new Layer(win,null);oldLayer.fillRect(0,0,32,32,0xffff0000);',
    )
    const primary = state()
    check(
      (await session.evaluate('win.primaryLayer===oldLayer')) === '1',
      'Window lost its primary Layer identity',
    )
    await execute(
      'invalidate win;delete global.win;makeWindow();win.visible=true;var newLayer=new Layer(win,null);newLayer.fillRect(0,0,32,32,0xff0000ff);',
    )
    check(
      (await session.evaluate('isvalid oldLayer')) === '1',
      'Window invalidated an externally owned Layer',
    )
    const layerId = Number(await session.evaluate('newLayer.__id'))
    check(
      frames.length === 1 && frames[0]?.id === layerId,
      'Old Window layers reached the replacement frame',
    )
    await execute(
      'oldLayer.onHitTest=function(){throw new Exception("Retired Window received hit test");};newLayer.hitType=htProvince;',
    )
    await session.input({ type: 'down', x: 1, y: 1, button: 0, shift: 0, clicks: 1 })
    await execute(
      'invalidate oldLayer;delete global.oldLayer;invalidate newLayer;delete global.newLayer;delete global.win;',
    )
    await record(primary, 'separate-layer')

    active = 'video-before-managed'
    await execute(
      'managedFinalized=0;makeWindow();var movie=new VideoOverlay(win);movie.open("movie.mp4");movie.play();win.add(new MediaCheck());',
    )
    closeGate = videoGate()
    video.nextClose = closeGate
    let settled = false
    const ending = execute('invalidate win;').then(() => {
      settled = true
    })
    await Promise.race([
      closeGate.entered,
      ending.then(() => {
        throw new Error('Window did not wait for video close')
      }),
    ])
    const closing = state()
    check(
      !settled && closing.closingWindows === 1 && closing.movies === 1,
      'Window crossed unfinished video cleanup',
    )
    closeGate.release()
    await ending
    check(
      (await session.evaluate('trace+","+managedFinalized')) === 'unload:original:1,1',
      'Window managed cleanup preceded media close or lost its members',
    )
    await execute('delete global.movie;delete global.win;')
    await record(closing, 'media-first')

    check(logs.length === 0, 'Window lifecycle logged an unexpected diagnostic: ' + logs.join('\n'))
    await session.stop()
    const stopped = state()
    check(
      Object.values(stopped).every((value) => value === 0) && rendererCloses === 1,
      'Window stop retained native or host resources',
    )
    return { variant, binary, baseline, cases, stopped, rendererCloses }
  } catch (error) {
    throw new Error(
      String(error) +
        '; window observations=' +
        JSON.stringify({ variant, binary, active, baseline, cases, current: state(), logs }),
    )
  } finally {
    closeGate?.release()
    await session.stop()
  }
}

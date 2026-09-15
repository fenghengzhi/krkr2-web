import { EngineSession } from '../../src/engine/session.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { readScript, readText, writeText } from '../../src/backends/files/text-codecs.ts'
import { inflateImage, deflateImage } from '../../src/backends/files/blob-source.ts'

const source = String.raw`
function demand(value,message){if(!value)throw new Exception(message);}
function menuActionChecks(){
  var owner=%[marker:41,action:function(event){demand(event.type=="onClick","event name");demand(event.target===global.actionMenu,"event target");return %[answer:this.marker+1];}];
  global.actionMenu=new MenuItem(owner,"action");
  var returned=actionMenu.onClick();
  demand(returned.answer===42,"native action result");
  invalidate actionMenu;delete global.actionMenu;

  var absent=new MenuItem(%[],"missing"),empty=new MenuItem(null,"null");
  demand(absent.onClick()===void && empty.onClick()===void,"absent action must return void");
  invalidate absent;invalidate empty;

  var context=%[marker:73],boundOwner=%[marker:12,action:function(event){return this.marker;}];
  var bound=new MenuItem(boundOwner incontextof context,"bound");
  demand(bound.onClick()===73,"action owner bound context");
  invalidate bound;

  var failing=new MenuItem(%[action:function(event){throw new Exception("menu-action-thrown");}],"failure"),caught="";
  try{failing.onClick();}catch(error){caught=error.message;}
  demand(caught.indexOf("menu-action-thrown")>=0,"thrown action exception was swallowed");
  invalidate failing;
  return "result,event,missing,null,bound,exception";
}
`

/** Native action statuses and exceptions are distinct in the actual MenuItem bridge. */
export async function exerciseMenuActions(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  binary: boolean,
) {
  const logs: string[] = []
  let rendererCloses = 0
  const session = new EngineSession({
    createRuntime: (handler, control, options) =>
      TjsWasmRuntime.create(factory, handler, { wasmBinary, variant, control, ...options }),
    renderer: {
      present() {},
      dispose() {
        rendererCloses++
      },
    },
    graphics: {
      decode: async () => {
        throw new Error('Unexpected menu image')
      },
      text: () => {
        throw new Error('Unexpected menu text')
      },
    },
    inflateImage,
    deflateImage,
    decodeScript: readScript,
    readText,
    writeText,
    now: () => performance.now(),
    yieldToHost: () => new Promise((resolve) => setTimeout(resolve, 0)),
    event: (event) => {
      if (event.type === 'log') logs.push(event.text)
    },
  })
  try {
    await session.initialize()
    session.mount(
      Object.entries({ 'startup.tjs': '', 'menu-actions.tjs': source }).map(([name, source]) => {
        const bytes = new TextEncoder().encode(source)
        return { name, size: bytes.length, read: async () => bytes }
      }),
    )
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("menu-actions.tjs","savedata/menu-actions.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/menu-actions.cjs")')
    } else await session.evaluate('Scripts.execStorage("menu-actions.tjs")')
    const result = await session.evaluate('menuActionChecks()')
    if (result !== 'result,event,missing,null,bound,exception') throw new Error(result)
    if (logs.length) throw new Error('Unexpected menu diagnostics: ' + logs.join('\n'))
    await session.stop()
    const stopped = { ...session.inspectOwnership(), handles: session.snapshot().handles }
    if (Object.values(stopped).some((value) => value !== 0) || rendererCloses !== 1)
      throw new Error('Menu action teardown retained resources: ' + JSON.stringify(stopped))
    return { variant, binary, result, stopped, rendererCloses }
  } finally {
    await session.stop()
  }
}

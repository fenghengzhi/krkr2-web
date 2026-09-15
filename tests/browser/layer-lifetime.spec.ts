import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const layerDefinitions = String.raw`
var layerDeaths=0,failLayer=false,layerError="";
class BrowserLifetimeLayer extends Layer {
  function BrowserLifetimeLayer(window,parent=null){super.Layer(window,parent);}
  function finalize(){layerDeaths++;if(failLayer)throw new global.Exception("browser-layer-finalizer");}
}
var win=new Window();win.visible=true;win.setInnerSize(160,80);
var root=new Layer(win,null);root.setSize(160,80);
`

async function launch(page: Page, backend: string, binary: boolean, source: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  const startup = binary
    ? 'Scripts.compileStorage("browser-layer.tjs","savedata/browser-layer.cjs",false,true,false);Scripts.execStorage("savedata/browser-layer.cjs");'
    : 'Scripts.execStorage("browser-layer.tjs");'
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(startup) },
    {
      name: 'browser-layer.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + '\nDebug.message("browser-layer-ready");'),
    },
  ])
  await expect(page.getByText('browser-layer-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return async () => {
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('.game-text-input')).toHaveCount(0)
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: Layer weak edges, mutable children cache and dependent Font have distinct lifetimes`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        layerDefinitions +
          String.raw`
var parent=new BrowserLifetimeLayer(win,root),child=new BrowserLifetimeLayer(win,parent);
var cache,font,survivor,stable=false;
function dropChild(){delete global.child;return 0;}
function cacheChild(){
  var empty=parent.children;empty.add("user entry");
  stable=(parent.children===empty && empty[0]=="user entry");empty.clear();
  child=new BrowserLifetimeLayer(win,parent);cache=parent.children;
  font=parent.font;font.height=29;delete global.child;return 0;
}
function clearCache(){cache.clear();return 0;}
function dropParent(){survivor=new BrowserLifetimeLayer(win,parent);delete global.parent;return 0;}
`,
      )
      try {
        await evaluate(page, 'dropChild()', '0')
        await evaluate(page, 'layerDeaths+","+parent.children.count', '1,0')
        await evaluate(page, 'cacheChild()', '0')
        await evaluate(
          page,
          'layerDeaths+","+stable+","+cache.count+","+(font===parent.font)+","+font.height',
          '1,1,1,1,29',
        )
        await evaluate(page, 'clearCache()', '0')
        await evaluate(page, 'layerDeaths+","+parent.children.count', '2,0')
        await evaluate(page, 'dropParent()', '0')
        await evaluate(
          page,
          'layerDeaths+","+(isvalid survivor)+","+(survivor.parent===null)+","+(survivor.window===win)+","+(isvalid font)',
          '3,1,1,1,0',
        )
      } finally {
        await stop()
      }
    })

    test(`${mode}: a throwing Layer finalizer preserves native state and can retry in the browser`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        layerDefinitions +
          String.raw`
var parent=new BrowserLifetimeLayer(win,root),child=new Layer(win,parent),font=parent.font;
function rejectInvalidation(){
  failLayer=true;try{invalidate parent;}catch(error){layerError=error.message;}return 0;
}
function retryInvalidation(){failLayer=false;invalidate parent;invalidate parent;return 0;}
`,
      )
      try {
        await evaluate(page, 'rejectInvalidation()', '0')
        await evaluate(page, 'layerError', 'browser-layer-finalizer')
        await evaluate(
          page,
          '(isvalid parent)+","+(isvalid font)+","+(child.parent===parent)+","+layerDeaths',
          '1,1,1,1',
        )
        await evaluate(page, 'retryInvalidation()', '0')
        await evaluate(
          page,
          '(isvalid parent)+","+(isvalid font)+","+(isvalid child)+","+(child.parent===null)+","+layerDeaths',
          '0,0,1,1,2',
        )
      } finally {
        await stop()
      }
    })

    test(`${mode}: a real canvas click establishes a focus lease that survives external reference removal`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        layerDefinitions +
          String.raw`
var inputDeaths=[],inputTrace=[];
class BrowserInputLayer extends Layer {
  function BrowserInputLayer(label,x){
    super.Layer(win,root);name=label;left=x;setSize(30,30);visible=true;focusable=true;
    fillRect(0,0,30,30,0xffffffff);
  }
  function onMouseDown(){focus();}
  function onBlur(next){inputTrace.add("blur:"+name+":"+inputDeaths.count);}
  function onFocus(previous,direction){inputTrace.add("focus:"+name+":"+inputDeaths.count);}
  function finalize(){inputDeaths.add(name);inputTrace.add("final:"+name);}
}
var a=new BrowserInputLayer("a",0),b=new BrowserInputLayer("b",50);
function dropFocused(){inputTrace.clear();delete global.a;return 0;}
function moveFocus(){b.focus();return 0;}
`,
      )
      try {
        const canvas = page.locator('canvas')
        await expect(canvas).toHaveJSProperty('width', 160)
        const bounds = (await canvas.boundingBox())!
        await canvas.click({
          position: { x: (bounds.width * 10) / 160, y: (bounds.height * 10) / 80 },
        })
        await evaluate(page, 'win.focusedLayer===a', '1')
        await evaluate(page, 'dropFocused()', '0')
        await evaluate(page, 'inputDeaths.count+","+win.focusedLayer.name', '0,a')
        await evaluate(page, 'moveFocus()', '0')
        await evaluate(page, 'inputTrace.join("|")', 'blur:a:0|focus:b:0|final:a')
        await evaluate(page, 'win.focusedLayer===b', '1')
      } finally {
        await stop()
      }
    })

    test(`${mode}: transitions retain both Layers and their clock, then exchange before source invalidation`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        layerDefinitions +
          String.raw`
var trace="",tick=0;
class BrowserTransitionLayer extends Layer {
  function BrowserTransitionLayer(label){super.Layer(win,root);name=label;setSize(2,1);}
  function finalize(){trace+=name+";";}
  function onTransitionCompleted(dest,src){trace+="complete:"+dest.name+","+src.name+";";}
}
class BrowserTransitionClock {
  function read(){return tick;}
  function finalize(){trace+="clock;";}
}
var fore=new BrowserTransitionLayer("fore"),back=new BrowserTransitionLayer("back"),clock=new BrowserTransitionClock();
fore.visible=true;
function beginOwned(){
  fore.beginTransition("crossfade",true,back,%[time:100,selfupdate:true,callback:clock.read]);
  delete global.clock;delete global.fore;delete global.back;return 0;
}
function completeOwned(){tick=100;root.update();return 0;}
var oldChild,newChild;
function beginShutdown(){
  trace="";fore=new BrowserTransitionLayer("fore");back=new BrowserTransitionLayer("back");
  fore.visible=true;oldChild=new Layer(win,fore);newChild=new Layer(win,back);
  fore.beginTransition("crossfade",false,back,%[time:100,selfupdate:true]);return 0;
}
function invalidateSource(){invalidate back;return 0;}
`,
      )
      try {
        await evaluate(page, 'beginOwned()', '0')
        await evaluate(page, '"retained:"+trace', 'retained:')
        await evaluate(page, 'completeOwned()', '0')
        await evaluate(page, 'trace', 'complete:fore,back;back;fore;clock;')
        await evaluate(page, 'beginShutdown()', '0')
        await evaluate(page, 'invalidateSource()', '0')
        await evaluate(
          page,
          'trace+","+(oldChild.parent===null)+","+(newChild.parent===fore)+","+(fore.parent===root)',
          'back;,1,1,1',
        )
      } finally {
        await stop()
      }
    })
  }
}

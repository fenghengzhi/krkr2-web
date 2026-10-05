import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

// Fixed KRKR2 WindowImpl setters, not every geometry-affecting Window API.
const properties = [
  ['visible', 'false'], ['width', '130'], ['height', '90'], ['left', '30'], ['top', '40'],
  ['minWidth', '10'], ['minHeight', '10'], ['maxWidth', '300'], ['maxHeight', '200'],
  ['innerSunken', 'true'], ['innerWidth', '140'], ['innerHeight', '100'], ['borderStyle', 'bsNone'],
] as const
const methods = [
  ['setSize', '150,110'], ['setInnerSize', '160,120'], ['setPos', '50,60'],
  ['setMinSize', '10,20'], ['setMaxSize', '320,240'],
] as const
const restricted = [
  ...properties.flatMap(([name, value]) => [
    [name, `win.${name}=${value};`], [`${name}-same`, `win.${name}=win.${name};`],
  ]),
  ...methods.map(([name, args]) => [name, `win.${name}(${args});`]),
  ['root-menu', 'win.menu.visible=false;'], ['root-menu-same', 'win.menu.visible=win.menu.visible;'],
]
const source = String.raw`
System.exitOnWindowClose=false;
var resizes=0,secondaryDeaths=0,secondaryManagedDeaths=0,other=null;
var win=new Window();win.setInnerSize(120,80);win.setPos(10,20);win.visible=true;
win.onResize=function(){global.resizes++;};
var rootMenu=win.menu,child=new MenuItem(win,"Child"),unattached=new MenuItem(win,"Unattached");
rootMenu.add(child);rootMenu.visible=true;
// Dictionary callbacks bind this to the dictionary; use the actual global
// Window rather than its missing "win" member (which evaluates to void).
var restricted=[${restricted.map(([name, code]) => `%[name:${JSON.stringify(name)},run:function(){${code.replace(/\bwin\./g, 'global.win.')}}]`).join(',')}];
function geometry(){return [win.visible,win.width,win.height,win.left,win.top,win.minWidth,win.minHeight,
  win.maxWidth,win.maxHeight,win.innerSunken,win.innerWidth,win.innerHeight,win.borderStyle,rootMenu.visible,win.fullScreen].join(",");}
function restrictions(){
  var report=[];
  for(var i=0;i<restricted.count;i++){
    var before=geometry(),error="";
    try{restricted[i].run();}catch(e){error=e.message;}
    report.add(restricted[i].name+":"+int(before===geometry())+":"+error);
  }
  return report.join("\n");
}
function allowed(){
  win.caption="fullscreen title";win.stayOnTop=true;win.showScrollBars=false;
  win.focusable=false;win.focusable=true;win.useMouseKey=true;win.trapKey=true;
  win.layerLeft=-3;win.layerTop=4;win.setLayerPos(5,6);
  win.zoomNumer=3;win.zoomDenom=2;win.setZoom(5,4);
  win.mouseCursorState=2;win.imeMode=1;win.fullScreen=true;
  child.visible=false;unattached.visible=false;
  return [win.caption,win.stayOnTop,win.showScrollBars,win.focusable,win.useMouseKey,win.trapKey,
    win.layerLeft,win.layerTop,win.zoomNumer,win.zoomDenom,win.mouseCursorState,win.imeMode,
    child.visible,unattached.visible,win.fullScreen].join(",");
}
class Secondary extends Window {
  var allow=true,queries=0;
  function Secondary(){super.Window();caption="Secondary";setInnerSize(80,60);visible=true;}
  function onCloseQuery(canClose){queries++;super.onCloseQuery(allow);}
  function finalize(){global.secondaryDeaths++;}
}
class Managed {function finalize(){global.secondaryManagedDeaths++;}}
function makeSecondary(){global.other=new Secondary();other.add(new Managed());return other.__windowId;}
function missingPairArguments(){
  var report=[];
  ${methods.map(([name]) => `try{win.${name}(1);report.add("missing");}catch(e){report.add(e.message);}`).join('\n')}
  return report.join("\n");
}
`

async function fixture(binary: boolean) {
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("fullscreen.tjs","savedata/fullscreen.cjs",false,true,false);Scripts.execStorage("savedata/fullscreen.cjs");'
    : 'Scripts.execStorage("fullscreen.tjs");', 'fullscreen.tjs': source })
  try {
    await f.session.start()
    await f.session.idle()
    const id = Number(await f.session.evaluate('win.__windowId'))
    if (binary) {
      const bytes = f.session.exportSaves().find((file) => file.path === 'savedata/fullscreen.cjs')?.bytes
      assert(bytes)
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    return { ...f, id,
      exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(`${program};`)})`),
      view: (windowId = id) => f.session.snapshot().windows!.find((window) => window.id === windowId)!.view,
    }
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: every native fullscreen-restricted Window setter throws before mutation, including unchanged assignments and root menu visibility`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('win.fullScreen=true;resizes=0')
      const before = f.view(), result = (await f.session.evaluate('restrictions()')).split('\n')
      assert.equal(result.length, restricted.length)
      for (let i = 0; i < result.length; i++) {
        assert(result[i]!.startsWith(`${restricted[i]![0]}:1:`), result[i])
        assert.match(result[i]!, /fullscreen/)
      }
      assert.deepEqual(f.view(), before)
      assert.equal(await f.session.evaluate('resizes'), '0')
      assert.equal(f.session.snapshot().state, 'running', 'Errors are caught inside the real TJS caller')
    } finally { await f.session.stop() }
  })

  test(`${mode}: unrestricted fullscreen properties and non-root menu visibility remain callable`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.fullScreen=true')
      assert.equal(await f.session.evaluate('allowed()'), 'fullscreen title,1,0,1,1,1,5,6,5,4,2,1,0,0,1')
      assert.equal(await f.session.evaluate('rootMenu.visible'), '1')
      assert.deepEqual([f.view().width, f.view().height, f.view().left, f.view().top], [120, 80, 0, 0])
    } finally { await f.session.stop() }
  })

  test(`${mode}: host geometry and exit paths bypass the public guard, then public writes work again`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.fullScreen=true')
      f.session.moveWindow(f.id, 33, 44)
      await f.session.resizeWindow(f.id, 180, 130)
      assert.deepEqual([f.view().left, f.view().top, f.view().width, f.view().height, f.view().fullScreen],
        [33, 44, 180, 130, true])
      await f.session.exitFullScreen(f.id)
      await f.exec('win.setSize(140,90);win.setInnerSize(150,100);win.setPos(25,35);win.setMinSize(20,10);win.setMaxSize(300,200);win.innerSunken=true;win.borderStyle=bsNone;rootMenu.visible=false')
      assert.equal(await f.session.evaluate('geometry()'), '1,150,100,25,35,20,10,300,200,1,146,96,0,0,0')
      await f.exec('win.fullScreen=true;win.fullScreen=false;win.visible=false;win.visible=true')
      assert.equal(await f.session.evaluate('win.visible'), '1')
    } finally { await f.session.stop() }
  })

  test(`${mode}: fullscreen secondary user close can deny then hide without invalidation, and later script close still retires it`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const id = Number(await f.session.evaluate('makeSecondary()'))
      await f.exec('other.fullScreen=true;other.allow=false')
      await f.session.closeWindow(id)
      assert.equal(await f.session.evaluate('[other.visible,other.fullScreen,other.queries,isvalid other].join(",")'), '1,1,1,1')
      await f.session.evaluate('other.allow=true')
      await f.session.closeWindow(id)
      await f.session.idle()
      assert.equal(await f.session.evaluate('[other.visible,other.fullScreen,other.queries,isvalid other,secondaryDeaths,secondaryManagedDeaths].join(",")'), '0,1,2,1,0,0')
      assert.equal(f.session.snapshot().activeWindow, f.id)
      await f.session.exitFullScreen(id)
      await f.exec('other.visible=true;other.fullScreen=true;other.close()')
      assert.equal(await f.session.evaluate('[isvalid other,secondaryDeaths,secondaryManagedDeaths].join(",")'), '0,1,1')
      assert.equal(f.session.snapshot().windows!.some((window) => window.id === id), false)
      assert.equal(f.session.snapshot().state, 'running')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: fullscreen main user close follows the native invalidation and default Session exit policy`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('System.exitOnWindowClose=true;win.fullScreen=true')
      await f.session.closeWindow(f.id)
      assert(['stopping', 'stopped'].includes(f.session.snapshot().state))
      await f.session.stop()
      assert.equal(f.session.snapshot().state, 'stopped')
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } finally { await f.session.stop() }
  })

  test(`${mode}: protected pair methods check their native argument count before the fullscreen setter`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.fullScreen=true')
      const before = f.view(), errors = (await f.session.evaluate('missingPairArguments()')).split('\n')
      assert.equal(errors.length, methods.length)
      for (let i = 0; i < errors.length; i++) {
        assert(errors[i]!.includes(`Window.${methods[i]![0]} requires`), errors[i])
        assert.doesNotMatch(errors[i]!, /fullscreen/)
      }
      assert.deepEqual(f.view(), before)
    } finally { await f.session.stop() }
  })
}

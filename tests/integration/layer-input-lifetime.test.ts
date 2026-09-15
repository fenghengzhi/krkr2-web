import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const source = String.raw`
var window=new Window();window.setInnerSize(160,80);window.visible=true;
var root=new Layer(window,null);root.setSize(160,80);
var inputDeaths=[],inputTrace=[];
class InputOwnedLayer extends Layer {
  function InputOwnedLayer(parent,name,x){
    super.Layer(global.window,parent);this.name=name;left=x;
    setSize(30,30);visible=true;focusable=true;
    fillRect(0,0,30,30,0xffffffff);
  }
  function finalize(){inputDeaths.add(name);inputTrace.add("final:"+name);}
  function onBlur(next){inputTrace.add("blur:"+name+":"+inputDeaths.count);}
  function onFocus(previous,direction){inputTrace.add("focus:"+name+":"+inputDeaths.count);}
}
class InputThrowingLayer extends InputOwnedLayer {
  function InputThrowingLayer(parent,name,x){super.InputOwnedLayer(parent,name,x);}
  function onBlur(next){inputTrace.add("blur:"+name);throw new global.Exception("input-focus-failure");}
}
class InputHitLayer extends InputOwnedLayer {
  function InputHitLayer(parent,name,x){super.InputOwnedLayer(parent,name,x);}
  function onHitTest(x,y,hit){delete global.hitLayer;super.onHitTest(x,y,hit);}
  function onMouseEnter(){inputTrace.add("unexpected-enter");}
}
class InputFocusReceiver extends InputOwnedLayer {
  function InputFocusReceiver(parent,name,x){super.InputOwnedLayer(parent,name,x);}
  function onFocus(previous,direction){inputTrace.add("previous:"+(previous===global.a));}
}
class InputReplacingLayer extends InputOwnedLayer {
  function InputReplacingLayer(parent,name,x){super.InputOwnedLayer(parent,name,x);}
  function onBlur(next){
    inputTrace.add("replace");
    var stage="invalidate old Window";
    try{
      invalidate global.window;
      stage="construct Window";
      global.window=new global.Window();
      stage="configure Window";
      global.window.setInnerSize(160,80);global.window.visible=true;
      stage="construct primary Layer";
      global.root=new global.Layer(global.window,null);
      stage="configure primary Layer";
      global.root.setSize(160,80);
      stage="construct replacement Layer";
      var replacement=new global.InputOwnedLayer(global.root,"replacement",0);
      stage="focus replacement Layer";
      replacement.focus();
    }catch(error){throw new global.Exception("Window replacement ["+stage+"]: "+error.message);}
  }
}
class InputCacheLayer extends InputOwnedLayer {
  function InputCacheLayer(parent,name,x){super.InputOwnedLayer(parent,name,x);}
  function onNodeDisabled(){inputTrace.add("disabled:"+name);children.add(null);}
}
`

async function fixture(binary: boolean) {
  const harness = await headless({ 'startup.tjs': '', 'input-lifetime.tjs': source })
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("input-lifetime.tjs","savedata/input-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/input-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("input-lifetime.tjs")')
    return {
      ...harness,
      execute: (code: string) => session.evaluate(`Scripts.exec(${JSON.stringify(code)})`),
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: focus owns its layer through blur/focus and then releases it`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'var a=new InputOwnedLayer(root,"a",0),b=new InputOwnedLayer(root,"b",50);a.focus();inputTrace.clear();delete global.a;',
      )
      assert.equal(await f.session.evaluate('inputDeaths.count'), '0')
      await f.execute('b.focus();')
      assert.equal(await f.session.evaluate('inputTrace.join("|")'), 'blur:a:0|focus:b:0|final:a')
      assert.equal(await f.session.evaluate('window.focusedLayer===b'), '1')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: focus ownership finally steps run when a callback throws`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'var a=new InputThrowingLayer(root,"a",0),b=new InputOwnedLayer(root,"b",50);a.focus();inputTrace.clear();delete global.a;var focusError="";try{b.focus();}catch(error){focusError=error.message;}delete global.b;',
      )
      assert.equal(await f.session.evaluate('focusError'), 'input-focus-failure')
      assert.equal(await f.session.evaluate('inputTrace.join("|")'), 'blur:a|final:a')
      assert.equal(await f.session.evaluate('window.focusedLayer.name'), 'b')
      await f.execute('window.focusedLayer.parent=null;')
      assert.equal(await f.session.evaluate('inputDeaths.join(",")'), 'a,b')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: invalidation suppresses old callbacks while preserving the previous-focus argument`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'var a=new InputOwnedLayer(root,"a",0),b=new InputFocusReceiver(root,"b",50);a.focus();inputTrace.clear();invalidate a;',
      )
      assert.equal(await f.session.evaluate('inputTrace.join("|")'), 'final:a|previous:1')
      assert.equal(await f.session.evaluate('window.focusedLayer===b'), '1')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: replacing a Window inside blur does not resume old-manager focus work`, async () => {
    const f = await fixture(binary)
    try {
      // Keep this VM running after the blur callback invalidates its main Window.
      await f.execute(
        'System.exitOnWindowClose=false;var a=new InputReplacingLayer(root,"a",0),b=new InputOwnedLayer(root,"b",50);a.focus();inputTrace.clear();b.focus();',
      )
      assert.equal(await f.session.evaluate('inputTrace.join("|")'), 'replace|focus:replacement:0')
      assert.equal(await f.session.evaluate('window.focusedLayer.name'), 'replacement')
      await f.execute('window.focusedLayer.parent=null;')
      assert.equal(await f.session.evaluate('inputDeaths.join(",")'), 'replacement')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: capture and hover independently retain a layer until their release`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('var a=new InputOwnedLayer(root,"a",0);')
      await f.session.input({ type: 'down', x: 5, y: 5, button: 0, shift: 8, clicks: 0 })
      await f.execute('delete global.a;')
      assert.equal(await f.session.evaluate('inputDeaths.count'), '0')
      await f.execute('root.releaseCapture();')
      assert.equal(await f.session.evaluate('inputDeaths.count'), '0')
      await f.session.input({ type: 'move', x: 150, y: 70, button: 0, shift: 0, clicks: 0 })
      assert.equal(await f.session.evaluate('inputDeaths.join(",")'), 'a')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a hit-test temporary does not retain its target into the next callback`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('var hitLayer=new InputHitLayer(root,"hit",0);')
      await f.session.input({ type: 'move', x: 5, y: 5, button: 0, shift: 0, clicks: 0 })
      assert.equal(await f.session.evaluate('inputDeaths.join(",")'), 'hit')
      assert.equal(await f.session.evaluate('inputTrace.find("unexpected-enter")<0'), '1')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a modal layer has its own lease even without a focused descendant`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'var modal=new InputOwnedLayer(root,"modal",80);modal.focusable=false;modal.setMode();delete global.modal;',
      )
      assert.equal(await f.session.evaluate('window.focusedLayer===null'), '1')
      assert.equal(await f.session.evaluate('inputDeaths.count'), '0')
      assert.equal(await f.session.evaluate('window.currentModalLayer.name'), 'modal')
      await f.execute('window.currentModalLayer.removeMode();')
      assert.equal(await f.session.evaluate('inputDeaths.join(",")'), 'modal')
      assert.equal(await f.session.evaluate('window.currentModalLayer===null'), '1')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: enabled traversal refreshes leaf caches without dirtying them for position changes`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'System.eventDisabled=true;var leaf=new InputOwnedLayer(root,"leaf",0);var cache=leaf.children;cache.add(null);leaf.left=10;var positionCacheCount=leaf.children.count;leaf.enabled=false;var disabledCacheCount=leaf.children.count;cache.add(null);root.enabled=false;var ancestorCacheCount=leaf.children.count;cache.add(null);leaf.enabled=true;var hiddenNodeCacheCount=leaf.children.count;',
      )
      assert.equal(
        await f.session.evaluate(
          '[positionCacheCount,disabledCacheCount,ancestorCacheCount,hiddenNodeCacheCount,leaf.children===cache].join(",")',
        ),
        '1,0,0,0,1',
      )
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: enabled callbacks run before postorder children-cache invalidation`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute(
        'var parent=new InputCacheLayer(root,"parent",0),leaf=new InputCacheLayer(parent,"leaf",0);parent.enabled=false;var enabledCacheResult=parent.children.count+","+leaf.children.count;',
      )
      assert.equal(
        await f.session.evaluate('inputTrace.join("|")'),
        'disabled:parent|disabled:leaf',
      )
      assert.equal(await f.session.evaluate('enabledCacheResult'), '1,0')
    } finally {
      await f.session.stop()
    }
  })
}

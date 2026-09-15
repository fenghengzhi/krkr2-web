import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

// The fixture and its operation functions run as source or real compiled TJS.
// Assertions observe the public Window input publication, not the controller's
// private cached attention point. These are DOM caret coordinates, not OS IME
// placement or native DrawDevice integer-rounding observations.
async function fixture(binary: boolean, body: string) {
  const harness = await headless({
    'startup.tjs': '',
    'layer-attention.tjs': String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(160,120);win.visible=true;
var root=new Layer(win,null);root.setSize(160,120);
var parent=new Layer(win,root);parent.setSize(100,90);parent.setPos(20,10);parent.visible=true;
var child=new Layer(win,parent);child.setSize(40,30);child.setPos(3,4);child.visible=true;child.focusable=true;
var other=new Layer(win,root);other.setSize(40,30);other.setPos(90,40);other.visible=true;other.focusable=true;
function focusChild(){child.focus();}
function focusOther(){other.focus();}
function clearFocus(){win.focusedLayer=null;}
function refreshAttention(){child.useAttention=child.useAttention;}
${body}
`,
  })
  const { session, events } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-attention.tjs","savedata/layer-attention.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-attention.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-attention.tjs")')
    const windowId = Number(await session.evaluate('win.__windowId')),
      rootId = Number(await session.evaluate('root.__id')),
      parentId = Number(await session.evaluate('parent.__id')),
      childId = Number(await session.evaluate('child.__id')),
      otherId = Number(await session.evaluate('other.__id'))
    return {
      ...harness,
      windowId,
      rootId,
      parentId,
      childId,
      otherId,
      run: (name: string) => session.evaluate(`${name}()`),
      view(id = windowId): InputView {
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index]!
          if (event.type === 'window-input' && event.windowId === id) return event.input
        }
        throw new Error(`No published input view for Window ${id}`)
      },
      async stop() {
        await session.stop()
        assert.equal(session.snapshot().handles, 0)
        assert.equal(session.snapshot().bitmapBytes, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

function point(view: InputView) {
  const attention = view.attention
  assert(attention, 'Window should publish an enabled attention point')
  const { x, y, focusLayerId, pointLayerId } = attention
  return { x, y, focusLayerId, pointLayerId }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: setAttentionPos checks arity, returns void, ignores extras and does not enable attention`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var defaults=[child.attentionLeft,child.attentionTop,int(child.useAttention)].join(",");
var errors=[];
try{child.setAttentionPos();}catch(error){errors.add(error.message);}
try{child.setAttentionPos(6);}catch(error){errors.add(error.message);}
var missingState=[child.attentionLeft,child.attentionTop,int(child.useAttention)].join(",");
var returned=child.setAttentionPos(-8.9,"12.9",%[]);
var converted=[child.attentionLeft,child.attentionTop,int(child.useAttention),typeof returned].join(",");
child.setAttentionPos(void,true);
var explicitVoid=[child.attentionLeft,child.attentionTop,int(child.useAttention)].join(",");
child.setAttentionPos(false,-4.9);
var booleanAndNegative=[child.attentionLeft,child.attentionTop,int(child.useAttention)].join(",");
child.useAttention=0.5;var fractionalUse=int(child.useAttention);child.useAttention=false;
child.focus();
`,
    )
    try {
      assert.equal(await f.session.evaluate('defaults'), '0,0,0')
      const errors = (await f.session.evaluate('errors.join("|")')).split('|')
      assert.equal(errors.length, 2)
      for (const error of errors) assert.match(error, /argument/i)
      assert.equal(await f.session.evaluate('missingState'), '0,0,0')
      assert.equal(await f.session.evaluate('converted'), '-8,12,0,undefined')
      assert.equal(await f.session.evaluate('explicitVoid'), '0,1,0')
      assert.equal(await f.session.evaluate('booleanAndNegative'), '0,-4,0')
      assert.equal(await f.session.evaluate('fractionalUse'), '1')
      assert.equal(f.view().focused, f.childId)
      assert.equal(f.view().attention, null)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: both attention coordinates convert before either value or the sampled point changes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.setAttentionPos(17,19);child.useAttention=true;child.focus();
function rejectCoordinates(){
  var calls=[function(){child.setAttentionPos(99,%[]);},
    function(){child.setAttentionPos(%[],88);},
    function(){child.setAttentionPos(77,null);},
    function(){child.setAttentionPos(66,<% 01 %>);}],states=[];
  for(var i=0;i<calls.count;i++){
    try{calls[i]();states.add("accepted");}catch(error){states.add("rejected");}
    states.add(child.attentionLeft+","+child.attentionTop);
  }
  return states.join("|");
}
`,
    )
    try {
      const before = structuredClone(f.view().attention)
      assert.equal(
        await f.run('rejectCoordinates'),
        'rejected|17,19|rejected|17,19|rejected|17,19|rejected|17,19',
      )
      assert.deepEqual(f.view().attention, before)
      assert.deepEqual(point(f.view()), {
        x: 40,
        y: 33,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: attention methods and properties preserve signed native 32-bit coordinate conversion`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.setAttentionPos(0x20000000000001,-0xffffffff);
var methodWide=[child.attentionLeft,child.attentionTop].join(",");
child.attentionLeft=0x100000002;child.attentionTop=0x1ffffffff;
var propertyWide=[child.attentionLeft,child.attentionTop].join(",");
child.useAttention=true;child.focus();
`,
    )
    try {
      assert.equal(await f.session.evaluate('methodWide'), '1,1')
      assert.equal(await f.session.evaluate('propertyWide'), '2,-1')
      assert.deepEqual(point(f.view()), {
        x: 25,
        y: 13,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: attention coordinates work without a MainImage and a saved method rejects an invalidated Layer`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.hasImage=false;child.setAttentionPos(-30,7);child.useAttention=true;child.focus();
function invalidateAndCall(){
  var setter=child.setAttentionPos;
  invalidate child;
  try{setter(1,2);}catch(error){return "rejected";}
  return "accepted";
}
`,
    )
    try {
      assert.equal(await f.session.evaluate('int(child.hasImage)'), '0')
      assert.deepEqual(point(f.view()), {
        x: -7,
        y: 21,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
      assert.equal(f.view().attention?.font, null)
      assert.equal(await f.run('invalidateAndCall'), 'rejected')
      assert.equal(f.view().focused, f.otherId)
      assert.equal(f.view().attention, null)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: attention chooses the nearest enabled ancestor and disabling the focus can fall back to its parent`, async () => {
    const f = await fixture(
      binary,
      String.raw`
root.setAttentionPos(7,9);root.useAttention=true;
parent.setAttentionPos(-5,6);parent.useAttention=true;
child.setAttentionPos(2,3);child.focus();
function enableChild(){child.useAttention=true;}
function disableChild(){child.useAttention=false;}
function disableParent(){parent.useAttention=false;}
function disableRoot(){root.useAttention=false;}
`,
    )
    try {
      assert.deepEqual(point(f.view()), {
        x: 15,
        y: 16,
        focusLayerId: f.childId,
        pointLayerId: f.parentId,
      })
      await f.run('enableChild')
      assert.deepEqual(point(f.view()), {
        x: 25,
        y: 17,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
      await f.run('disableChild')
      assert.equal(point(f.view()).pointLayerId, f.parentId)
      await f.run('disableParent')
      assert.equal(point(f.view()).pointLayerId, f.parentId, 'ancestor setter does not resample')
      await f.run('refreshAttention')
      assert.deepEqual(point(f.view()), {
        x: 7,
        y: 9,
        focusLayerId: f.childId,
        pointLayerId: f.rootId,
      })
      await f.run('disableRoot')
      assert.equal(point(f.view()).pointLayerId, f.rootId)
      await f.run('refreshAttention')
      assert.equal(f.view().attention, null)
      assert.equal(f.view().focused, f.childId)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: ancestor mutations and repeated focus keep the sample until each focused attention setter refreshes it`, async () => {
    const f = await fixture(
      binary,
      String.raw`
parent.setAttentionPos(-5,6);parent.useAttention=true;child.focus();
function moveAncestor(){parent.setPos(40,30);parent.setAttentionPos(8,9);child.setPos(6,8);}
function sameLeft(){child.attentionLeft=child.attentionLeft;}
function moveAgain(){parent.setPos(50,60);}
function sameTop(){child.attentionTop=child.attentionTop;}
function changeAncestorPoint(){parent.setAttentionPos(11,13);}
function changeAgain(){parent.setAttentionPos(14,15);}
function samePosition(){child.setAttentionPos(child.attentionLeft,child.attentionTop);}
`,
    )
    try {
      const initial = structuredClone(f.view().attention)
      await f.run('moveAncestor')
      assert.deepEqual(f.view().attention, initial)
      await f.run('focusChild')
      assert.deepEqual(f.view().attention, initial, 'same-focus call is not a successful change')
      await f.run('sameLeft')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [48, 39])
      await f.run('moveAgain')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [48, 39])
      await f.run('sameTop')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [58, 69])
      await f.run('changeAncestorPoint')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [58, 69])
      await f.run('refreshAttention')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [61, 73])
      await f.run('changeAgain')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [61, 73])
      await f.run('samePosition')
      assert.deepEqual([point(f.view()).x, point(f.view()).y], [64, 75])
      assert.equal(point(f.view()).pointLayerId, f.parentId)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: image offsets, clip and opacity never become attention display coordinates`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.setAttentionPos(4,6);child.useAttention=true;child.focus();
function changeAppearance(){
  child.setImagePos(-2,-1);child.setClip(2,3,10,11);child.opacity=0;
  parent.setImagePos(-4,-5);parent.setClip(1,2,20,21);parent.opacity=37;
  child.useAttention=child.useAttention;
}
`,
    )
    try {
      const before = structuredClone(f.view().attention)
      await f.run('changeAppearance')
      assert.deepEqual(f.view().attention, before)
      assert.deepEqual(point(f.view()), {
        x: 27,
        y: 20,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Web caret projection uses internal Layer offset and fractional Window zoom without resampling geometry`, async () => {
    const f = await fixture(
      binary,
      String.raw`
win.left=90;win.top=80;win.setLayerPos(-7,5);win.setZoom(2,3);
parent.setPos(10,-5);child.setPos(-3,4);child.setAttentionPos(-2,7);
child.useAttention=true;child.focus();
function projectAgain(){
  parent.setPos(70,80);win.left=-90;win.top=-80;
  win.setLayerPos(11,-13);win.setZoom(5,4);
}
`,
    )
    try {
      const first = point(f.view())
      assert(Math.abs(first.x - -11 / 3) < 1e-12)
      assert.equal(first.y, 9)
      assert.equal(first.pointLayerId, f.childId)
      await f.run('projectAgain')
      assert.deepEqual(point(f.view()), {
        x: 17.25,
        y: -5.5,
        focusLayerId: f.childId,
        pointLayerId: f.childId,
      })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: ancestor attention copies the focused MainImage font and falls back to null without one`, async () => {
    const f = await fixture(
      binary,
      String.raw`
parent.font.face="serif";parent.font.height=31;parent.useAttention=true;
child.font.face="monospace";child.font.height=23;child.font.bold=true;
child.font.italic=true;child.font.underline=true;child.font.strikeout=true;
child.focus();
function changeFont(){
  child.font.face="sans-serif";child.font.height=22;child.font.bold=false;
  child.font.italic=false;child.font.underline=false;child.font.strikeout=false;
}
function removeMain(){child.hasImage=false;}
function mutateReleased(){child.setSize(41,31);child.font.height=19;}
function restoreMain(){child.hasImage=true;}
`,
    )
    try {
      const first = {
        face: 'monospace',
        height: 23,
        bold: true,
        italic: true,
        underline: true,
        strikeout: true,
      }
      assert.equal(point(f.view()).pointLayerId, f.parentId)
      assert.deepEqual(f.view().attention?.font, first)
      await f.run('changeFont')
      assert.deepEqual(f.view().attention?.font, first, 'font values are copied at sampling time')
      await f.run('refreshAttention')
      const changed = {
        face: 'sans-serif',
        height: 22,
        bold: false,
        italic: false,
        underline: false,
        strikeout: false,
      }
      assert.deepEqual(f.view().attention?.font, changed)
      await f.run('removeMain')
      assert.deepEqual(
        f.view().attention?.font,
        changed,
        'MainImage release does not resample font',
      )
      await f.run('mutateReleased')
      assert.deepEqual(f.view().attention?.font, changed, 'resize and font setters keep the sample')
      await f.run('refreshAttention')
      assert.equal(point(f.view()).pointLayerId, f.parentId)
      assert.equal(f.view().attention?.font, null, 'ancestor font is not a no-MainImage fallback')
      await f.run('restoreMain')
      assert.equal(f.view().attention?.font, null, 'MainImage allocation does not resample font')
      await f.run('refreshAttention')
      assert.deepEqual(f.view().attention?.font, { ...changed, height: 19 })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: attention font mirroring preserves permitted zero, large and image-less Font assignments`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.useAttention=true;child.focus();
function zeroHeight(){child.font.height=0;return child.font.height;}
function largeHeight(){child.font.height=1048576;return child.font.height;}
function imageLessFont(){
  child.hasImage=false;child.font.height=-1048576;child.font.face="Image-less font";
  child.font.bold=true;child.font.angle=900;child.font.faceIsFileName=true;
  return [child.font.height,child.font.face,int(child.font.bold),child.font.angle,
    int(child.font.faceIsFileName)].join("|");
}
`,
    )
    try {
      const before = structuredClone(f.view().attention?.font)
      assert.equal(await f.run('zeroHeight'), '0')
      assert.deepEqual(f.view().attention?.font, before)
      await f.run('refreshAttention')
      assert.equal(f.view().attention?.font?.height, 0)
      assert.equal(await f.run('largeHeight'), '1048576')
      assert.equal(f.view().attention?.font?.height, 0)
      await f.run('refreshAttention')
      assert.equal(f.view().attention?.font?.height, 1048576)
      assert.equal(await f.run('imageLessFont'), '1048576|Image-less font|1|900|1')
      await f.run('refreshAttention')
      assert.equal(f.view().attention?.font, null)
      assert.equal(point(f.view()).focusLayerId, f.childId)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: attention mirroring permits cached Font finalizer writes and preserves the original failure for Layer retry`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var font=null,failFont=true,fontDeaths=0,fontTrace="";
function makeFailingFont(){
  font=child.font;
  font.finalize=function(){
    global.fontDeaths++;
    global.font.height=0;global.font.face="Finalizer font";global.font.italic=true;
    global.fontTrace+=global.font.height+":"+global.font.face+":"+int(global.font.italic)+";";
    if(global.failFont)throw new global.Exception("attention-font-finalizer");
  };
}
function attemptRelease(){try{invalidate child;}catch(error){return error.message;}return "accepted";}
function writeAfterFailure(){font.height=1048576;return font.height;}
function finishRelease(){failFont=false;invalidate child;}
`,
    )
    try {
      const baseline = f.session.inspectOwnership()
      await f.run('makeFailingFont')
      assert.equal(f.session.inspectOwnership().fontSources, baseline.fontSources + 1)
      assert.equal(await f.run('attemptRelease'), 'attention-font-finalizer')
      assert.equal(await f.session.evaluate('(isvalid child)+","+(isvalid font)'), '1,1')
      assert.equal(await f.session.evaluate('fontTrace'), '0:Finalizer font:1;')
      assert.equal(f.session.inspectOwnership().closingLayers, 0)
      assert.equal(f.session.inspectOwnership().fontSources, baseline.fontSources + 1)
      assert.equal(await f.run('writeAfterFailure'), '1048576')
      await f.run('finishRelease')
      assert.equal(await f.session.evaluate('(isvalid child)+","+(isvalid font)'), '0,0')
      assert.equal(await f.session.evaluate('fontDeaths'), '2')
      assert.equal(await f.session.evaluate('fontTrace'), '0:Finalizer font:1;0:Finalizer font:1;')
      assert.equal(f.session.inspectOwnership().closingLayers, 0)
      assert.equal(f.session.inspectOwnership().fontSources, baseline.fontSources)
      assert.equal(f.session.inspectOwnership().layerSources, baseline.layerSources - 1)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a successful focus change samples after callbacks and clearing focus discards the point`, async () => {
    const f = await fixture(
      binary,
      String.raw`
parent.useAttention=true;parent.setAttentionPos(1,2);
other.useAttention=true;other.setAttentionPos(13,17);other.focus();
var focusCalls=0;
child.onFocus=function(previous,direction){focusCalls++;parent.setAttentionPos(44,55);};
`,
    )
    try {
      assert.deepEqual(point(f.view()), {
        x: 103,
        y: 57,
        focusLayerId: f.otherId,
        pointLayerId: f.otherId,
      })
      await f.run('focusChild')
      assert.equal(await f.session.evaluate('focusCalls'), '1')
      assert.deepEqual(point(f.view()), {
        x: 64,
        y: 65,
        focusLayerId: f.childId,
        pointLayerId: f.parentId,
      })
      await f.run('focusChild')
      assert.equal(await f.session.evaluate('focusCalls'), '1')
      await f.run('clearFocus')
      assert.equal(f.view().focused, 0)
      assert.equal(f.view().attention, null)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a throwing focus callback does not publish a normal resample but a later setter can recover`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.setAttentionPos(2,3);child.useAttention=true;child.focus();
other.setAttentionPos(13,17);other.useAttention=true;
other.onFocus=function(previous,direction){throw new global.Exception("attention-focus-failure");};
function failFocus(){try{other.focus();}catch(error){return error.message;}return "accepted";}
function refreshOther(){other.useAttention=other.useAttention;}
`,
    )
    try {
      const before = structuredClone(f.view().attention)
      assert.equal(await f.run('failFocus'), 'attention-focus-failure')
      assert.equal(f.view().focused, f.otherId)
      assert.deepEqual(f.view().attention, before)
      await f.run('focusOther')
      assert.deepEqual(
        f.view().attention,
        before,
        'same-focus early return cannot repair the sample',
      )
      await f.run('refreshOther')
      assert.deepEqual(point(f.view()), {
        x: 103,
        y: 57,
        focusLayerId: f.otherId,
        pointLayerId: f.otherId,
      })
      await f.run('clearFocus')
      assert.equal(f.view().attention, null)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: invalidating an old sampled ancestor after failed focus cannot leave its point attached to the new focus`, async () => {
    const f = await fixture(
      binary,
      String.raw`
parent.useAttention=true;parent.setAttentionPos(7,8);child.focus();
other.onFocus=function(previous,direction){throw new global.Exception("attention-old-point");};
function failFocus(){try{other.focus();}catch(error){return error.message;}return "accepted";}
function removeOldPoint(){invalidate parent;}
`,
    )
    try {
      const before = structuredClone(f.view().attention)
      assert.equal(await f.run('failFocus'), 'attention-old-point')
      assert.equal(f.view().focused, f.otherId)
      assert.deepEqual(f.view().attention, before)
      await f.run('removeOldPoint')
      assert.equal(f.view().focused, f.otherId)
      assert.equal(f.view().attention, null)
      assert.equal(await f.session.evaluate('isvalid child'), '1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: replacing a Window during blur clears its manager sample before focusing the replacement`, async () => {
    const f = await fixture(
      binary,
      String.raw`
child.useAttention=true;child.setAttentionPos(71,73);child.focus();
var replacementCalls=0;
child.onBlur=function(next){
  invalidate win;
  win=new global.Window();win.setInnerSize(160,120);win.visible=true;
  root=new global.Layer(win,null);root.setSize(160,120);
  var replacement=new global.Layer(win,root);
  replacement.visible=true;replacement.focusable=true;
  replacement.onFocus=function(previous,direction){replacementCalls++;};
  replacement.focus();
};
`,
    )
    try {
      assert(point(f.view()))
      await f.run('focusOther')
      const replacementWindowId = Number(await f.session.evaluate('win.__windowId')),
        replacementLayerId = Number(await f.session.evaluate('win.focusedLayer.__id'))
      assert.notEqual(replacementWindowId, f.windowId)
      assert.notEqual(replacementLayerId, f.childId)
      assert.equal(await f.session.evaluate('replacementCalls'), '1')
      assert.equal(f.view(replacementWindowId).focused, replacementLayerId)
      assert.equal(f.view(replacementWindowId).attention, null)
      assert(
        f.events.some((event) => event.type === 'window-closed' && event.windowId === f.windowId),
      )
      const inputEvents = f.events.filter((event) => event.type === 'input')
      assert.equal(inputEvents.at(-1)?.input.attention, null)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: disabling attention keeps Layer character input and its manager focus operational`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var text="";
child.onKeyPress=function(value,process){text+=value;};
child.focus();
`,
    )
    try {
      assert.equal(f.view().attention, null)
      await f.session.input({ type: 'text', windowId: f.windowId, text: '字🌸' })
      assert.equal(await f.session.evaluate('text'), '字🌸')
      assert.equal(f.view().focused, f.childId)
      assert.equal(f.view().attention, null)
    } finally {
      await f.stop()
    }
  })
}

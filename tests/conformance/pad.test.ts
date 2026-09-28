import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent, SessionDependencies } from '../../src/engine/session.ts'
import { PadService, padProperties, type PadPolicy } from '../../src/engine/scene/pads.ts'
import { SystemColors } from '../../src/engine/graphics/system-colors.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type {
  ScriptObject,
  ScriptRuntime,
  ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'
import type { PadMessage, PadPresentation, PadView } from '../../src/protocol/pad.ts'
import { systemColorPalette } from '../helpers/system-colors-script.ts'

const test = (name: string, run: () => Promise<void> | void) =>
  nodeTest(name, { timeout: 60000 }, run)

// Deliberately list the public contract independently of the implementation.
const properties = [
  'text',
  'fileName',
  'color',
  'visible',
  'title',
  'fontColor',
  'fontHeight',
  'fontSize',
  'fontBold',
  'fontItalic',
  'fontUnderline',
  'fontStrikeOut',
  'fontFace',
  'readOnly',
  'wordWrap',
  'opacity',
  'showStatusBar',
  'showScrollBars',
  'statusText',
  'borderStyle',
  'width',
  'height',
  'top',
  'left',
] as const
const textProperties = ['text', 'fileName', 'title', 'fontFace', 'statusText']
const booleanProperties = ['visible', 'readOnly', 'wordWrap', 'showStatusBar']
const styleProperties = ['fontBold', 'fontItalic', 'fontUnderline', 'fontStrikeOut']
const integerProperties = properties.filter(
  (name) => !textProperties.includes(name) && !booleanProperties.includes(name),
)

function latestPads(events: EngineEvent[]): PadPresentation {
  const event = events.filter((event) => event.type === 'pads').at(-1)
  assert(event?.type === 'pads', 'The session must publish the auxiliary Pad presentation')
  return event
}

async function fixture(
  binary: boolean,
  source: string,
  overrides: Partial<SessionDependencies> = {},
) {
  const harness = await headless(
    {
      'startup.tjs': binary
        ? 'Scripts.compileStorage("pad.tjs","savedata/pad.cjs",false,true,false);Scripts.execStorage("savedata/pad.cjs");'
        : 'Scripts.execStorage("pad.tjs");',
      'pad.tjs': source,
    },
    overrides,
  )
  try {
    await harness.session.start()
    const compiled = harness.session.exportSaves().find((file) => file.path === 'savedata/pad.cjs')
    if (binary) {
      assert(compiled, 'The bytecode path must execute the compiled storage')
      assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
      assert(compiled.bytes.length > 16)
    } else assert.equal(compiled, undefined)
  } catch (error) {
    await harness.session.stop()
    throw error
  }
  return harness
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`Pad is a native Class with 24 receiver-bound native Properties and ignored constructor arguments (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var pad=new Pad("ignored title",123,%[text:"ignored text"],<% 01 %>);
var identity=[Pad instanceof "Class",Pad instanceof "Pad",pad instanceof "Pad",
  pad instanceof "Class",pad instanceof "Window",pad.Pad instanceof "Function",
  pad.finalize instanceof "Function"].join("|");
var names=${JSON.stringify(properties)},propertyIdentities=[];
for(var i=0;i<names.count;i++){
  propertyIdentities.add((&pad[names[i]]) instanceof "Property");
}
var absent=[typeof pad.open,typeof pad.save,typeof pad.showModal,typeof pad.execute].join("|");
`,
    )
    try {
      assert.equal(await session.evaluate('identity'), '1|1|1|0|0|1|1')
      assert.equal(
        await session.evaluate('propertyIdentities.join(",")'),
        Array(24).fill('1').join(','),
      )
      assert.equal(await session.evaluate('absent'), 'undefined|undefined|undefined|undefined')
      assert.equal(await session.evaluate('pad.title'), 'Pad')
      assert.equal(await session.evaluate('pad.text'), '')
      assert.equal(await session.evaluate('pad.fileName'), '')
      assert.equal(latestPads(events).pads.length, 1)
      assert.equal(session.snapshot().mainWindow, 0)
      assert.deepEqual(session.snapshot().windows, [])
      assert.equal(session.inspectOwnership().padSources, 1)
    } finally {
      await session.stop()
    }
    assert.equal(session.inspectOwnership().padSources, 0)
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Pad supports derived constructors and borrowing a property onto another real Pad (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
class Editor extends Pad {
  function Editor(value){super.Pad("ignored");text=value;title="Derived";}
}
var a=new Editor("A"),b=new Pad();b.text="B";
var rebound=(&a.text) incontextof b;
*(&global.rebound)="borrowed";
var result=[a instanceof "Editor",a instanceof "Pad",a.title,a.text,b.text,
  *(&global.rebound)].join("|");
var repeated="";try{a.Pad();}catch(error){repeated=error.message;}
`,
    )
    try {
      assert.equal(await session.evaluate('result'), '1|1|Derived|A|borrowed|borrowed')
      assert.match(await session.evaluate('repeated'), /already been constructed/)
      assert.equal(session.inspectOwnership().padSources, 2)
      assert.deepEqual(
        latestPads(events).pads.map((pad) => pad.text),
        ['A', 'borrowed'],
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad native getters and setters reject forged receivers without touching either Pad (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var a=new Pad(),b=new Pad();a.text="first";b.text="second";
var fake=%[__padId:1,__id:1,text:"fake"],names=${JSON.stringify(properties)},errors=0;
for(var i=0;i<names.count;i++){
  var bad=(&a[names[i]]) incontextof fake;
  try{var ignored=*bad;}catch(error){errors++;}
  try{*bad=void;}catch(error){errors++;}
}
var badCtor=a.Pad incontextof fake;
try{badCtor();}catch(error){errors++;}
`,
    )
    try {
      assert.equal(await session.evaluate('errors'), '49')
      assert.equal(await session.evaluate('fake.text'), 'fake')
      assert.equal(await session.evaluate('[a.text,b.text].join("|")'), 'first|second')
      assert.equal(session.inspectOwnership().padSources, 2)
      assert.deepEqual(
        latestPads(events).pads.map((pad) => pad.text),
        ['first', 'second'],
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad string setters use native ttstr conversion and reject octets atomically (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var pad=new Pad(),names=${JSON.stringify(textProperties)},rows=[],rejected=0;
var object=%[toString:function(){throw new Exception("must not invoke a JS-style toString");}];
var expectedObject=string(object);
for(var i=0;i<names.count;i++){
  var name=names[i];pad[name]=void;rows.add(pad[name]==="");
  pad[name]=9007199254740993;rows.add(pad[name]==="9007199254740993");
  pad[name]=-7;rows.add(pad[name]==="-7");
  pad[name]=object;rows.add(pad[name]===expectedObject);
  pad[name]="safe";
  try{pad[name]=<% 01 02 %>;}catch(error){rejected++;}
  rows.add(pad[name]==="safe");
}
`,
    )
    try {
      assert.equal(await session.evaluate('rows.join(",")'), Array(25).fill('1').join(','))
      assert.equal(await session.evaluate('rejected'), '5')
    } finally {
      await session.stop()
    }
  })

  test(`Pad boolean properties preserve native real, numeric-string, object and octet truthiness (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var pad=new Pad(),names=${JSON.stringify(booleanProperties)},rows=[];
var values=[void,0,0.5,-0.5,"0","1","0.5","not numeric",null,%[],<% 01 %>];
for(var i=0;i<names.count;i++){
  var row=[];for(var j=0;j<values.count;j++){pad[names[i]]=values[j];row.add(pad[names[i]]);}
  rows.add(row.join(","));
}
`,
    )
    try {
      assert.equal(
        await session.evaluate('rows.join("|")'),
        Array(4).fill('0,0,1,1,0,1,0,0,0,1,1').join('|'),
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad font styles narrow integers before truthiness and remain independent (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var pad=new Pad(),names=${JSON.stringify(styleProperties)},rows=[];
var values=[0.5,-0.5,1,-1,"1",4294967296,4294967297,9007199254740993,void];
for(var i=0;i<names.count;i++){
  var row=[];for(var j=0;j<values.count;j++){pad[names[i]]=values[j];row.add(pad[names[i]]);}
  rows.add(row.join(","));
}
pad.fontBold=1;pad.fontUnderline=1;pad.fontItalic=0;pad.fontStrikeOut=0;
`,
    )
    try {
      assert.equal(
        await session.evaluate('rows.join("|")'),
        Array(4).fill('0,0,1,1,1,0,1,1,0').join('|'),
      )
      const pad = latestPads(events).pads[0]!
      assert.deepEqual(
        [pad.fontBold, pad.fontItalic, pad.fontUnderline, pad.fontStrikeOut],
        [true, false, true, false],
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad all integer properties reject native object and octet conversions before mutation (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var pad=new Pad(),names=${JSON.stringify(integerProperties)},rejected=0,unchanged=0;
pad.color=0x123456;pad.fontColor=0xaabbcc;
for(var i=0;i<names.count;i++){
  var before=pad[names[i]],values=[%[],null,<% 01 %>];
  for(var j=0;j<values.count;j++){
    try{pad[names[i]]=values[j];}catch(error){rejected++;}
    if(pad[names[i]]===before)unchanged++;
  }
}
`,
    )
    try {
      assert.equal(await session.evaluate('rejected'), String(integerProperties.length * 3))
      assert.equal(await session.evaluate('unchanged'), String(integerProperties.length * 3))
      const pad = latestPads(events).pads[0]!
      assert.equal(pad.color, 0x123456)
      assert.equal(pad.inkColor, 0xaabbcc)
    } finally {
      await session.stop()
    }
  })

  test(`Pad script geometry and legal enums narrow in TJS without imposing user-resize minimums (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var pad=new Pad(),rows=[];
pad.width="160.9";pad.height=120.9;pad.left=4294967297;pad.top=-4294967297;
rows.add([pad.width,pad.height,pad.left,pad.top].join(","));
pad.width=4294967456;pad.height=4294967416;pad.left=9007199254740993;pad.top=void;
rows.add([pad.width,pad.height,pad.left,pad.top].join(","));
pad.width=60;pad.height=90;rows.add([pad.width,pad.height].join(","));
var scrolls=[],borders=[];
for(var i=0;i<4;i++){pad.showScrollBars=4294967296+i;scrolls.add(pad.showScrollBars);}
for(var i=0;i<6;i++){pad.borderStyle=4294967296+i;borders.add(pad.borderStyle);}
var rejected=0;try{pad.showScrollBars=4;}catch(error){rejected++;}
try{pad.borderStyle=6;}catch(error){rejected++;}
`,
    )
    try {
      assert.equal(await session.evaluate('rows.join("|")'), '160,120,1,-1|160,120,1,0|60,90')
      assert.equal(await session.evaluate('scrolls.join(",")'), '0,1,2,3')
      assert.equal(await session.evaluate('borders.join(",")'), '0,1,2,3,4,5')
      assert.equal(
        await session.evaluate('[rejected,pad.showScrollBars,pad.borderStyle].join(",")'),
        '2,3,5',
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad fontsize and height follow the pinned SDK small-value coupling and opacity stays 255 (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var pad=new Pad(),rows=[],heights=[12,-12,13,14,0],sizes=[9,-9,10,11,0],alpha=[];
for(var i=0;i<heights.count;i++){pad.fontHeight=heights[i];rows.add(pad.fontHeight+","+pad.fontSize);}
for(var i=0;i<sizes.count;i++){pad.fontSize=sizes[i];rows.add(pad.fontHeight+","+pad.fontSize);}
var values=[-1,0,128,255,256,4294967296,"128",void];
for(var i=0;i<values.count;i++){pad.opacity=values[i];alpha.add(pad.opacity);}
`,
    )
    try {
      assert.equal(
        await session.evaluate('rows.join("|")'),
        '12,9|12,9|13,10|14,11|0,0|12,9|12,9|13,10|15,11|0,0',
      )
      assert.equal(await session.evaluate('alpha.join(",")'), Array(8).fill('255').join(','))
    } finally {
      await session.stop()
    }
  })

  test(`Pad resolves RGB and system colors while its fontColor getter retains the original background bug (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var pad=new Pad(),rows=[];
pad.color=0x123456;pad.fontColor=0xaabbcc;
rows.add([pad.color,pad.fontColor].join(","));
pad.color=clWindow;pad.fontColor=clHighlight;
rows.add([pad.color,pad.fontColor,System.toActualColor(clWindow)].join(","));
pad.color=0x01123456;pad.fontColor=4296090163;
rows.add([pad.color,pad.fontColor].join(","));
`,
      { systemColors: systemColorPalette },
    )
    try {
      assert.equal(
        await session.evaluate('rows.join("|")'),
        `${0x123456},${0x123456}|${systemColorPalette[5]},${systemColorPalette[5]},${systemColorPalette[5]}|${0x563412},${0x563412}`,
      )
      const pads = events.filter(
        (event): event is Extract<EngineEvent, { type: 'pads' }> => event.type === 'pads',
      )
      assert(
        pads.some(
          (event) => event.pads[0]?.inkColor === 0xaabbcc && event.pads[0]?.color === 0x123456,
        ),
      )
      assert(
        pads.some(
          (event) =>
            event.pads[0]?.inkColor === systemColorPalette[13] &&
            event.pads[0]?.color === systemColorPalette[5],
        ),
      )
      assert.equal(latestPads(events).pads[0]!.inkColor, 0x112233)
    } finally {
      await session.stop()
    }
  })

  test(`Pad text preserves observed CR/LF round trips and explicit Web Unicode (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      String.raw`
var pad=new Pad(),rows=[];
function units(value){var result=[];for(var n=0;n<value.length;n++)result.add(#(value.charAt(n)));return result.join(",");}
var values=["","a","a\nb","a\r\nb","a\rb","\n","a\n","a\r\n","a\r","雪😀"];
for(var i=0;i<values.count;i++){pad.text=values[i];rows.add(units(pad.text));}
pad.text="script can still write";pad.readOnly=true;pad.text="readonly script update";
`,
    )
    try {
      assert.equal(
        await session.evaluate('rows.join("|")'),
        '|97|97,13,10,98|97,13,10,98|97,13,98|13,10|97,13,10|97,13,10|97,13|38634,55357,56832',
      )
      assert.equal(await session.evaluate('pad.text'), 'readonly script update')
    } finally {
      await session.stop()
    }
  })

  test(`Pad fileName does no I/O or title change and independent hidden Pads retain their values (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var a=new Pad(),b=new Pad();a.text="A";b.text="B";a.title="first";b.title="second";
a.fileName="does-not-exist.tjs";b.fileName="savedata/other.tjs";
a.fontFace="Unicode 字体";b.fontFace="Other";a.statusText="A-status";b.statusText="B-status";
a.visible=true;a.visible=false;a.text="hidden update";
`,
    )
    try {
      assert.equal(
        await session.evaluate('[a.text,a.title,a.fileName,b.text,b.title,b.fileName].join("|")'),
        'hidden update|first|does-not-exist.tjs|B|second|savedata/other.tjs',
      )
      assert.deepEqual(
        session.exportSaves().map((file) => file.path),
        binary ? ['savedata/pad.cjs'] : [],
      )
      assert.deepEqual(
        latestPads(events).pads.map((pad) => [pad.fontFace, pad.statusText, pad.visible]),
        [
          ['Unicode 字体', 'A-status', false],
          ['Other', 'B-status', false],
        ],
      )
    } finally {
      await session.stop()
    }
  })

  test(`Pad direct finalize leaves native resources alive and explicit invalidation removes exactly once (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var calls=0;
class Editor extends Pad {
  function Editor(){super.Pad();text="live";visible=true;}
  function finalize(){global.calls++;}
}
var pad=new Editor(),saved=&pad.text;pad.finalize();
function retire(){invalidate pad;invalidate pad;return global.calls;}
function deadAccess(){try{return *(&global.saved);}catch(error){return "rejected";}}
`,
    )
    try {
      assert.equal(await session.evaluate('[calls,isvalid pad,pad.text].join("|")'), '1|1|live')
      assert.equal(session.inspectOwnership().padSources, 1)
      const id = latestPads(events).pads[0]!.id
      const before = events.length
      assert.equal(await session.evaluate('retire()'), '2')
      assert.equal(await session.evaluate('isvalid pad'), '0')
      assert.equal(await session.evaluate('deadAccess()'), 'rejected')
      assert.equal(session.inspectOwnership().padSources, 0)
      assert.equal(
        events
          .slice(before)
          .filter((event) => event.type === 'pads' && !event.pads.some((pad) => pad.id === id))
          .length,
        1,
      )
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Pad finalizer failure preserves native state until a successful retry (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var retry=false,trace=[];
class Editor extends Pad {
  function Editor(){super.Pad();text="live";visible=true;}
  function finalize(){
    global.trace.add(this.text+":"+(isvalid this));this.text="inside";
    if(!global.retry)throw new global.Exception("pad-finalizer-failed");
  }
}
var pad=new Editor();
function attempt(){try{invalidate global.pad;return "retired";}catch(error){return error.message;}}
function allowRetry(){global.retry=true;return global.attempt();}
`,
    )
    try {
      assert.equal(await session.evaluate('attempt()'), 'pad-finalizer-failed')
      assert.equal(
        await session.evaluate('[isvalid pad,pad.text,pad.visible].join("|")'),
        '1|inside|1',
      )
      assert.equal(session.inspectOwnership().padSources, 1)
      assert.equal(latestPads(events).pads[0]!.text, 'inside')
      assert.equal(await session.evaluate('allowRetry()'), 'retired')
      assert.equal(await session.evaluate('trace.join("|")'), 'live:1|inside:1')
      assert.equal(session.inspectOwnership().padSources, 0)
      assert.deepEqual(latestPads(events).pads, [])
    } finally {
      await session.stop()
    }
  })

  test(`Pad recursive invalidation runs one finalizer with still-live native properties (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var calls=0,trace="";
class Editor extends Pad {
  function Editor(){super.Pad();text="before";}
  function finalize(){global.calls++;invalidate this;this.text="after";global.trace=this.text+":"+(isvalid this);}
}
var pad=new Editor();invalidate pad;
`,
    )
    try {
      assert.equal(await session.evaluate('[calls,trace,isvalid pad].join("|")'), '1|after:1|0')
      assert.equal(session.inspectOwnership().padSources, 0)
      assert.equal(session.inspectOwnership().padTextUnits, 0)
    } finally {
      await session.stop()
    }
  })

  test(`Pad last-reference retirement releases the native and weak ownership edges (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
var finalized=0;
class Editor extends Pad {
  function Editor(){super.Pad();visible=true;text="temporary";}
  function finalize(){global.finalized++;}
}
function createAndDrop(){var local=new Editor();return 7;}
`,
    )
    try {
      const baseline = session.inspectOwnership(),
        handles = session.snapshot().handles
      assert.equal(await session.evaluate('createAndDrop()'), '7')
      assert.equal(await session.evaluate('finalized'), '1')
      const after = session.inspectOwnership()
      for (const name of [
        'padSources',
        'padTextUnits',
        'weakOwners',
        'pendingHandles',
        'pendingInvalidations',
        'dependents',
      ] as const)
        assert.equal(after[name], baseline[name], name)
      assert.equal(session.snapshot().handles, handles)
      assert.deepEqual(latestPads(events).pads, [])
    } finally {
      await session.stop()
    }
  })

  test(`Pad created before Window never occupies mainWindow and survives nonterminating Window closure (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
System.exitOnWindowClose=false;
var pad=new Pad();pad.text="independent";pad.visible=true;var win=null;
var noMain=Window.mainWindow===null;
function createGame(){win=new Window();return Window.mainWindow===win;}
function closeGame(){win.close();return pad.text;}
`,
    )
    try {
      assert.equal(await session.evaluate('noMain'), '1')
      assert.equal(session.inspectOwnership().windowSources, 0)
      assert.equal(session.inspectOwnership().layerSources, 0)
      assert.equal(await session.evaluate('createGame()'), '1')
      const withWindow = session.snapshot()
      assert(withWindow.mainWindow !== undefined && withWindow.mainWindow > 0)
      assert(withWindow.windows)
      assert.equal(withWindow.windows.length, 1)
      assert.equal(await session.evaluate('closeGame()'), 'independent')
      assert.equal(session.snapshot().mainWindow, 0)
      assert.equal(session.snapshot().state, 'running')
      assert.equal(session.inspectOwnership().padSources, 1)
      assert.equal(latestPads(events).pads[0]!.visible, true)
    } finally {
      await session.stop()
    }
  })

  test(`Stopping a session retires Pad resources even after a failed finalizer and rejects late edits (${mode})`, async () => {
    const { session, events } = await fixture(
      binary,
      `
class Editor extends Pad {
  function Editor(){super.Pad();visible=true;text="live";}
  function finalize(){throw new global.Exception("keep-alive");}
}
var pad=new Editor(),error="";try{invalidate pad;}catch(e){error=e.message;}
`,
    )
    const pad = latestPads(events).pads[0]!
    const late: PadMessage = {
      generation: 1,
      id: pad.id,
      epoch: pad.epoch,
      seq: 1,
      baseTextEpoch: pad.textEpoch,
      kind: 'edit',
      text: 'too late',
    }
    try {
      assert.equal(await session.evaluate('error'), 'keep-alive')
      assert.equal(session.inspectOwnership().padSources, 1)
    } finally {
      await session.stop()
    }
    assert.equal(session.inspectOwnership().padSources, 0)
    assert.equal(session.inspectOwnership().padTextUnits, 0)
    assert.equal(session.snapshot().handles, 0)
    assert.deepEqual(latestPads(events).pads, [])
    assert.equal(session.pad(late).status, 'ignored')
  })
}

/** Pure-service fixtures validate bounded policy and admission, not a replacement
 * VM. Native Class/Property identity and destruction are exercised above. */
function serviceFixture(policy: Partial<PadPolicy> = {}) {
  let next = 1,
    blocked = false
  const slots = new Map<ScriptObject, { operation: string; id: number }>()
  const weak = new Map<ScriptWeakObject, { owner: ScriptObject; expired: () => void }>()
  const presentations: PadPresentation[] = []
  const runtime = {
    registerNativeLifetime(owner: ScriptObject, operation: string, id: number) {
      slots.set(owner, { operation, id })
    },
    nativeLifetimeIdentifier(owner: ScriptObject, operation: string) {
      const slot = slots.get(owner)
      return slot?.operation === operation ? slot.id : undefined
    },
    observe(owner: ScriptObject, expired: () => void) {
      const token: ScriptWeakObject = { type: 'weak-object', id: next++, runtime: 1 }
      weak.set(token, { owner, expired })
      return token
    },
    unobserve(token: ScriptWeakObject) {
      assert(weak.delete(token), 'Weak observation must be removed once')
    },
    retain() {
      throw new Error('Pad state must not retain script owners')
    },
    release() {
      throw new Error('This fixture owns no strong script leases')
    },
    snapshot() {
      throw new Error('Pad state must not snapshot owners')
    },
  } as unknown as ScriptRuntime
  const loop = new ModalLoop(runtime, new ExecutionControl(), {
    hasWork: () => false,
    dispatch: () => ({ kind: 'value', value: undefined }),
    changed() {},
  })
  const service = new PadService(
    runtime,
    new SystemColors(systemColorPalette),
    loop,
    {
      changed: (value) => presentations.push(value),
      blocked: () => blocked,
    },
    { maxPads: 3, maxText: 8, maxTotalText: 12, opacity: 'fixed-255', ...policy },
  )
  const view = (id: number): PadView => {
    const found = service.presentation().pads.find((pad) => pad.id === id)
    assert(found)
    return found
  }
  return {
    service,
    presentations,
    slots,
    weak,
    view,
    add() {
      const owner: ScriptObject = { type: 'object', runtime: 1, id: next++ }
      return { owner, id: service.construct(owner) }
    },
    block(value: boolean) {
      blocked = value
    },
    message(id: number, seq: number, text: string): Extract<PadMessage, { kind: 'edit' }> {
      const pad = view(id)
      return {
        generation: 1,
        id,
        epoch: pad.epoch,
        baseTextEpoch: pad.textEpoch,
        seq,
        kind: 'edit',
        text,
      }
    },
  }
}

test('Pad resource policy enforces small injected instance and UTF-16 limits atomically', () => {
  const f = serviceFixture({ maxPads: 2 }),
    a = f.add(),
    b = f.add()
  assert.deepEqual(padProperties, properties)
  assert.throws(() => f.add(), /instance budget/)
  assert.equal(f.slots.size, 2)
  f.service.set(a.id, 'text', '😀123456') // Eight UTF-16 units; no large allocations.
  f.service.set(b.id, 'text', '1234')
  assert.equal(f.service.textUnits, 12)
  const before = f.service.presentation(),
    count = f.presentations.length
  assert.throws(() => f.service.set(a.id, 'text', '123456789'), /text budget/)
  assert.throws(() => f.service.set(b.id, 'text', '12345'), /text budget/)
  assert.deepEqual(f.service.presentation(), before)
  assert.equal(f.presentations.length, count)
  f.service.remove(a.id)
  assert.equal(f.service.textUnits, 4)
  f.service.set(b.id, 'text', '12345678')
  assert.equal(f.service.textUnits, 8)
  f.service.dispose()
  assert.equal(f.service.count, 0)
  assert.equal(f.service.textUnits, 0)
  assert.equal(f.weak.size, 0)
})

test('Pad edit budgets count normalized CRLF and rejected edits preserve their retry sequence', () => {
  const f = serviceFixture({ maxText: 4, maxTotalText: 4 }),
    { id } = f.add()
  f.service.set(id, 'visible', 1n)
  const before = f.view(id)
  assert.throws(() => f.service.admit(f.message(id, 1, 'a\nbc')), /text budget/)
  assert.deepEqual(f.view(id), before)
  const ack = f.service.admit(f.message(id, 1, 'a\nb'))
  assert.equal(ack.status, 'accepted')
  assert.equal(ack.view?.text, 'a\r\nb')
  assert.equal(ack.view?.acceptedEditSeq, 1)
  assert.equal(f.service.textUnits, 4)
  f.service.dispose()
})

test('Pad service preserves the explicit NUL boundary before counting its small text budget', () => {
  const f = serviceFixture({ maxText: 16, maxTotalText: 2 }),
    { id } = f.add()
  f.service.set(id, 'text', 'a\0discarded')
  assert.equal(f.service.get(id, 'text'), 'a')
  assert.equal(f.service.textUnits, 1)
  f.service.set(id, 'visible', 1n)
  assert.equal(f.service.admit(f.message(id, 1, 'b\0discarded')).status, 'accepted')
  assert.equal(f.service.get(id, 'text'), 'b')
  f.service.dispose()
})

test('Pad script replacement, stale edit sequence, style refresh and visibility use independent revisions', () => {
  const f = serviceFixture(),
    { id } = f.add()
  f.service.set(id, 'visible', 1n)
  const old = f.message(id, 1, 'old')
  f.service.set(id, 'text', 'script')
  assert.equal(f.service.admit(old).status, 'ignored')
  const edit = f.message(id, 2, 'typed'),
    epoch = f.view(id).textEpoch
  f.service.set(id, 'fontBold', 1n)
  assert.equal(f.view(id).textEpoch, epoch)
  assert.equal(f.service.admit(edit).status, 'accepted')
  assert.equal(f.service.admit({ ...edit, text: 'replayed' }).status, 'ignored')
  const visibleEpoch = f.view(id).epoch,
    late = f.message(id, 3, 'late')
  f.service.set(id, 'visible', 0n)
  assert.equal(f.service.admit(late).status, 'ignored')
  f.service.set(id, 'visible', 1n)
  assert(f.view(id).epoch > visibleEpoch)
  assert.equal(f.view(id).text, 'typed')
  assert.equal(f.service.admit(late).status, 'ignored')
  assert.equal(f.service.admit(f.message(id, 1, 'fresh')).status, 'accepted')
  f.service.dispose()
})

test('Pad readonly and modal blocking reject user edits while script writes and labels remain independent', () => {
  const f = serviceFixture(),
    { id } = f.add()
  f.service.set(id, 'visible', 1n)
  f.service.set(id, 'readOnly', 1n)
  f.service.set(id, 'statusText', 'status')
  assert.equal(f.service.admit(f.message(id, 1, 'user')).status, 'ignored')
  f.service.set(id, 'text', 'script')
  const identity = f.message(id, 1, '')
  assert.equal(
    f.service.admit({ ...identity, kind: 'selection', start: 1, end: 3 }).status,
    'accepted',
  )
  assert.equal(f.service.get(id, 'statusText'), 'status')
  f.service.set(id, 'readOnly', 0n)
  f.block(true)
  const blocked = f.message(id, 2, 'blocked')
  assert.equal(f.service.admit(blocked).status, 'ignored')
  assert.equal(f.service.admit({ ...blocked, kind: 'close' }).status, 'ignored')
  f.service.set(id, 'text', 'changed')
  assert.equal(f.service.get(id, 'text'), 'changed')
  assert.equal(f.view(id).blocked, true)
  f.block(false)
  assert.equal(f.service.admit(f.message(id, 2, 'resumed')).status, 'accepted')
  f.service.dispose()
})

test('Pad malformed selection and geometry are atomic and old identities cannot resurrect a removed Pad', () => {
  const f = serviceFixture(),
    { id } = f.add()
  f.service.set(id, 'visible', 1n)
  f.service.set(id, 'text', 'a\nb')
  const identity = f.message(id, 1, ''),
    before = f.service.presentation()
  assert.throws(
    () => f.service.admit({ ...identity, kind: 'selection', start: 0, end: 4 }),
    /selection/,
  )
  assert.throws(
    () =>
      f.service.admit({
        ...identity,
        kind: 'geometry',
        mode: 'resize',
        left: 0.5,
        top: 0,
        width: 160,
        height: 120,
      }),
    /geometry/,
  )
  assert.deepEqual(f.service.presentation(), before)
  assert.equal(
    f.service.admit({ ...identity, kind: 'selection', start: 0, end: 3 }).status,
    'accepted',
  )
  f.service.remove(id)
  f.service.remove(id)
  assert.equal(f.service.admit({ ...identity, seq: 2, text: 'late' }).status, 'ignored')
  assert.equal(f.service.count, 0)
  assert.equal(f.weak.size, 0)
  f.service.dispose()
})

test('Pad dragging keeps small script dimensions while user resizing alone applies minimum dimensions', () => {
  const f = serviceFixture(),
    { id } = f.add()
  f.service.set(id, 'visible', 1n)
  f.service.set(id, 'width', 60n)
  f.service.set(id, 'height', 90n)
  assert.equal(
    f.service.admit({
      ...f.message(id, 1, ''),
      kind: 'geometry',
      mode: 'move',
      left: 23,
      top: 41,
      width: 538,
      height: 352,
    }).status,
    'accepted',
  )
  assert.deepEqual(
    [f.view(id).left, f.view(id).top, f.view(id).width, f.view(id).height],
    [23, 41, 60, 90],
  )
  assert.equal(
    f.service.admit({
      ...f.message(id, 2, ''),
      kind: 'geometry',
      mode: 'resize',
      left: 23,
      top: 41,
      width: 60,
      height: 90,
    }).status,
    'accepted',
  )
  assert.deepEqual([f.view(id).width, f.view(id).height], [70, 100])
  assert.equal(
    f.service.admit({
      ...f.message(id, 3, ''),
      kind: 'geometry',
      mode: 'restore',
      left: 23,
      top: 41,
      width: 60,
      height: 90,
    }).status,
    'accepted',
  )
  assert.deepEqual([f.view(id).width, f.view(id).height], [60, 90])
  f.service.dispose()
})

test('Pad weak retirement fallback removes state once before a later native invalidation notification', () => {
  const f = serviceFixture(),
    { id } = f.add()
  f.service.set(id, 'text', 'held')
  const observed = [...f.weak.values()]
  assert.equal(observed.length, 1)
  observed[0]!.expired()
  assert.equal(f.service.count, 0)
  assert.equal(f.service.textUnits, 0)
  assert.equal(f.weak.size, 0)
  const count = f.presentations.length
  f.service.remove(id)
  assert.equal(f.presentations.length, count)
  f.service.dispose()
})

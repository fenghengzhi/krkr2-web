import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const definitions = String.raw`
var trace="",tick=0,failCompletion=false,failFinalizer="",caught="";
class TransitionLayer extends Layer {
  function TransitionLayer(window,parent,label){super.Layer(window,parent);name=label;setSize(2,1);}
  function finalize(){
    if(failFinalizer==name)throw new global.Exception("transition-finalizer");
    trace+=name+";";
  }
  function onTransitionCompleted(dest,src){
    trace+="complete:"+dest.name+","+src.name+";";
    if(failCompletion)throw new global.Exception("transition-completion");
  }
  function clock(){return tick;}
}
class TransitionClock {
  function read(){return tick;}
  function finalize(){trace+="clock;";}
}
class BoundTransitionContext {
  function finalize(){trace+="binding;";}
}
var win=new Window();win.visible=true;win.setInnerSize(2,1);
var root=new Layer(win,null);root.setSize(2,1);
var fore=new TransitionLayer(win,root,"fore"),back=new TransitionLayer(win,root,"back");
fore.visible=true;back.visible=false;
`

async function fixture(binary: boolean, body: string) {
  const harness = await headless({
    'startup.tjs': '',
    'transition-lifetime.tjs': definitions + body,
  })
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("transition-lifetime.tjs","savedata/transition-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/transition-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("transition-lifetime.tjs")')
    return {
      ...harness,
      execute: (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      async stop() {
        await session.stop()
        assert.equal(session.snapshot().handles, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: transitions retain both unreferenced Layers and release the clock after completion parameters`, async () => {
    const { session, execute, stop } = await fixture(
      binary,
      String.raw`
var clock=new TransitionClock();
fore.beginTransition("crossfade",true,back,%[time:100,selfupdate:true,callback:clock.read]);
delete global.clock;delete global.fore;delete global.back;
`,
    )
    try {
      assert.equal(await session.evaluate('trace'), '')
      await execute('tick=100;root.update();')
      assert.equal(await session.evaluate('trace'), 'complete:fore,back;back;fore;clock;')
      assert.equal(await session.evaluate('root.children.count'), '0')
    } finally {
      await stop()
    }
  })

  for (const invalidated of ['fore', 'back']) {
    test(`${mode}: invalidating transition ${invalidated} exchanges descendants before detaching and suppresses completion`, async () => {
      const { session, execute, stop } = await fixture(
        binary,
        String.raw`
var oldChild=new Layer(win,fore),newChild=new Layer(win,back);
fore.beginTransition("crossfade",false,back,%[time:100,selfupdate:true]);
`,
      )
      try {
        await execute(`invalidate ${invalidated};`)
        assert.equal(await session.evaluate('trace'), `${invalidated};`)
        assert.equal(
          await session.evaluate(
            invalidated === 'fore'
              ? 'oldChild.parent===back && newChild.parent===null && back.parent===root'
              : 'oldChild.parent===null && newChild.parent===fore && fore.parent===root',
          ),
          '1',
        )
        await execute(`${invalidated === 'fore' ? 'back' : 'fore'}.stopTransition();`)
        assert.equal(await session.evaluate('trace'), `${invalidated};`)
      } finally {
        await stop()
      }
    })
  }

  test(`${mode}: a throwing transition completion still releases source and clock on the VM stack`, async () => {
    const { session, execute, stop } = await fixture(
      binary,
      String.raw`
var clock=new TransitionClock();failCompletion=true;
fore.beginTransition("crossfade",true,back,%[time:100,selfupdate:true,callback:clock.read]);
delete global.clock;delete global.back;
`,
    )
    try {
      await execute('try{fore.stopTransition();}catch(e){caught=e.message;}')
      assert.equal(await session.evaluate('caught'), 'transition-completion')
      assert.equal(await session.evaluate('trace'), 'complete:fore,back;back;clock;')
      await execute('fore.stopTransition();delete global.fore;')
      assert.equal(await session.evaluate('trace'), 'complete:fore,back;back;clock;fore;')
      assert.equal(session.snapshot().state, 'running')
    } finally {
      await stop()
    }
  })

  test(`${mode}: transition clock preserves its source closure until the final release stage`, async () => {
    const { session, execute, stop } = await fixture(
      binary,
      String.raw`
fore.beginTransition("crossfade",true,back,%[time:100,selfupdate:true,callback:back.clock]);
delete global.fore;delete global.back;
`,
    )
    try {
      assert.equal(await session.evaluate('trace'), '')
      await execute('tick=100;root.update();')
      assert.equal(await session.evaluate('trace'), 'complete:fore,back;fore;back;')
    } finally {
      await stop()
    }
  })

  test(`${mode}: a rejected script finalizer leaves transition ownership live until native invalidation retries`, async () => {
    const { session, execute, stop } = await fixture(
      binary,
      String.raw`
var clock=new TransitionClock();
fore.beginTransition("crossfade",true,back,%[time:100,selfupdate:true,callback:clock.read]);
delete global.clock;delete global.back;failFinalizer="fore";
try{invalidate fore;}catch(e){caught=e.message;}
`,
    )
    try {
      assert.equal(
        await session.evaluate('caught+","+(isvalid fore)+","+trace'),
        'transition-finalizer,1,',
      )
      await execute('failFinalizer="";invalidate fore;')
      assert.equal(await session.evaluate('trace'), 'fore;back;clock;')
    } finally {
      await stop()
    }
  })

  test(`${mode}: transition source uses native Layer identity and discards unrelated bound context`, async () => {
    const { session, execute, stop } = await fixture(
      binary,
      String.raw`
var context=new BoundTransitionContext(),bound=back incontextof context;
fore.beginTransition("crossfade",true,bound,%[time:100,selfupdate:true]);
delete global.bound;delete global.context;delete global.back;
`,
    )
    try {
      assert.equal(await session.evaluate('trace'), 'binding;')
      await execute('fore.stopTransition();')
      assert.equal(await session.evaluate('trace'), 'binding;complete:fore,back;back;')
    } finally {
      await stop()
    }
  })
}

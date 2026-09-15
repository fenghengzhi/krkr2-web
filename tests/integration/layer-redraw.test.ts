import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'

function frameClock() {
  let now = 0,
    next = 0
  const tasks = new Map<number, { callback: () => void; at: number }>()
  return {
    now: () => now,
    schedule(callback: () => void, delay: number) {
      const id = ++next
      tasks.set(id, { callback, at: now + delay })
      return () => {
        tasks.delete(id)
      }
    },
    get pending() {
      return tasks.size
    },
    advance(milliseconds: number) {
      now += milliseconds
      for (const [id, task] of [...tasks]) {
        if (task.at > now || !tasks.delete(id)) continue
        task.callback()
      }
    },
  }
}

async function fixture(binary: boolean, body = '', overrides: Partial<SessionDependencies> = {}) {
  const clock = frameClock(),
    harness = await headless(
      {
        'startup.tjs': '',
        'paint-image.bin': new Uint8Array([1]),
        'redraw.tjs': String.raw`
var win=new Window();win.visible=true;win.setInnerSize(8,4);
var root=new Layer(win,null);root.setSize(8,4);root.fillRect(0,0,8,4,0xff202020);
var paints=0;
${body}
`,
      },
      { now: clock.now, schedule: clock.schedule, ...overrides },
    )
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("redraw.tjs","savedata/redraw.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/redraw.cjs")')
    } else await session.evaluate('Scripts.execStorage("redraw.tjs")')
    await session.idle()
    return {
      ...harness,
      clock,
      execute: (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      painted: () => harness.logs.filter((line) => line.startsWith('paint:')),
      async advance(milliseconds = 16) {
        clock.advance(milliseconds)
        await session.idle()
      },
      async stop() {
        await session.stop()
        assert.equal(clock.pending, 0)
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

  test(`${mode}: update coalesces and the default onPaint dispatches through its action owner`, async () => {
    const { session, execute, painted, clock, stop } = await fixture(
      binary,
      String.raw`
win.action=function(event){
  if(event.type!="onPaint")return;
  paints++;
  Debug.message("paint:"+paints+","+int(this===win)+","+int(event.target===root)+","+int(root.callOnPaint));
  root.fillRect(0,0,8,4,0xff123456);
};
root.update();root.update(0,0,1,1);root.update(0,0,1,1,"ignored");
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:1,1,1,0'])
      assert.equal(await session.evaluate('root.getMainPixel(0,0)'), String(0x123456))
      assert.equal(clock.pending, 0)
      await execute('root.update();root.callOnPaint=false;')
      assert.deepEqual(painted(), ['paint:1,1,1,0'])
      await execute('root.update();')
      assert.deepEqual(painted(), ['paint:1,1,1,0', 'paint:2,1,1,0'])
    } finally {
      await stop()
    }
  })

  test(`${mode}: update rejects partial argument lists before marking a paint`, async () => {
    const { session, clock, stop } = await fixture(binary)
    try {
      assert.equal(
        await session.evaluate(String.raw`(function(){
          var rejected=0;
          try{root.update(1);}catch(e){rejected++;}
          try{root.update(1,2);}catch(e){rejected++;}
          try{root.update(1,2,3);}catch(e){rejected++;}
          return rejected+","+int(root.callOnPaint);
        })()`),
        '3,0',
      )
      assert.equal(clock.pending, 0)
    } finally {
      await stop()
    }
  })

  test(`${mode}: update clips display regions without changing the image clip`, async () => {
    const { session, execute, painted, clock, stop } = await fixture(
      binary,
      String.raw`
var child=new Layer(win,root);child.setSize(4,4);child.setPos(6,0);child.visible=true;
child.fillRect(0,0,4,4,0xff000000);child.setClip(0,0,1,1);
child.onPaint=function(){paints++;child.fillRect(0,0,4,4,0xff123456);Debug.message("paint:"+paints);};
`,
    )
    try {
      for (const args of ['0,0,0,4', '0,0,-1,4', '4,0,1,1', '3,0,1,1']) {
        await execute(`child.update(${args});`)
        assert.deepEqual(painted(), [])
        assert.equal(await session.evaluate('int(child.callOnPaint)'), '1')
        assert.equal(clock.pending, 0)
      }
      // Only the overlapping part reaches the primary tree. Its argument is
      // in display coordinates, independent of the drawing clip and bitmap.
      await execute('child.update(-1,0,2,1);')
      assert.deepEqual(painted(), ['paint:1'])
      assert.equal(
        await session.evaluate(
          'child.clipLeft+","+child.clipTop+","+child.clipWidth+","+child.clipHeight+","+child.getMainPixel(0,0)+","+child.getMainPixel(1,0)',
        ),
        '0,0,1,1,1193046,0',
      )
      await execute('child.visible=false;')
      await execute('child.update();')
      assert.deepEqual(painted(), ['paint:1'])
      // A hidden node still participates in the next completion traversal.
      await execute('root.update();')
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
    } finally {
      await stop()
    }
  })

  test(`${mode}: repaint requested by onPaint yields between frames and survives snapshot preparation`, async () => {
    const { painted, clock, advance, session, stop } = await fixture(
      binary,
      String.raw`
var depth=0,maxDepth=0;
root.onPaint=function(){
  depth++;if(depth>maxDepth)maxDepth=depth;
  paints++;Debug.message("paint:"+paints+","+int(root.callOnPaint));
  root.fillRect(0,0,1,1,0xff000000+paints);
  if(paints<3){root.update();root.update();}
  depth--;
};
var snapshot=new Layer(win,root);snapshot.setSize(1,1);
root.update();snapshot.piledCopy(0,0,root,0,0,1,1);
var copiedPixel=snapshot.getMainPixel(0,0);
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:1,0'])
      assert.equal(clock.pending, 1)
      await advance(15)
      assert.deepEqual(painted(), ['paint:1,0'])
      await advance(1)
      assert.deepEqual(painted(), ['paint:1,0', 'paint:2,0'])
      assert.equal(clock.pending, 1)
      await advance()
      assert.deepEqual(painted(), ['paint:1,0', 'paint:2,0', 'paint:3,0'])
      assert.equal(clock.pending, 0)
      assert.equal(
        await session.evaluate('copiedPixel+","+maxDepth+","+int(root.callOnPaint)'),
        '1,1,0',
      )
    } finally {
      await stop()
    }
  })

  test(`${mode}: pending redraw pauses, resumes and remains gated by System.eventDisabled`, async () => {
    const { session, execute, painted, clock, advance, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){paints++;Debug.message("paint:"+paints);if(paints<4)root.update();};
root.update();
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:1'])
      session.pause()
      assert.equal(clock.pending, 0)
      await advance(1000)
      assert.deepEqual(painted(), ['paint:1'])
      session.resume()
      assert.equal(clock.pending, 1)
      await advance()
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      await execute('System.eventDisabled=true;')
      assert.equal(clock.pending, 0)
      await advance(1000)
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      await execute('System.eventDisabled=false;')
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      assert.equal(clock.pending, 1)
      await advance()
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:3'])
      assert.equal(clock.pending, 1)
      await advance()
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:3', 'paint:4'])
      assert.equal(clock.pending, 0)
    } finally {
      await stop()
    }
  })

  test(`${mode}: two explicit update and snapshot completions can paint within one script`, async () => {
    const { session, painted, clock, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){paints++;root.fillRect(0,0,1,1,0xff000000+paints);Debug.message("paint:"+paints);};
var snapshot=new Layer(win,root);snapshot.setSize(2,1);
root.update();snapshot.piledCopy(0,0,root,0,0,1,1);
root.update();snapshot.piledCopy(1,0,root,0,0,1,1);
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      assert.equal(
        await session.evaluate('snapshot.getMainPixel(0,0)+","+snapshot.getMainPixel(1,0)'),
        '1,2',
      )
      assert.equal(clock.pending, 0)
    } finally {
      await stop()
    }
  })

  test(`${mode}: redraw marked while events are disabled is not lost when pixels are presented`, async () => {
    const { execute, painted, clock, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){paints++;Debug.message("paint:"+paints);};
System.eventDisabled=true;root.update();
`,
    )
    try {
      assert.deepEqual(painted(), [])
      assert.equal(clock.pending, 0)
      await execute('System.eventDisabled=false;')
      assert.deepEqual(painted(), ['paint:1'])
      assert.equal(clock.pending, 0)
    } finally {
      await stop()
    }
  })

  test(`${mode}: a pending repaint does not own the Layer and stop cancels its host timer`, async () => {
    const { session, execute, painted, clock, advance, stop } = await fixture(
      binary,
      String.raw`
class PaintedLayer extends Layer {
  function PaintedLayer(window,parent){super.Layer(window,parent);visible=true;}
  function finalize(){Debug.message("paint:finalized");}
  function onPaint(){Debug.message("paint:child");update();}
}
var child=new PaintedLayer(win,root);child.update();
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:child'])
      assert.equal(clock.pending, 1)
      await execute('delete global.child;')
      assert.deepEqual(painted(), ['paint:child', 'paint:finalized'])
      assert.equal(session.snapshot().layers, 1)
      assert.equal(clock.pending, 0)
      await advance()
      assert.deepEqual(painted(), ['paint:child', 'paint:finalized'])
      await execute(
        'root.onPaint=function(){Debug.message("paint:root");root.update();};root.update();',
      )
      assert.equal(clock.pending, 1)
    } finally {
      await stop()
    }
  })

  test(`${mode}: default onPaint can invalidate its target without leaving redraw work`, async () => {
    const { session, painted, clock, stop } = await fixture(
      binary,
      String.raw`
win.action=function(event){
  if(event.type!="onPaint")return;
  event.target.update();invalidate event.target;
  Debug.message("paint:invalidated");
};
root.update();
`,
    )
    try {
      assert.deepEqual(painted(), ['paint:invalidated'])
      assert.equal(session.snapshot().layers, 0)
      assert.equal(clock.pending, 0)
      assert.equal(await session.evaluate('isvalid root'), '0')
    } finally {
      await stop()
    }
  })

  test(`${mode}: an asynchronous paint resumes once, and its failure cancels deferred redraw`, async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const { session, execute, painted, clock, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){
  paints++;Debug.message("paint:entered");root.update();
  root.loadImages("paint-image.bin");
  Debug.message("paint:resumed");throw new global.Exception("paint-failure");
};
`,
      {
        graphics: {
          async decode() {
            enter()
            await gate
            return { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) }
          },
          text() {
            throw new Error('Unexpected text drawing')
          },
        },
      },
    )
    try {
      // The mounted unknown-format image makes the actual graphics host suspend.
      const operation = execute('root.update();')
      const rejected = assert.rejects(operation, /paint-failure/)
      await Promise.race([entered, operation])
      assert.deepEqual(painted(), ['paint:entered'])
      assert.equal(clock.pending, 0)
      release()
      await rejected
      assert.deepEqual(painted(), ['paint:entered', 'paint:resumed'])
      assert.equal(clock.pending, 0)
      assert.equal(session.snapshot().state, 'failed')
    } finally {
      release()
      await stop()
    }
  })

  test(`${mode}: an explicit paint that suspends replaces an earlier delayed frame without a stale wake`, async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const { execute, painted, clock, advance, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){
  paints++;Debug.message("paint:"+paints);
  if(paints<3)root.update();
  if(paints==2){root.loadImages("paint-image.bin");Debug.message("paint:resumed");}
};
root.update();
`,
      {
        graphics: {
          async decode() {
            enter()
            await gate
            return { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) }
          },
          text() {
            throw new Error('Unexpected text drawing')
          },
        },
      },
    )
    try {
      assert.deepEqual(painted(), ['paint:1'])
      assert.equal(clock.pending, 1)
      const operation = execute('root.update();')
      await Promise.race([entered, operation])
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      assert.equal(clock.pending, 0)
      // Advance only the clock while the VM is intentionally suspended.
      clock.advance(16)
      release()
      await operation
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:resumed'])
      assert.equal(clock.pending, 1)
      await advance(15)
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:resumed'])
      await advance(1)
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:resumed', 'paint:3'])
      assert.equal(clock.pending, 0)
    } finally {
      release()
      await stop()
    }
  })

  test(`${mode}: a queued redraw rechecks background visibility after an unrelated suspended call`, async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const { session, execute, painted, clock, advance, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){paints++;Debug.message("paint:"+paints);if(paints<2)root.update();};
root.update();
`,
      {
        graphics: {
          async decode() {
            enter()
            await gate
            return { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) }
          },
          text() {
            throw new Error('Unexpected text drawing')
          },
        },
      },
    )
    try {
      assert.deepEqual(painted(), ['paint:1'])
      const operation = execute('root.loadImages("paint-image.bin");')
      await Promise.race([entered, operation])
      clock.advance(16)
      session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      release()
      await operation
      await session.idle()
      assert.equal(session.snapshot().state, 'running')
      assert.deepEqual(painted(), ['paint:1'])
      assert.equal(clock.pending, 0)
      session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      assert.equal(clock.pending, 1)
      await advance()
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      assert.equal(clock.pending, 0)
    } finally {
      release()
      await stop()
    }
  })

  test(`${mode}: an old queued wake cannot unlock a newer request from the same Layer`, async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const { session, execute, painted, clock, advance, stop } = await fixture(
      binary,
      String.raw`
root.onPaint=function(){paints++;Debug.message("paint:"+paints);if(paints<3)root.update();};
root.update();
`,
      {
        graphics: {
          async decode() {
            enter()
            await gate
            return { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) }
          },
          text() {
            throw new Error('Unexpected text drawing')
          },
        },
      },
    )
    try {
      assert.deepEqual(painted(), ['paint:1'])
      const operation = execute('root.loadImages("paint-image.bin");root.update();')
      await Promise.race([entered, operation])
      // The first generation's wake waits behind the suspended script. Its
      // explicit update then consumes that request and paint:2 creates a new one.
      clock.advance(16)
      release()
      await operation
      await session.idle()
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      assert.equal(clock.pending, 1)
      await advance(15)
      assert.deepEqual(painted(), ['paint:1', 'paint:2'])
      await advance(1)
      assert.deepEqual(painted(), ['paint:1', 'paint:2', 'paint:3'])
      assert.equal(clock.pending, 0)
    } finally {
      release()
      await stop()
    }
  })
}

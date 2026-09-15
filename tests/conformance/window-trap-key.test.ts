import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function gate() {
  let enter!: () => void, release!: (source: string) => void
  const entered = new Promise<void>((resolve) => {
      enter = resolve
    }),
    result = new Promise<string>((resolve) => {
      release = resolve
    })
  return { enter, entered, result, release: (source = '0;') => release(source) }
}

async function gateEntry(entered: Promise<void>, producer: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      producer.then(() => {
        throw new Error('The input or script completed without entering its gate')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The trap fixture never entered its gate')),
          10000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const scene = String.raw`
System.exitOnWindowClose=false;
var trace=[];
class TrapWindow extends Window {
  var label;
  function TrapWindow(label){super.Window();this.label=label;caption=label;setInnerSize(32,32);visible=true;}
  function onKeyDown(key,shift){trace.add(label+":W:down:"+key);}
  function onKeyUp(key,shift){trace.add(label+":W:up:"+key);}
  function onKeyPress(key){trace.add(label+":W:text:"+key);}
  function onMouseDown(x,y,button,shift){trace.add(label+":W:mouse");}
  function onMouseWheel(shift,delta,x,y){trace.add(label+":W:wheel");}
  function onTouchDown(x,y,cx,cy,id){trace.add(label+":W:touch");}
}
class TrapLayer extends Layer {
  var label;
  function TrapLayer(win,parent,label){
    super.Layer(win,parent);this.label=label;setSize(32,32);
    visible=true;focusable=true;fillRect(0,0,32,32,0xffffffff);
  }
  function onKeyDown(key,shift,process){trace.add(label+":L:down:"+key);}
  function onKeyUp(key,shift,process){trace.add(label+":L:up:"+key);}
  function onKeyPress(key,process){trace.add(label+":L:text:"+key);}
  function onMouseDown(x,y,button,shift){trace.add(label+":L:mouse");}
  function onMouseWheel(shift,delta,x,y){trace.add(label+":L:wheel");}
  function onTouchDown(x,y,cx,cy,id){trace.add(label+":L:touch");}
}
var a=new TrapWindow("A"),ar=new TrapLayer(a,null,"A");ar.focus();
var b=new TrapWindow("B"),br=new TrapLayer(b,null,"B");br.focus();
var c=null,cr=null;
function newest(){c=new TrapWindow("C");cr=new TrapLayer(c,null,"C");cr.focus();c.trapKey=true;}
`

async function fixture(binary: boolean, setup = '') {
  const blocked = gate()
  let rendererCloses = 0
  const f = await headless(
    {
      'startup.tjs': '',
      'trap-key.tjs': scene + setup,
      'trap-gate.tjs': 'trap-key:gate',
    },
    {
      decodeScript(bytes, mode, encoding) {
        if (new TextDecoder().decode(bytes) === 'trap-key:gate') {
          blocked.enter()
          return blocked.result
        }
        return readScript(bytes, mode, encoding)
      },
      renderer: {
        present() {},
        dispose() {
          rendererCloses++
        },
      },
    },
  )
  const execute = (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate(
        'Scripts.compileStorage("trap-key.tjs","savedata/trap-key.cjs",false,true,false)',
      )
      await f.session.evaluate('Scripts.execStorage("savedata/trap-key.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("trap-key.tjs")')
    await f.session.idle()
    const a = Number(await f.session.evaluate('a.__windowId')),
      b = Number(await f.session.evaluate('b.__windowId'))
    await f.session.activateWindow(a)
    await execute('trace.clear();')
    return {
      ...f,
      a,
      b,
      blocked,
      execute,
      trace: () => f.session.evaluate('trace.join("|")'),
      route(windowId: number) {
        for (let index = f.events.length - 1; index >= 0; index--) {
          const event = f.events[index]!
          if (event.type !== 'window-input' || event.windowId !== windowId) continue
          assert.ok(event.input.keyboardRoute, 'The Window must publish its keyboard route')
          return event.input.keyboardRoute
        }
        throw new Error(`No input view for Window ${windowId}`)
      },
      async stop() {
        const stopping = f.session.stop()
        blocked.release()
        await stopping
        assert.equal(f.session.snapshot().state, 'stopped')
        assert.equal(f.session.snapshot().handles, 0)
        assert.ok(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
        assert.equal(rendererCloses, 1)
      },
    }
  } catch (error) {
    blocked.release()
    await f.session.stop()
    throw error
  }
}

// Node uses the existing real Asyncify kernel. The same source/bytecode
// distinction is exercised with browser Asyncify/JSPI in the browser suite.
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: trapKey chooses the latest created visible Window without changing activation or requiring focusable`, async () => {
    const f = await fixture(binary, 'b.focusable=false;b.trapKey=true;a.trapKey=true;')
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|B:L:down:65')
      assert.equal(f.session.snapshot().activeWindow, f.a)
      assert.equal(await f.session.evaluate('a.focusedLayer===ar&&b.focusedLayer===br'), '1')
      await f.execute('newest();a.trapKey=true;b.trapKey=true;trace.clear();')
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'C:W:down:66|C:L:down:66')
      await f.execute('c.visible=false;trace.clear();')
      await f.session.input({ type: 'keyDown', key: 67, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:67|B:L:down:67')
      await f.execute('c.visible=true;invalidate c;trace.clear();')
      await f.session.input({ type: 'keyDown', key: 68, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:68|B:L:down:68')
      assert.equal(f.session.snapshot().activeWindow, f.a)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a source Window trapping its own keys swallows initial text and only its first ordinary keyUp`, async () => {
    const f = await fixture(binary, 'a.trapKey=true;')
    try {
      await f.session.input({ type: 'text', text: '初', windowId: f.a })
      await f.session.input({ type: 'text', text: '次', windowId: f.a })
      assert.equal(await f.trace(), '')
      await f.session.input({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), '')
      await f.session.input({ type: 'keyUp', key: 66, shift: 0, windowId: f.a })
      await f.session.input({ type: 'text', text: '字', windowId: f.a })
      assert.equal(await f.trace(), 'A:W:up:66|A:L:up:66|A:W:text:字|A:L:text:字')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: each true assignment resets trap reception while hide/show preserves its armed state`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      await f.execute('b.trapKey=true;trace.clear();')
      await f.session.input({ type: 'text', text: '旧', windowId: f.a })
      await f.session.input({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), '')
      await f.execute('b.visible=false;')
      await f.session.input({ type: 'text', text: '源', windowId: f.a })
      await f.execute('b.visible=true;')
      await f.session.input({ type: 'text', text: '返', windowId: f.a })
      assert.equal(await f.trace(), 'A:W:text:源|A:L:text:源|B:W:text:返|B:L:text:返')
      await f.execute('b.trapKey=false;b.trapKey=true;trace.clear();')
      await f.session.input({ type: 'text', text: '未', windowId: f.a })
      assert.equal(await f.trace(), '')
      await f.session.input({ type: 'keyDown', key: 67, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:67|B:L:down:67')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: ordinary keyDown arms and delivers immediately, while an explicit system key does not arm`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      await f.session.input({ type: 'keyDown', key: 121, shift: 0, systemKey: true, windowId: f.a })
      await f.session.input({ type: 'keyUp', key: 121, shift: 0, systemKey: true, windowId: f.a })
      await f.session.input({ type: 'text', text: '未', windowId: f.a })
      assert.equal(await f.trace(), '')
      // With no systemKey flag, Node admission is explicitly ordinary even
      // for F10. Mapping DOM Alt/F10 to Windows system keys belongs to Web.
      await f.session.input({ type: 'keyDown', key: 121, shift: 0, windowId: f.a })
      await f.session.input({ type: 'keyUp', key: 121, shift: 0, systemKey: true, windowId: f.a })
      await f.session.input({ type: 'text', text: '可', windowId: f.a })
      assert.equal(
        await f.trace(),
        'B:W:down:121|B:L:down:121|B:W:up:121|B:L:up:121|B:W:text:可|B:L:text:可',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: swallowed keyUp still releases shared physical keys and modifiers without changing activation`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 1, windowId: f.a })
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(16)'),
        '1,1',
      )
      await f.execute('b.trapKey=true;trace.clear();')
      await f.session.input({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), '')
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(16)'),
        '0,0',
      )
      // The gate is one boolean per trapper, not a down/up pairing for each key.
      await f.session.input({ type: 'keyUp', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:up:66|B:L:up:66')
      assert.equal(f.session.snapshot().activeWindow, f.a)
      f.session.keyState([65, 17])
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(17)'),
        '0,0',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: all three postInputEvent key methods stay on their explicit Window and cannot arm trap reception`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;function posted(){
        a.postInputEvent("onKeyDown",%[key:65]);
        a.postInputEvent("onKeyUp",%[key:65]);
        a.postInputEvent("onKeyPress",%[key:"直"]);
        b.postInputEvent("onKeyDown",%[key:66]);
        b.postInputEvent("onKeyUp",%[key:66]);
        b.postInputEvent("onKeyPress",%[key:"指"]);
      }`,
    )
    try {
      await f.session.evaluate('posted()')
      await f.session.idle()
      assert.equal(
        await f.trace(),
        'A:W:down:65|A:L:down:65|A:W:up:65|A:L:up:65|A:W:text:直|A:L:text:直|' +
          'B:W:down:66|B:L:down:66|B:W:up:66|B:L:up:66|' +
          'B:W:text:指|B:L:text:指',
      )
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(66)'),
        '0,0',
      )
      await f.execute('trace.clear();')
      await f.session.input({ type: 'text', text: '未', windowId: f.a })
      await f.session.input({ type: 'keyUp', key: 67, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), '')
      await f.session.input({ type: 'text', text: '実', windowId: f.a })
      assert.equal(await f.trace(), 'B:W:text:実|B:L:text:実')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an old keyboard route releases physical keys but cannot arm the reset or replacement trapper`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      const old = f.route(f.a)
      assert.equal(old.windowId, f.b)
      await f.execute('b.trapKey=true;')
      const reset = f.route(f.a)
      assert.notEqual(
        reset.revision,
        old.revision,
        'Assigning true retires the previous keyboard route',
      )
      f.session.keyState([65])
      const stale = f.session.acceptInput({
        type: 'keyUp',
        key: 65,
        shift: 0,
        windowId: f.a,
        keyboardRouteRevision: old.revision,
      })
      assert.equal(stale.status, 'ignored')
      await stale.completion
      assert.equal(await f.session.evaluate('System.getKeyState(65)'), '0')
      await f.session.input({
        type: 'text',
        text: '未',
        windowId: f.a,
        keyboardRouteRevision: reset.revision,
      })
      assert.equal(await f.trace(), '', 'A stale keyUp must not arm the reset gate')
      await f.execute('newest();')
      const replacement = f.route(f.a)
      assert.notEqual(replacement.windowId, f.b)
      assert.notEqual(replacement.revision, reset.revision)
      const previousReceiver = f.session.acceptInput({
        type: 'keyDown',
        key: 66,
        shift: 0,
        windowId: f.a,
        keyboardRouteRevision: reset.revision,
      })
      assert.equal(previousReceiver.status, 'ignored')
      await previousReceiver.completion
      await f.session.input({
        type: 'text',
        text: '未',
        windowId: f.a,
        keyboardRouteRevision: replacement.revision,
      })
      assert.equal(await f.trace(), '', 'A stale keyDown must not arm the new receiver')
      await f.session.input({
        type: 'keyDown',
        key: 67,
        shift: 0,
        windowId: f.a,
        keyboardRouteRevision: replacement.revision,
      })
      assert.equal(await f.trace(), 'C:W:down:67|C:L:down:67')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: changing the physical source focus away and back retires its old text route while the trapper stays unchanged`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;var alternate=new TrapLayer(a,ar,"alternate");')
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      const previous = f.route(f.a)
      await f.execute('trace.clear();alternate.focus();ar.focus();')
      const current = f.route(f.a)
      assert.equal(await f.session.evaluate('a.focusedLayer===ar&&b.focusedLayer===br'), '1')
      assert.equal(previous.windowId, f.b)
      assert.equal(current.windowId, previous.windowId)
      assert.equal(current.focused, previous.focused)
      assert.notEqual(
        current.revision,
        previous.revision,
        'Source focus round trips cancel the old route',
      )
      const stale = f.session.acceptInput({
        type: 'text',
        text: '旧',
        windowId: f.a,
        keyboardRouteRevision: previous.revision,
      })
      assert.equal(stale.status, 'ignored')
      await stale.completion
      assert.equal(await f.trace(), '')
      await f.session.input({
        type: 'text',
        text: '新',
        windowId: f.a,
        keyboardRouteRevision: current.revision,
      })
      assert.equal(await f.trace(), 'B:W:text:新|B:L:text:新')
      assert.equal(f.session.snapshot().activeWindow, f.a)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a hidden physical source cannot deliver keys or arm a visible trapper but still releases its physical key`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      await f.execute('a.visible=false;')
      f.session.keyState([65, 16])
      const hidden = f.session.acceptInput({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      assert.equal(hidden.status, 'ignored')
      await hidden.completion
      await f.session.input({ type: 'text', text: '隠', windowId: f.a })
      assert.equal(await f.trace(), '')
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(16)'),
        '0,0',
      )
      await f.execute('a.visible=true;')
      await f.session.input({ type: 'text', text: '未', windowId: f.a })
      assert.equal(await f.trace(), '', 'The hidden-source keyUp cannot arm the trapper')
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:66|B:L:down:66')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: trapKey leaves pointer, wheel and touch routing on the input source`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    try {
      await f.session.input({
        type: 'down',
        x: 2,
        y: 2,
        shift: 8,
        button: 0,
        clicks: 0,
        windowId: f.a,
      })
      await f.session.input({
        type: 'up',
        x: 2,
        y: 2,
        shift: 0,
        button: 0,
        clicks: 0,
        windowId: f.a,
      })
      await f.session.input({ type: 'wheel', x: 2, y: 2, shift: 0, delta: 120, windowId: f.a })
      await f.session.input({
        type: 'touchDown',
        x: 2,
        y: 2,
        width: 1,
        height: 1,
        id: 1,
        windowId: f.a,
      })
      await f.session.input({
        type: 'touchUp',
        x: 2,
        y: 2,
        width: 1,
        height: 1,
        id: 1,
        windowId: f.a,
      })
      assert.equal(await f.trace(), 'A:W:mouse|A:L:mouse|A:W:wheel|A:L:wheel|A:W:touch|A:L:touch')
      await f.execute('trace.clear();')
      await f.session.input({ type: 'text', text: '未', windowId: f.a })
      assert.equal(await f.trace(), '', 'Non-key input cannot arm the trapper')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: trapped Window callback precedes Layer delivery and can choose another focused Layer`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;var next=new TrapLayer(b,br,"next");
       b.onKeyDown=function(key,shift){trace.add("B:W:before");next.focus();trace.add("B:W:after");};`,
    )
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:before|B:W:after|next:L:down:65')
      assert.equal(await f.session.evaluate('b.focusedLayer===next&&a.focusedLayer===ar'), '1')
      assert.equal(f.session.snapshot().activeWindow, f.a)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: changing trap ownership inside the Window callback keeps its current Layer dispatch on that Window`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;b.onKeyDown=function(key,shift){trace.add("B:W:down:"+key);b.trapKey=false;newest();};`,
    )
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|B:L:down:65')
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|B:L:down:65|C:W:down:66|C:L:down:66')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: invalidating a trapped Window inside its callback suppresses the old Layer tail`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;b.onKeyDown=function(key,shift){trace.add("B:W:retire");invalidate b;newest();};`,
    )
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:retire')
      assert.equal(await f.session.evaluate('(isvalid br)+","+(br.window===null)'), '1,1')
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:retire|C:W:down:66|C:L:down:66')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: retiring the physical source inside a trapped text callback suppresses its Layer and remaining characters`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;b.onKeyPress=function(key){trace.add("B:W:text:"+key);invalidate a;};`,
    )
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      await f.execute('trace.clear();')
      await f.session.input({ type: 'text', text: 'ab', windowId: f.a })
      assert.equal(await f.trace(), 'B:W:text:a')
      assert.equal(await f.session.evaluate('(isvalid b)+","+(b.focusedLayer===br)'), '1,1')
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a handled exception in the trapped Window callback does not invoke its Layer or poison the next key`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;var fail=true;
       b.onKeyDown=function(key,shift){trace.add("B:W:down:"+key);if(fail){fail=false;throw new Exception("trap-window-error");}};
       System.exceptionHandler=function(error){trace.add("caught:"+error.message);return true;};`,
    )
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|caught:trap-window-error')
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|caught:trap-window-error|B:W:down:66|B:L:down:66')
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an accepted trapped key keeps its queued target when another trapper is created before delivery`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    const pending: Promise<unknown>[] = []
    try {
      const reading = f.session.evaluate('Scripts.execStorage("trap-gate.tjs")')
      pending.push(reading)
      await gateEntry(f.blocked.entered, reading)
      const admitted = f.session.acceptInput({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      pending.push(admitted.completion)
      assert.equal(admitted.status, 'accepted')
      f.blocked.release('newest();b.trapKey=false;')
      await Promise.all(pending)
      assert.equal(await f.trace(), 'B:W:down:65|B:L:down:65')
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:65|B:L:down:65|C:W:down:66|C:L:down:66')
      assert.equal(f.session.inspectOwnership().eventReceipts, 0)
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
    } finally {
      await f.stop()
      await Promise.allSettled(pending)
    }
  })

  for (const retiring of ['source', 'receiver'] as const)
    test(`${mode}: retiring the ${retiring} cancels an accepted trapped key instead of rebinding a new Window`, async () => {
      const f = await fixture(binary, 'b.trapKey=true;')
      const pending: Promise<unknown>[] = []
      try {
        const reading = f.session.evaluate('Scripts.execStorage("trap-gate.tjs")')
        pending.push(reading)
        await gateEntry(f.blocked.entered, reading)
        const admitted = f.session.acceptInput({
          type: 'keyDown',
          key: 65,
          shift: 0,
          windowId: f.a,
        })
        pending.push(admitted.completion)
        assert.equal(admitted.status, 'accepted')
        f.blocked.release(`invalidate ${retiring === 'source' ? 'a' : 'b'};newest();`)
        await Promise.all(pending)
        assert.equal(await f.trace(), '')
        assert.equal(f.session.inspectOwnership().pendingHandles, 0)
        const source = retiring === 'source' ? f.b : f.a
        await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: source })
        assert.equal(await f.trace(), 'C:W:down:66|C:L:down:66')
      } finally {
        await f.stop()
        await Promise.allSettled(pending)
      }
    })

  test(`${mode}: hiding the physical source after admission cancels the queued trapped key without undoing physical release`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    const pending: Promise<unknown>[] = []
    try {
      await f.session.input({ type: 'keyDown', key: 65, shift: 1, windowId: f.a })
      await f.execute('trace.clear();')
      const reading = f.session.evaluate('Scripts.execStorage("trap-gate.tjs")')
      pending.push(reading)
      await gateEntry(f.blocked.entered, reading)
      const admitted = f.session.acceptInput({ type: 'keyUp', key: 65, shift: 0, windowId: f.a })
      pending.push(admitted.completion)
      assert.equal(admitted.status, 'accepted')
      f.blocked.release('a.visible=false;')
      await Promise.all(pending)
      assert.equal(await f.trace(), '')
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(16)'),
        '0,0',
      )
      assert.equal(f.session.inspectOwnership().eventReceipts, 0)
      await f.execute('a.visible=true;')
      await f.session.input({ type: 'text', text: '返', windowId: f.a })
      assert.equal(await f.trace(), 'B:W:text:返|B:L:text:返')
    } finally {
      await f.stop()
      await Promise.allSettled(pending)
    }
  })

  test(`${mode}: backgrounding cancels the old source epoch while a queued trapped key is waiting`, async () => {
    const f = await fixture(binary, 'b.trapKey=true;')
    const pending: Promise<unknown>[] = []
    try {
      const reading = f.session.evaluate('Scripts.execStorage("trap-gate.tjs")')
      pending.push(reading)
      await gateEntry(f.blocked.entered, reading)
      const admitted = f.session.acceptInput({ type: 'keyDown', key: 65, shift: 1, windowId: f.a })
      pending.push(admitted.completion)
      assert.equal(admitted.status, 'accepted')
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      f.blocked.release()
      await Promise.all(pending)
      assert.equal(await f.trace(), '')
      assert.equal(
        await f.session.evaluate('System.getKeyState(65)+","+System.getKeyState(16)'),
        '0,0',
      )
      await f.session.activateWindow(f.a)
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.trace(), 'B:W:down:66|B:L:down:66')
    } finally {
      await f.stop()
      await Promise.allSettled(pending)
    }
  })

  test(`${mode}: Stop cancels a suspended trapped callback and its queued successor before any script or Layer tail`, async () => {
    const f = await fixture(
      binary,
      `b.trapKey=true;b.onKeyDown=function(key,shift){
         Debug.message("trap-enter:"+key);Scripts.execStorage("trap-gate.tjs");Debug.message("trap-tail:"+key);
       };br.onKeyDown=function(key,shift,process){Debug.message("layer-tail:"+key);};`,
    )
    const pending: Promise<unknown>[] = []
    try {
      const first = f.session.acceptInput({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      pending.push(first.completion)
      assert.equal(first.status, 'accepted')
      await gateEntry(f.blocked.entered, first.completion)
      const second = f.session.acceptInput({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      pending.push(second.completion)
      assert.equal(second.status, 'accepted')
      const rejected = pending.map((promise) => assert.rejects(promise, /Execution cancelled/))
      await f.stop()
      await Promise.all(rejected)
      assert.deepEqual(f.logs, ['trap-enter:65'])
      const late = f.session.acceptInput({ type: 'keyDown', key: 67, shift: 0, windowId: f.a })
      assert.equal(late.status, 'ignored')
      await late.completion
      assert.deepEqual(f.logs, ['trap-enter:65'])
    } finally {
      await f.stop()
      await Promise.allSettled(pending)
    }
  })
}

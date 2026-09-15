import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

// No exit policy override here: default termination tests use this same fixture.
// Close operations live in the compiled definitions in the bytecode variants.
const definitions = String.raw`
var trace=[],aDeaths=0,bDeaths=0,managedDeaths=0;
class MultiWindow extends Window {
  var name,allow=true,queries=0,queryMode="",failFinalizer=false,keyCalls=0;
  function MultiWindow(name){super.Window();this.name=name;caption=name;visible=true;}
  function onCloseQuery(canClose){
    queries++;trace.add(name+":query");
    if(queryMode=="invalidate"){invalidate this;return;}
    if(queryMode=="nested"){queryMode="";this.close();return;}
    if(queryMode=="defer")return;
    super.onCloseQuery(allow);
  }
  function answerClose(canClose){super.onCloseQuery(canClose);}
  function finalize(){
    if(failFinalizer)throw new Exception("multiwindow-finalizer");
    if(name=="A")aDeaths++;if(name=="B")bDeaths++;
    Debug.message("finalized:"+name);
  }
  function onKeyDown(key,shift){keyCalls++;}
}
class MultiManaged {
  function finalize(){managedDeaths++;Debug.message("managed-closed");}
}
var a=new MultiWindow("A"),b=new MultiWindow("B");
function closeMain(){a.close();Debug.message("after-main-close:"+int(isvalid b));}
function invalidateMain(){invalidate a;Debug.message("after-main-close:"+int(isvalid b));}
function dropMain(){delete global.a;Debug.message("after-main-close:"+int(isvalid b));}
function closeSecondary(){b.close();}
function tryMainFinalizer(){try{a.close();}catch(error){return error.message;}return "unexpected";}
`

async function fixture(binary: boolean, overrides: Partial<SessionDependencies> = {}) {
  const harness = await headless(
    {
      'startup.tjs': '',
      'multiwindow.tjs': definitions,
      'gate.tjs': 'multiwindow-lifecycle-gate',
    },
    overrides,
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("multiwindow.tjs","savedata/multiwindow.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/multiwindow.cjs")')
    } else await session.evaluate('Scripts.execStorage("multiwindow.tjs")')
    await session.idle()
    return {
      ...harness,
      execute,
      a: Number(await session.evaluate('a.__windowId')),
      b: Number(await session.evaluate('b.__windowId')),
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: main identity is independent of activation, visibility, and construction of additional Windows`, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.session.evaluate('System.exitOnWindowClose'), '1')
      assert.notEqual(f.a, f.b)
      assert.equal(
        await f.session.evaluate(
          '(Window.mainWindow===a)+","+(MultiWindow.mainWindow===a)+","+(b.mainWindow===a)',
        ),
        '1,1,1',
      )
      await f.session.activateWindow(f.b)
      assert.equal(f.session.snapshot().activeWindow, f.b)
      assert.equal(f.session.snapshot().mainWindow, f.a)
      await f.execute('a.visible=false;var c=new MultiWindow("C");')
      assert.equal(await f.session.evaluate('(Window.mainWindow===a)+","+a.visible'), '1,0')
      assert.equal(f.session.snapshot().windows?.length, 3)
      assert.equal(f.session.inspectOwnership().windowSources, 3)
    } finally {
      await f.session.stop()
      assert.equal(f.session.snapshot().handles, 0)
    }
  })

  for (const close of ['script', 'invalidate', 'collection', 'user'] as const) {
    test(`${mode}: default main ${close} closure requests Session termination after native cleanup`, async () => {
      const f = await fixture(binary)
      try {
        assert.equal(await f.session.evaluate('System.exitOnWindowClose'), '1')
        // A managed object also proves normal native cleanup completes before
        // automatic Session shutdown disposes the VM without running script.
        if (close !== 'collection') await f.execute('a.add(new MultiManaged());')
        if (close === 'user') await f.session.closeWindow(f.a)
        else
          await f.session.evaluate(
            `${close === 'script' ? 'closeMain' : close === 'invalidate' ? 'invalidateMain' : 'dropMain'}()`,
          )
        assert.ok(
          ['stopping', 'stopped'].includes(f.session.snapshot().state),
          'Closing the main Window must itself request termination',
        )
        assert.ok(f.logs.includes('finalized:A'))
        if (close !== 'collection') assert.ok(f.logs.includes('managed-closed'))
        if (close !== 'user')
          assert.ok(
            f.logs.includes('after-main-close:1'),
            'Main closure must not cancel the remainder of the current VM operation',
          )
        await f.session.stop()
        assert.equal(f.session.snapshot().state, 'stopped')
        assert.equal(f.session.snapshot().handles, 0)
        assert.ok(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
        assert.ok(!f.logs.some((message) => message.includes('Execution cancelled')))
      } finally {
        await f.session.stop()
      }
    })
  }

  test(`${mode}: exitOnWindowClose=false preserves surviving Windows without promoting a new main`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('System.exitOnWindowClose=false;')
      assert.equal(await f.session.evaluate('System.exitOnWindowClose'), '0')
      await f.session.evaluate('closeMain()')
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.session.snapshot().mainWindow, 0)
      assert.equal(await f.session.evaluate('(Window.mainWindow===null)+","+(isvalid b)'), '1,1')
      await f.session.input({ type: 'keyDown', key: 65, shift: 0, windowId: f.b })
      assert.equal(await f.session.evaluate('b.keyCalls'), '1')
      await f.execute('var c=new MultiWindow("C");')
      assert.equal(await f.session.evaluate('Window.mainWindow===null'), '1')
      // Even changing the policy back to true cannot promote an existing
      // secondary Window or make its later invalidation terminate the Session.
      await f.execute('System.exitOnWindowClose=true;invalidate b;invalidate c;')
      assert.equal(f.session.snapshot().state, 'running')
      assert.deepEqual(f.session.snapshot().windows, [])
      await f.execute('var next=new MultiWindow("next");')
      assert.equal(await f.session.evaluate('Window.mainWindow===next'), '1')
      assert.equal(
        f.session.snapshot().mainWindow,
        Number(await f.session.evaluate('next.__windowId')),
      )
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: script close invalidates a secondary Window without terminating the main Window`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('b.add(new MultiManaged());')
      await f.session.evaluate('closeSecondary()')
      assert.equal(
        await f.session.evaluate(
          '(isvalid a)+","+(isvalid b)+","+(Window.mainWindow===a)+","+bDeaths+","+managedDeaths',
        ),
        '1,0,1,1,1',
      )
      assert.equal(f.session.snapshot().state, 'running')
      assert.deepEqual(
        f.session.snapshot().windows?.map((window) => window.id),
        [f.a],
      )
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
      assert.equal(await f.session.evaluate('a.keyCalls'), '1')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: user close hides a secondary Window and preserves its managed objects for reopening`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('var managed=new MultiManaged();b.add(managed);')
      await f.session.closeWindow(f.b)
      assert.equal(
        await f.session.evaluate(
          '(isvalid b)+","+b.visible+","+b.queries+","+(isvalid managed)+","+bDeaths+","+managedDeaths',
        ),
        '1,0,1,1,0,0',
      )
      assert.equal(f.session.snapshot().windows?.length, 2)
      await f.execute('b.visible=true;')
      assert.equal(await f.session.evaluate('b.__windowId'), String(f.b))
      await f.session.input({ type: 'keyDown', key: 66, shift: 0, windowId: f.b })
      assert.equal(await f.session.evaluate('b.keyCalls'), '1')
      await f.session.evaluate('closeSecondary()')
      assert.equal(
        await f.session.evaluate('(isvalid managed)+","+bDeaths+","+managedDeaths'),
        '0,1,1',
      )
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: close queries can deny both script and user close independently in each Window`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('a.allow=false;b.allow=false;')
      await f.session.evaluate('closeMain()')
      await f.session.evaluate('closeSecondary()')
      await f.session.closeWindow(f.a)
      await f.session.closeWindow(f.b)
      assert.equal(
        await f.session.evaluate(
          'a.queries+","+b.queries+","+(isvalid a)+","+(isvalid b)+","+a.visible+","+b.visible+","+aDeaths+","+bDeaths',
        ),
        '2,2,1,1,1,1,0,0',
      )
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.session.snapshot().mainWindow, f.a)
      await f.execute('b.allow=true;')
      await f.session.closeWindow(f.b)
      assert.equal(await f.session.evaluate('a.visible+","+b.visible+","+b.queries'), '1,0,3')
    } finally {
      await f.session.stop()
    }
  })

  for (const close of ['script', 'user'] as const) {
    for (const queryMode of ['invalidate', 'nested'] as const) {
      test(`${mode}: ${close} close ${close === 'user' && queryMode === 'nested' ? 'blocks program reentry until its close query is answered' : `tolerates ${queryMode} close-query reentry without repeating native cleanup`}`, async () => {
        const f = await fixture(binary)
        try {
          await f.execute(
            `System.exitOnWindowClose=false;a.queryMode="${queryMode}";b.queryMode="${queryMode}";a.add(new MultiManaged());b.add(new MultiManaged());`,
          )
          if (close === 'user') {
            await f.session.closeWindow(f.b)
            await f.session.closeWindow(f.a)
            if (queryMode === 'nested') {
              // The nested script close returns immediately while user close
              // awaits a base onCloseQuery answer; it does not issue a second
              // query or use the program-close default permission.
              assert.equal(
                await f.session.evaluate(
                  '(isvalid a)+","+(isvalid b)+","+a.queries+","+b.queries+","+aDeaths+","+bDeaths+","+managedDeaths+","+(Window.mainWindow===a)',
                ),
                '1,1,1,1,0,0,0,1',
              )
              await f.session.closeWindow(f.b)
              await f.session.closeWindow(f.a)
              await f.session.evaluate('closeSecondary()')
              await f.session.evaluate('closeMain()')
              assert.equal(await f.session.evaluate('trace.join("|")'), 'B:query|A:query')
              await f.execute('a.answerClose(false);b.answerClose(false);')
              await f.session.evaluate('closeSecondary()')
              await f.session.evaluate('closeMain()')
            }
          } else {
            await f.session.evaluate('closeSecondary()')
            await f.session.evaluate('closeMain()')
          }
          assert.equal(
            await f.session.evaluate(
              '(isvalid a)+","+(isvalid b)+","+aDeaths+","+bDeaths+","+managedDeaths+","+(Window.mainWindow===null)',
            ),
            '0,0,1,1,2,1',
          )
          assert.equal(
            await f.session.evaluate('trace.join("|")'),
            queryMode === 'invalidate'
              ? 'B:query|A:query'
              : close === 'user'
                ? 'B:query|A:query|B:query|A:query'
                : 'B:query|B:query|A:query|A:query',
          )
          assert.equal(f.session.snapshot().state, 'running')
          assert.equal(f.session.inspectOwnership().windowSources, 0)
          assert.equal(f.session.inspectOwnership().closingWindows, 0)
          // Stale UI close requests must not act on a newly registered Window.
          await f.execute('var replacement=new MultiWindow("replacement");')
          await f.session.closeWindow(f.a)
          await f.session.closeWindow(f.b)
          assert.equal(
            await f.session.evaluate('(Window.mainWindow===replacement)+","+replacement.queries'),
            '1,0',
          )
        } finally {
          await f.session.stop()
        }
      })
    }
  }

  test(`${mode}: program close defaults to permission when an override omits the base close-query answer`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('a.allow=false;b.allow=false;a.queryMode=b.queryMode="defer";')
      await f.session.evaluate('closeSecondary()')
      assert.equal(await f.session.evaluate('(isvalid b)+","+bDeaths'), '0,1')
      assert.equal(f.session.snapshot().state, 'running')
      await f.session.evaluate('closeMain()')
      assert.ok(['stopping', 'stopped'].includes(f.session.snapshot().state))
      assert.ok(f.logs.includes('after-main-close:0'))
      await f.session.stop()
      assert.equal(f.logs.filter((message) => message === 'finalized:A').length, 1)
      assert.equal(f.logs.filter((message) => message === 'finalized:B').length, 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a deferred secondary user-close answer rejects or hides exactly once without invalidating managed objects`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('b.queryMode="defer";var managed=new MultiManaged();b.add(managed);')
      await f.session.closeWindow(f.b)
      await f.session.closeWindow(f.b)
      await f.session.evaluate('closeSecondary()')
      assert.equal(
        await f.session.evaluate('b.queries+","+b.visible+","+(isvalid b)+","+(isvalid managed)'),
        '1,1,1,1',
      )
      await f.execute('b.answerClose(false);')
      assert.equal(await f.session.evaluate('b.visible+","+b.queries'), '1,1')
      await f.session.closeWindow(f.b)
      await f.session.evaluate('closeSecondary()')
      assert.equal(await f.session.evaluate('b.visible+","+b.queries'), '1,2')
      await f.execute('b.answerClose(true);')
      assert.equal(
        await f.session.evaluate(
          'b.visible+","+(isvalid b)+","+(isvalid managed)+","+bDeaths+","+managedDeaths',
        ),
        '0,1,1,0,0',
      )
      // The pending flag was cleared by the answer. A later answer alone is
      // program permission state; it cannot hide an independently reopened UI.
      await f.execute('b.visible=true;b.answerClose(true);')
      assert.equal(await f.session.evaluate('b.visible+","+b.queries'), '1,2')
      await f.execute('b.queryMode="";')
      await f.session.evaluate('closeSecondary()')
      assert.equal(await f.session.evaluate('bDeaths+","+managedDeaths'), '1,1')
      assert.equal(await f.session.evaluate('trace.join("|")'), 'B:query|B:query|B:query')
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a deferred main user-close answer keeps running after rejection and terminates only after permission`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('a.queryMode="defer";a.add(new MultiManaged());')
      await f.session.closeWindow(f.a)
      await f.session.closeWindow(f.a)
      await f.session.evaluate('closeMain()')
      assert.equal(
        await f.session.evaluate('a.queries+","+(Window.mainWindow===a)+","+a.visible'),
        '1,1,1',
      )
      assert.equal(f.session.snapshot().state, 'running')
      await f.execute('a.answerClose(false);')
      assert.equal(f.session.snapshot().state, 'running')
      await f.session.closeWindow(f.a)
      assert.equal(await f.session.evaluate('a.queries'), '2')
      await f.execute('a.answerClose(true);Debug.message("after-main-answer:"+int(isvalid b));')
      assert.ok(['stopping', 'stopped'].includes(f.session.snapshot().state))
      assert.ok(f.logs.includes('after-main-answer:1'))
      assert.ok(f.logs.includes('managed-closed'))
      await f.session.stop()
      assert.equal(f.logs.filter((message) => message === 'finalized:A').length, 1)
      assert.equal(f.session.snapshot().handles, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a failed main script finalizer does not request automatic exit before native invalidation`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('a.failFinalizer=true;')
      assert.equal(await f.session.evaluate('tryMainFinalizer()'), 'multiwindow-finalizer')
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(await f.session.evaluate('(Window.mainWindow===a)+","+(isvalid a)'), '1,1')
      await f.execute('a.failFinalizer=false;')
      await f.session.evaluate('closeMain()')
      assert.ok(['stopping', 'stopped'].includes(f.session.snapshot().state))
      await f.session.stop()
      assert.equal(f.logs.filter((message) => message === 'finalized:A').length, 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a queued user close is cancelled when its Window retires while another VM operation is suspended`, async () => {
    let entered!: () => void, finish!: (source: string) => void
    const ready = new Promise<void>((resolve) => {
        entered = resolve
      }),
      gate = new Promise<string>((resolve) => {
        finish = resolve
      })
    const f = await fixture(binary, {
      decodeScript(bytes, mode, encoding) {
        if (new TextDecoder().decode(bytes) === 'multiwindow-lifecycle-gate') {
          entered()
          return gate
        }
        return readScript(bytes, mode, encoding)
      },
    })
    try {
      await f.execute('System.exitOnWindowClose=false;')
      const reading = f.session.evaluate('Scripts.execStorage("gate.tjs")')
      await ready
      const closing = f.session.closeWindow(f.a)
      finish('invalidate a;')
      await Promise.all([reading, closing])
      assert.equal(await f.session.evaluate('trace.join("|")'), '')
      assert.equal(await f.session.evaluate('aDeaths+","+(isvalid b)+","+b.visible'), '1,1,1')
      await f.session.closeWindow(f.b)
      assert.equal(await f.session.evaluate('b.queries+","+b.visible'), '1,0')
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      finish('0;')
      await f.session.stop()
    }
  })
}

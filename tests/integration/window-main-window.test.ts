import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { windowFixture, videoGate } from '../helpers/window-lifetime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: mainWindow identifies the derived instance regardless of visibility or direct finalize`, async () => {
    const f = await windowFixture(binary)
    try {
      assert.equal(await f.session.evaluate('global.Window.mainWindow===null'), '1')
      await f.execute('makeWindow();win.visible=true;')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===win)+","+(LifetimeWindow.mainWindow===win)+","+(win.mainWindow===win)',
        ),
        '1,1,1',
      )
      await f.execute('win.visible=false;win.finalize();')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===win)+","+(win.mainWindow===win)+","+(isvalid win)+","+finalized',
        ),
        '1,1,1,1',
      )
      await f.execute('delete global.win;')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+finalized'),
        '1,2',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mainWindow stays read-only on the class, derived class and instances while a second Window is registered`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(`
makeWindow();var rejected=0;
try{global.Window.mainWindow=null;}catch(error){rejected++;}
try{LifetimeWindow.mainWindow=null;}catch(error){rejected++;}
try{win.mainWindow=null;}catch(error){rejected++;}
var second=new global.Window();second.visible=true;
`)
      assert.equal(
        await f.session.evaluate(
          'rejected+","+(global.Window.mainWindow===win)+","+(LifetimeWindow.mainWindow===win)+","+(win.mainWindow===win)+","+(second.mainWindow===win)+","+(second!==win)',
        ),
        '3,1,1,1,1,1',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 2)
      await f.execute('delete global.win;')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+(isvalid second)'),
        '1,1',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('delete global.second;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: repeated temporary mainWindow queries restore live ownership and do not prevent collection`, async () => {
    const f = await windowFixture(
      binary,
      'function queryMain(){for(var i=0;i<64;i++){if(global.Window.mainWindow!==win)throw new Exception("main identity");}}',
    )
    try {
      await f.execute('makeWindow();queryMain();')
      const liveOwnership = f.session.inspectOwnership(),
        liveHandles = f.session.snapshot().handles
      for (let i = 0; i < 3; i++) {
        await f.execute('queryMain();')
        await f.session.idle()
        assert.deepEqual(f.session.inspectOwnership(), liveOwnership)
        assert.equal(f.session.snapshot().handles, liveHandles)
      }
      await f.execute('delete global.win;')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+finalized'),
        '1,1',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a stored mainWindow result owns the Window only until that script reference is released`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();var saved=global.Window.mainWindow;delete global.win;')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===saved)+","+(isvalid saved)+","+finalized',
        ),
        '1,1,0',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('delete global.saved;')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+finalized'),
        '1,1',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: displaying a temporary Window returned through mainWindow releases the host result`, async () => {
    const f = await windowFixture(
      binary,
      'function mainWindowFactory(){var temporary=new LifetimeWindow();return global.Window.mainWindow;}',
    )
    try {
      assert.equal(await f.session.evaluate('mainWindowFactory()'), '[TJS object]')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+finalized'),
        '1,1',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a script finalizer failure preserves mainWindow until a successful retry enters native cleanup`, async () => {
    const f = await windowFixture(
      binary,
      `
class MainFinalizerWindow extends LifetimeWindow {
  function MainFinalizerWindow(){super.LifetimeWindow();}
  function finalize(){
    finalized++;trace+="script:"+int(global.Window.mainWindow===this)+";";
    if(failWindow)throw new Exception("main-window-finalizer");
  }
}
class MainCleanupObserver {
  var owner;
  function MainCleanupObserver(window){owner=window;}
  function finalize(){
    managedFinalized++;
    trace+="managed:"+int(global.Window.mainWindow===null)+":"+owner.caption+":"+int(isvalid owner)+";";
  }
}
`,
    )
    try {
      await f.execute(`
var win=new MainFinalizerWindow(),item=new MainCleanupObserver(win);win.add(item);
failWindow=true;try{invalidate win;}catch(error){caught=error.message;}
`)
      assert.equal(await f.session.evaluate('caught'), 'main-window-finalizer')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===win)+","+(isvalid win)+","+(isvalid item)+","+trace',
        ),
        '1,1,1,script:1;',
      )
      assert.equal(f.session.inspectOwnership().closingWindows, 0)
      await f.execute('failWindow=false;invalidate win;invalidate win;')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===null)+","+(isvalid win)+","+(isvalid item)+","+trace',
        ),
        '1,0,0,script:1;script:1;managed:1:original:1;',
      )
      await f.execute('delete global.item;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: native cleanup unregisters the old mainWindow before managed finalizers create its replacement`, async () => {
    const f = await windowFixture(
      binary,
      `
var replacement=null;
class MainReplacement {
  function finalize(){
    trace+="before:"+int(global.Window.mainWindow===null)+";";
    replacement=new LifetimeWindow();replacement.caption="replacement";replacement.visible=true;
    trace+="created:"+int(global.Window.mainWindow===replacement)+";";
  }
}
class FollowingMainCleanup {
  function finalize(){trace+="following:"+int(global.Window.mainWindow===replacement)+";";}
}
`,
    )
    try {
      await f.execute(
        'makeWindow();win.add(new MainReplacement());win.add(new FollowingMainCleanup());invalidate win;delete global.win;',
      )
      assert.equal(await f.session.evaluate('trace'), 'before:1;created:1;following:1;')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===replacement)+","+replacement.caption+","+replacement.visible',
        ),
        '1,replacement,1',
      )
      assert.equal(f.session.snapshot().title, 'replacement')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('delete global.replacement;')
      assert.equal(
        await f.session.evaluate('(global.Window.mainWindow===null)+","+finalized'),
        '1,2',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a saved mainWindow property accessor follows the current registration without retaining old Windows`, async () => {
    const f = await windowFixture(
      binary,
      `
var mainAccessor=&global.Window.mainWindow;
function readMainAccessor(){var accessor=&global.mainAccessor;return *accessor;}
function rejectMainAccessorWrites(){
  var rejected=0;
  try{global.mainAccessor=null;}catch(error){rejected++;}
  try{*(&global.mainAccessor)=null;}catch(error){rejected++;}
  return rejected;
}
`,
    )
    try {
      // Global slots dispatch stored property objects on an ordinary read.
      // Fetch the property itself with & before using explicit *, as a local
      // register holding the accessor does in readMainAccessor().
      assert.equal(
        await f.session.evaluate(
          '(mainAccessor===null)+","+((*(&global.mainAccessor))===null)+","+(readMainAccessor()===null)',
        ),
        '1,1,1',
      )
      await f.execute('makeWindow();')
      assert.equal(
        await f.session.evaluate(
          '((*(&global.mainAccessor))===win)+","+(readMainAccessor()===win)+","+rejectMainAccessorWrites()',
        ),
        '1,1,2',
      )
      await f.execute('delete global.win;')
      assert.equal(
        await f.session.evaluate('((*(&global.mainAccessor))===null)+","+finalized'),
        '1,1',
      )
      await f.restored()
      await f.execute('makeWindow();win.caption="next-main";')
      assert.equal(
        await f.session.evaluate(
          '((*(&global.mainAccessor))===win)+","+readMainAccessor().caption+","+rejectMainAccessorWrites()',
        ),
        '1,next-main,2',
      )
      await f.execute('delete global.win;')
      assert.equal(
        await f.session.evaluate('((*(&global.mainAccessor))===null)+","+finalized'),
        '1,2',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a constructor failure leaves mainWindow null even when its script finalizer also fails`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'failConstruct=true;failWindow=true;try{makeWindow();}catch(error){caught=error.message;}',
      )
      assert.match(await f.session.evaluate('caught'), /window-constructor/)
      assert.doesNotMatch(await f.session.evaluate('caught'), /window-finalizer/)
      assert.equal(await f.session.evaluate('global.Window.mainWindow===null'), '1')
      await f.restored()
      await f.execute('failConstruct=false;failWindow=false;makeWindow();')
      assert.equal(await f.session.evaluate('global.Window.mainWindow===win'), '1')
      await f.execute('delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: mainWindow is cleared before managed cleanup after an asynchronous video close`, async () => {
    const f = await windowFixture(
      binary,
      `
class MainMediaObserver {
  function finalize(){
    trace=int(global.Window.mainWindow===null)+":"+movie.status+":"+win.caption+":"+int(isvalid win);
    Debug.message("main-managed-after-video");
  }
}
`,
    )
    const gate = videoGate()
    let ending: Promise<string> | undefined,
      settled = false
    try {
      await f.execute(
        'makeWindow();var movie=new VideoOverlay(win);movie.open("movie.mp4");movie.play();win.add(new MainMediaObserver());',
      )
      assert.equal(await f.session.evaluate('global.Window.mainWindow===win'), '1')
      f.video.nextClose = gate
      ending = f.execute('invalidate win;').then((result) => {
        settled = true
        return result
      })
      await Promise.race([
        gate.entered,
        ending.then(() => {
          throw new Error('Video close did not wait')
        }),
      ])
      assert.equal(settled, false)
      assert.equal(f.session.inspectOwnership().closingWindows, 1)
      assert.equal(f.logs.includes('main-managed-after-video'), false)
      gate.release()
      await ending
      assert.equal(await f.session.evaluate('trace'), '1:unload:original:1')
      assert.equal(await f.session.evaluate('global.Window.mainWindow===null'), '1')
      await f.execute('delete global.movie;delete global.win;')
      await f.restored()
    } finally {
      gate.release()
      await ending?.catch(() => {})
      await f.session.stop()
    }
  })

  test(`${mode}: retrying failed native cleanup preserves a replacement mainWindow`, async () => {
    const f = await windowFixture(
      binary,
      `
var replacement=null;
class MainCloseObserver {
  function finalize(){
    managedFinalized++;
    trace=int(global.Window.mainWindow===replacement)+":"+win.caption+":"+int(isvalid win);
  }
}
`,
    )
    try {
      await f.execute(
        'makeWindow();var movie=new VideoOverlay(win);movie.open("movie.mp4");var item=new MainCloseObserver();win.add(item);',
      )
      f.video.failClose = new Error('main-close-failure')
      await f.execute('try{invalidate win;}catch(error){caught=error.message;}')
      assert.match(await f.session.evaluate('caught'), /main-close-failure/)
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===null)+","+(isvalid win)+","+(isvalid item)+","+managedFinalized+","+movie.status',
        ),
        '1,1,1,0,unload',
      )
      assert.equal(f.session.inspectOwnership().closingWindows, 1)
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 0)
      assert.equal(f.video.movies.size, 0)

      await f.execute(
        'replacement=new LifetimeWindow();replacement.caption="after-close-failure";replacement.visible=true;',
      )
      assert.equal(await f.session.evaluate('global.Window.mainWindow===replacement'), '1')
      await f.execute('invalidate win;')
      assert.equal(
        await f.session.evaluate(
          '(global.Window.mainWindow===replacement)+","+(isvalid win)+","+(isvalid item)+","+managedFinalized+","+trace',
        ),
        '1,0,0,1,1:original:1',
      )
      assert.equal(f.session.snapshot().title, 'after-close-failure')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().closingWindows, 0)
      await f.execute('delete global.movie;delete global.item;delete global.win;')
      assert.equal(await f.session.evaluate('global.Window.mainWindow===replacement'), '1')
      await f.execute('delete global.replacement;')
      assert.equal(await f.session.evaluate('global.Window.mainWindow===null'), '1')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
}

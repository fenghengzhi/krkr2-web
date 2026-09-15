import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { windowFixture, videoGate } from '../helpers/window-lifetime.ts'
const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: an unreferenced Window retires without a host callback root`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().weakOwners, f.baseline.weakOwners + 1)
      assert.equal(await f.session.evaluate('win.__windowMenu===null'), '1')
      await f.execute('delete global.win;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: displaying a temporary Window releases its native state`, async () => {
    const f = await windowFixture(binary)
    try {
      assert.equal(await f.session.evaluate('new LifetimeWindow()'), '[TJS object]')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: direct Window finalize does not replace native invalidation`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();win.finalize();')
      assert.equal(
        await f.session.evaluate('(isvalid win)+","+win.caption+","+finalized'),
        '1,original,1',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('invalidate win;invalidate win;delete global.win;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '2')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: Window native cleanup reads members after an overridden script finalizer`, async () => {
    const f = await windowFixture(
      binary,
      'class ReadWindow {var owner;function ReadWindow(w){owner=w;}function finalize(){trace=owner.caption+":"+owner.marker+":"+(isvalid owner);managedFinalized++;}}',
    )
    try {
      await f.execute(
        'makeWindow();var item=new ReadWindow(win);win.add(item);win.add(item);invalidate win;',
      )
      assert.equal(
        await f.session.evaluate('trace+","+finalized+","+managedFinalized+","+(isvalid item)'),
        'original:42:1,1,1,0',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 0)
      await f.execute('delete global.item;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: a failed Window finalizer preserves native state and registered objects for retry`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'makeWindow();var item=new ManagedWindowObject();win.add(item);failWindow=true;try{invalidate win;}catch(e){caught=e.message;}',
      )
      assert.match(await f.session.evaluate('caught'), /window-finalizer/)
      assert.equal(
        await f.session.evaluate(
          '(isvalid win)+","+(isvalid item)+","+win.caption+","+managedFinalized',
        ),
        '1,1,original,0',
      )
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().closingWindows, 0)
      await f.execute('failWindow=false;invalidate win;delete global.win;delete global.item;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized+","+managedFinalized'), '2,1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: Window.remove releases the registered object's final ownership`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'makeWindow();var item=new ManagedWindowObject();win.add(item);delete global.item;',
      )
      assert.equal(await f.session.evaluate('managedFinalized'), '0')
      await f.execute('win.remove(win.__windowObjects[0]);')
      assert.equal(
        await f.session.evaluate('managedFinalized+","+win.__windowObjects.count'),
        '1,0',
      )
      await f.execute('delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: a removed external object remains valid when its Window closes`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'makeWindow();var item=new ManagedWindowObject();win.add(item);win.remove(item);win.remove(item);invalidate win;',
      )
      assert.equal(await f.session.evaluate('(isvalid item)+","+managedFinalized'), '1,0')
      await f.execute('delete global.item;delete global.win;')
      await f.restored()
      assert.equal(await f.session.evaluate('managedFinalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: Window registration distinguishes closures bound to different receivers`, async () => {
    const f = await windowFixture(binary, 'function bound(){return this.marker;}')
    try {
      await f.execute(
        'makeWindow();var a=%[marker:1],b=%[marker:2],first=bound incontextof a,second=bound incontextof b;win.add(first);win.add(second);win.add(first);',
      )
      assert.equal(await f.session.evaluate('win.__windowObjects.count'), '2')
      await f.execute('win.remove(first);')
      assert.equal(
        await f.session.evaluate('win.__windowObjects.count+","+win.__windowObjects[0]()'),
        '1,2',
      )
      await f.execute(
        'win.remove(second);delete global.first;delete global.second;delete global.a;delete global.b;delete global.win;',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: lazy Window menu preserves identity and releases its host callback root`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();var menu=win.menu;')
      assert.equal(await f.session.evaluate('win.menu===menu'), '1')
      await f.execute('invalidate menu;delete global.menu;delete global.win;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: a live Menu action owner deliberately keeps its Window alive`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();var menu=win.menu;delete global.win;')
      assert.equal(await f.session.evaluate('finalized'), '0')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('invalidate menu;delete global.menu;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  for (const pending of ['resize', 'input'])
    test(`${mode}: pending native ${pending} does not keep a Window alive`, async () => {
      const f = await windowFixture(binary)
      try {
        await f.execute(
          'System.eventDisabled=true;makeWindow();' +
            (pending === 'resize'
              ? 'win.setInnerSize(100,80);'
              : 'win.postInputEvent("onKeyDown",%[key:65]);') +
            'delete global.win;',
        )
        await f.restored()
        assert.equal(await f.session.evaluate('finalized+","+calls'), '1,0')
        await f.execute('System.eventDisabled=false;')
        await f.restored()
        assert.equal(await f.session.evaluate('calls'), '0')
      } finally {
        await f.session.stop()
      }
    })
  test(`${mode}: a resize callback can release the last Window reference`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'makeWindow();win.onResize=dropWindow incontextof win;win.setInnerSize(100,80);',
      )
      await f.restored()
      assert.equal(await f.session.evaluate('finalized+","+calls'), '1,1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: an input callback owns its receiver only for delivery`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();win.visible=true;win.onKeyDown=dropWindow incontextof win;')
      await f.session.input({ type: 'keyDown', key: 65, shift: 0 })
      await f.restored()
      assert.equal(await f.session.evaluate('finalized+","+calls'), '1,1')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: retiring Window cleanup cannot close a replacement created by a managed finalizer`, async () => {
    const f = await windowFixture(
      binary,
      'class Replacer {function finalize(){global.replacement=new LifetimeWindow();replacement.caption="replacement";replacement.visible=true;trace=win.caption;}}',
    )
    try {
      await f.execute('makeWindow();win.add(new Replacer());invalidate win;delete global.win;')
      assert.equal(
        await f.session.evaluate('trace+","+replacement.caption+","+replacement.visible'),
        'original,replacement,1',
      )
      assert.equal(f.session.snapshot().title, 'replacement')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('invalidate replacement;delete global.replacement;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '2')
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: Window primaryLayer is read-only and external Layer lifetime is independent`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute('makeWindow();var layer=new Layer(win,null);')
      assert.equal(await f.session.evaluate('win.primaryLayer===layer'), '1')
      await f.execute('try{win.primaryLayer=null;}catch(e){caught=e.message;}')
      assert.notEqual(await f.session.evaluate('caught'), '')
      await f.execute('invalidate win;delete global.win;')
      assert.equal(await f.session.evaluate('isvalid layer'), '1')
      assert.equal(f.session.snapshot().layers, 1)
      await f.execute('invalidate layer;delete global.layer;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: old Window layers are excluded from the replacement's drawing and input`, async () => {
    const f = await windowFixture(
      binary,
      'function oldPointer(){trace="old";}function newPointer(){trace="new";}',
    )
    try {
      await f.execute(
        'makeWindow();win.visible=true;var oldLayer=new Layer(win,null);oldLayer.fillRect(0,0,32,32,0xffff0000);invalidate win;delete global.win;makeWindow();win.visible=true;var newLayer=new Layer(win,null);newLayer.fillRect(0,0,32,32,0xff0000ff);',
      )
      const id = Number(await f.session.evaluate('newLayer.__id'))
      assert.deepEqual(
        f.frames().map((layer) => layer.id),
        [id],
      )
      assert.equal(await f.session.evaluate('win.primaryLayer===newLayer'), '1')
      await f.execute('oldLayer.onMouseDown=oldPointer;newLayer.onMouseDown=newPointer;')
      await f.session.input({ type: 'down', x: 1, y: 1, button: 0, shift: 0, clicks: 1 })
      assert.equal(await f.session.evaluate('trace'), 'new')
      await f.execute(
        'invalidate oldLayer;delete global.oldLayer;invalidate newLayer;delete global.newLayer;delete global.win;',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: failed construction preserves the primary error and unregisters native Window state`, async () => {
    const f = await windowFixture(binary)
    try {
      await f.execute(
        'failConstruct=true;failWindow=true;try{makeWindow();}catch(e){caught=e.message;}',
      )
      assert.match(await f.session.evaluate('caught'), /window-constructor/)
      assert.doesNotMatch(await f.session.evaluate('caught'), /window-finalizer/)
      await f.restored()
      await f.execute('failConstruct=false;failWindow=false;makeWindow();delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: Window invalidation waits for video closure before managed finalizers`, async () => {
    const f = await windowFixture(
      binary,
      'class MediaCheck {function finalize(){trace=movie.status+":"+win.caption+":"+(isvalid win);Debug.message("managed-after-video");}}',
    )
    const gate = videoGate()
    let ending: Promise<string> | undefined,
      settled = false
    try {
      await f.execute(
        'makeWindow();var movie=new VideoOverlay(win);movie.open("movie.mp4");movie.play();win.add(new MediaCheck());',
      )
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
      assert.equal(f.logs.includes('managed-after-video'), false)
      gate.release()
      await ending
      assert.equal(await f.session.evaluate('trace'), 'unload:original:1')
      assert.equal(f.video.movies.size, 0)
      await f.execute('delete global.movie;delete global.win;')
      await f.restored()
    } finally {
      gate.release()
      await ending
      await f.session.stop()
    }
  })
  test(`${mode}: stopping live Windows disposes host state once`, async () => {
    const f = await windowFixture(binary)
    await f.execute('makeWindow();var menu=win.menu;var layer=new Layer(win,null);')
    await f.session.stop()
    f.stopped()
    await f.session.stop()
    f.stopped()
  })
}

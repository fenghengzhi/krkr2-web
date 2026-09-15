import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { layerFixture } from '../helpers/layer-lifetime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: Layer native state retains its Window action owner until the Layer dies`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),layer=new LifetimeLayer(win);delete global.win;',
      )
      assert.equal(
        await f.session.evaluate('layer.window.caption+","+layerWindowDeaths'),
        'layer owner,0',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      await f.execute('delete global.layer;')
      assert.equal(await f.session.evaluate('layerDeaths+","+layerWindowDeaths'), '1,1')
      await f.restored()
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: a Layer parent without a children snapshot does not retain its child`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new LifetimeLayer(win,parent);delete global.child;',
      )
      assert.equal(await f.session.evaluate('layerDeaths+","+parent.children.count'), '1,0')
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute('delete global.parent;delete global.win;')
      assert.equal(await f.session.evaluate('layerDeaths'), '2')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a surviving child does not retain its Layer parent`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new LifetimeLayer(win,parent);delete global.parent;',
      )
      assert.equal(
        await f.session.evaluate(
          'layerDeaths+","+(isvalid child)+","+(child.parent===null)+","+(child.window===win)',
        ),
        '1,1,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute('delete global.child;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: invalidating a Layer releases its children cache and detaches valid external children`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new LifetimeLayer(win,parent),cache=parent.children;invalidate parent;delete global.child;',
      )
      assert.equal(
        await f.session.evaluate(
          'layerDeaths+","+(isvalid cache)+","+cache.count+","+(isvalid cache[0])+","+(cache[0].parent===null)',
        ),
        '1,1,1,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute('delete global.cache;')
      assert.equal(await f.session.evaluate('layerDeaths'), '2')
      assert.equal(f.session.inspectOwnership().layerSources, 0)
      await f.execute('delete global.parent;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a stable mutable Layer children cache owns its stale snapshot until refresh`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new LifetimeLayer(win,parent),cache=parent.children;delete global.child;',
      )
      assert.equal(
        await f.session.evaluate('layerDeaths+","+(cache===parent.children)+","+cache.count'),
        '0,1,1',
      )
      await f.execute('cache.clear();')
      assert.equal(await f.session.evaluate('layerDeaths+","+parent.children.count'), '1,0')
      await f.execute('cache.add("user entry");')
      assert.equal(await f.session.evaluate('parent.children[0]'), 'user entry')
      await f.execute('var second=new LifetimeLayer(win,parent);')
      assert.equal(
        await f.session.evaluate(
          '(parent.children===cache)+","+cache.count+","+(cache[0]===second)',
        ),
        '1,1,1',
      )
      await f.execute('second.parent=null;delete global.second;')
      assert.equal(await f.session.evaluate('layerDeaths+","+cache.count'), '1,1')
      assert.equal(
        await f.session.evaluate('(parent.children===cache)+","+cache.count+","+layerDeaths'),
        '1,0,2',
      )
      await f.execute('delete global.cache;delete global.parent;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: Layer font identity is retained by the Layer without retaining its owner`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),layer=new LifetimeLayer(win),font=layer.font;font.height=37;delete global.font;var font=layer.font;',
      )
      assert.equal(await f.session.evaluate('(font===layer.font)+","+font.height'), '1,37')
      await f.execute('delete global.layer;')
      assert.equal(await f.session.evaluate('layerDeaths+","+(isvalid font)'), '1,0')
      assert.equal(f.session.inspectOwnership().layerSources, 0)
      await f.execute('delete global.font;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: direct and overridden Layer finalizers do not replace native invalidation`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new Layer(win,parent),font=parent.font;parent.finalize();',
      )
      assert.equal(
        await f.session.evaluate(
          'layerDeaths+","+(isvalid parent)+","+(isvalid font)+","+(child.parent===parent)',
        ),
        '1,1,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 2)
      await f.execute('invalidate parent;invalidate parent;')
      assert.equal(
        await f.session.evaluate(
          'layerDeaths+","+(isvalid font)+","+(isvalid child)+","+(child.parent===null)',
        ),
        '2,0,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute(
        'delete global.font;delete global.parent;delete global.child;delete global.win;',
      )
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a failed Layer script finalizer preserves native state for retry`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),child=new Layer(win,parent),font=parent.font;failLayer=true;try{invalidate parent;}catch(e){layerCaught=e.message;}',
      )
      assert.match(await f.session.evaluate('layerCaught'), /layer-finalizer/)
      assert.equal(
        await f.session.evaluate(
          '(isvalid parent)+","+(isvalid font)+","+(child.parent===parent)+","+(parent.window===win)',
        ),
        '1,1,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 2)
      assert.equal(f.session.inspectOwnership().closingLayers, 0)
      await f.execute('failLayer=false;invalidate parent;')
      assert.equal(
        await f.session.evaluate(
          'layerDeaths+","+(isvalid font)+","+(isvalid child)+","+(child.parent===null)',
        ),
        '2,0,1,1',
      )
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.execute(
        'delete global.font;delete global.parent;delete global.child;delete global.win;',
      )
      await f.restored()
      assert.deepEqual(f.logs, [])
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: failed Layer construction unregisters the partial child and keeps the constructor error`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new Layer(win,null);parent.children;',
      )
      const before = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles
      await f.execute(
        'failLayerConstruct=true;try{new LifetimeLayer(win,parent);}catch(e){layerCaught=e.message;}',
      )
      assert.match(await f.session.evaluate('layerCaught'), /layer-constructor/)
      assert.doesNotMatch(await f.session.evaluate('layerCaught'), /layer-finalizer/)
      assert.equal(await f.session.evaluate('parent.children.count'), '0')
      await f.session.idle()
      assert.deepEqual(f.session.inspectOwnership(), before)
      assert.equal(f.session.snapshot().handles, handles)
      assert.deepEqual(f.logs, [])
      await f.execute('failLayerConstruct=false;delete global.parent;delete global.win;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: Layer order refreshes the same cache and invalidated caches keep their identity`, async () => {
    const f = await layerFixture(binary)
    try {
      await f.execute(
        'var win=new LifetimeLayerWindow(),parent=new LifetimeLayer(win),first=new LifetimeLayer(win,parent),second=new LifetimeLayer(win,parent),cache=parent.children;second.order=0;',
      )
      assert.equal(
        await f.session.evaluate(
          '(parent.children===cache)+","+(cache[0]===second)+","+(cache[1]===first)',
        ),
        '1,1,1',
      )
      await f.execute('invalidate cache;first.parent=null;')
      assert.equal(
        await f.session.evaluate('(parent.children===cache)+","+(isvalid parent.children)'),
        '1,0',
      )
      await f.execute(
        'delete global.first;delete global.second;delete global.parent;delete global.cache;delete global.win;',
      )
      assert.equal(await f.session.evaluate('layerDeaths'), '3')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import type { EngineSession } from '../../src/engine/session.ts'
import { headless } from '../helpers/headless.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'

const exec = (session: EngineSession, source: string) =>
  session.evaluate('Scripts.exec(' + JSON.stringify(source) + ')')
const bmp = (color: number) =>
  encodeBmp({ width: 1, height: 1, data: Uint8Array.of(color, 0, 0, 255) })

test('TJS cache property and preloading share canonical images without creating or mutating layers', async () => {
  const { session } = await headless({
    'art/main.png': imageFixture('main.png'),
    '7.png': bmp(7),
    'broken.png': Uint8Array.of(1),
  })
  try {
    assert.equal(await session.evaluate('System.graphicCacheLimit'), String(32 * 1024 * 1024))
    assert.equal(await session.evaluate('typeof global.__graphicCacheLimit'), 'undefined')
    await exec(
      session,
      'Storages.addAutoPath("art");System.graphicCacheLimit=4096;var result=System.touchImages(["missing", "broken", "main", "ART/MAIN.PNG", 7, void, "ignored"]);',
    )
    assert.equal(await session.evaluate('result===void && System.graphicCacheLimit==4096'), '1')
    const initial = session.snapshot()
    assert.equal(initial.imageCacheEntries, 2)
    assert.equal(initial.layers, 0)
    assert.equal(initial.imageCacheMisses, 3)
    await exec(
      session,
      'var w=new Window(),root=new Layer(w,null),a=new Layer(w,root),b=new Layer(w,root);var tags=a.loadImages("main",0xc86432);tags.offs_x="changed";a.setMainPixel(0,0,0);a.setMaskPixel(1,0,0);var second=b.loadImages("main");',
    )
    assert.equal(
      await session.evaluate(
        'b.getMainPixel(0,0)==0xc86432 && b.getMaskPixel(0,0)==64 && b.getMaskPixel(1,0)==128 && second.offs_x=="12"',
      ),
      '1',
    )
    assert.equal(session.snapshot().imageCacheMisses, initial.imageCacheMisses)
    await exec(session, 'System.clearGraphicCache();')
    assert.equal(session.snapshot().imageCacheEntries, 0)
    assert.equal(
      await session.evaluate('b.getMainPixel(0,0)==0xc86432 && b.getMaskPixel(1,0)==128'),
      '1',
    )
    await exec(
      session,
      'b.loadImages("main");System.graphicCacheLimit=0;b.loadImages("main");b.loadImages("main");',
    )
    assert.equal(session.snapshot().imageCacheMisses, initial.imageCacheMisses + 3)
    assert.equal(session.snapshot().imageCacheEntries, 0)
    await exec(session, 'System.graphicCacheLimit=gcsAuto;')
    assert.equal(session.snapshot().imageCacheLimit, 32 * 1024 * 1024)
    await exec(
      session,
      'var caught=0;try{System.touchImages("main");}catch(e){caught++;}try{System.graphicCacheLimit=-2;}catch(e){caught++;}try{System.touchImages([],0,-1);}catch(e){caught++;}try{b.loadImages("broken");}catch(e){caught++;}',
    )
    assert.equal(await session.evaluate('caught'), '4')
  } finally {
    await session.stop()
  }
})

test('TJS preload budgets protect the requested prefix and duplicate names do not consume capacity twice', async () => {
  const { session } = await headless({ 'a.bmp': bmp(1), 'b.bmp': bmp(2), 'c.bmp': bmp(3) })
  try {
    await exec(session, 'System.graphicCacheLimit=12;System.touchImages(["a","a","b","c"],-4);')
    assert.equal(session.snapshot().imageCacheBytes, 8)
    assert.equal(session.snapshot().imageCacheMisses, 2)
    await exec(session, 'System.clearGraphicCache();System.touchImages(["a","b","c"],4);')
    assert.equal(session.snapshot().imageCacheBytes, 4)
    assert.equal(session.snapshot().imageCacheMisses, 3)
    await exec(session, 'System.clearGraphicCache();System.touchImages(["a","b","c"]);')
    assert.equal(session.snapshot().imageCacheBytes, 12)
    assert.equal(session.snapshot().imageCacheMisses, 6)
  } finally {
    await session.stop()
  }
})

test('saved-image overwrites, imports and companion replacement invalidate cached versions', async () => {
  const { session } = await headless({ 'savedata/main.bmp': bmp(1), 'art/picture.bmp': bmp(4) })
  try {
    await exec(
      session,
      'Storages.addAutoPath("savedata");var w=new Window(),a=new Layer(w,null),b=new Layer(w,a);a.loadImages("main");a.fillRect(0,0,1,1,0xff090000);a.saveLayerImage("savedata/main.bmp","bmp32");',
    )
    assert.equal(session.snapshot().imageCacheEntries, 0)
    await exec(session, 'b.loadImages("MAIN");')
    assert.equal(await session.evaluate('b.getMainPixel(0,0)'), String(0x090000))
    await exec(session, 'a.loadImages("art/picture.bmp");')
    await session.importSaves([
      { path: 'savedata/main.bmp', bytes: bmp(12) },
      {
        path: 'art/picture_m.bmp',
        bytes: encodeBmp({ width: 1, height: 1, data: Uint8Array.of(64, 64, 64, 255) }),
      },
    ])
    await exec(session, 'b.loadImages("main");a.loadImages("art/picture.bmp");')
    assert.equal(
      await session.evaluate(
        'b.getMainPixel(0,0)==0x0c0000 && a.getMainPixel(0,0)==0x040000 && a.getMaskPixel(0,0)==64',
      ),
      '1',
    )
    const misses = session.snapshot().imageCacheMisses
    await session.importSaves([
      {
        path: 'art/picture_m.bmp',
        bytes: encodeBmp({ width: 1, height: 1, data: Uint8Array.of(128, 128, 128, 255) }),
      },
    ])
    await exec(session, 'a.loadImages("art/picture.bmp");')
    assert.equal(await session.evaluate('a.getMaskPixel(0,0)'), '128')
    assert.equal(session.snapshot().imageCacheMisses, misses + 1)
  } finally {
    await session.stop()
  }
})

test('preload array getters cannot grow the entry snapshot during enumeration', async () => {
  const { session } = await headless({ 'a.bmp': bmp(1), 'b.bmp': bmp(2) })
  try {
    await exec(
      session,
      'var names=[];property growingName { getter(){names.add("b");return "a";} } names[0]=&growingName;System.touchImages(names);',
    )
    assert.equal(await session.evaluate('names.count'), '2')
    assert.equal(session.snapshot().imageCacheEntries, 1)
    assert.equal(session.snapshot().imageCacheMisses, 1)
    await exec(
      session,
      'var oversized=[];oversized.count=4097;var rejected=false;try{System.touchImages(oversized);}catch(e){rejected=true;}',
    )
    assert.equal(await session.evaluate('rejected'), '1')
  } finally {
    await session.stop()
  }
})

test('pausing then stopping preloading releases retained images and does not execute the next script statement', async () => {
  let signal = () => {},
    release = () => {},
    held = false,
    ticks = 0
  const entered = new Promise<void>((resolve) => {
    signal = resolve
  })
  const { session, logs } = await headless(
    {
      'a.bmp': bmp(1),
      'b.bmp': bmp(2),
      'startup.tjs':
        'Debug.message("preload-start");System.touchImages(["a","b"]);Debug.message("preload-finished");',
    },
    {
      now: () => (ticks += 10),
      schedule: (callback, delay) => {
        if (delay === 0 && !held) {
          held = true
          release = callback
          signal()
          return () => {}
        }
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      },
    },
  )
  try {
    const started = session.start()
    await entered
    assert.equal(session.snapshot().imageCacheEntries, 1)
    session.pause()
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(!logs.includes('preload-finished'))
    const results = await Promise.allSettled([started, session.stop()])
    assert.equal(results[1]!.status, 'fulfilled')
    assert.ok(!logs.includes('preload-finished'))
    assert.equal(session.snapshot().imageCacheBytes, 0)
    assert.equal(session.snapshot().imageCachePending, 0)
  } finally {
    await session.stop()
  }
})

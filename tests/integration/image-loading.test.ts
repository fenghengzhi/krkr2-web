import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'

test('loadImages combines auto-path companions and metadata, and loadProvinceImage preserves other planes', async () => {
  const { session } = await headless({
    'art/hero.PNG': imageFixture('main.png'),
    'art/hero_m.png': imageFixture('mask.png'),
    'patch/hero_p.png': imageFixture('palette-2x1.png'),
    'alternate.gif': imageFixture('palette-2x1.gif'),
    'tiny.png': imageFixture('png-0-8-0-1x1'),
    'plain.png': imageFixture('main.png'),
    'bad.png': imageFixture('main.png'),
    'bad_m.png': imageFixture('png-0-8-0-1x1'),
    'invalid.png': imageFixture('main.png'),
    'invalid_p.png': imageFixture('main.png'),
    'startup.tjs': String.raw`
Storages.addAutoPath("art/");Storages.addAutoPath("patch/");
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root),copy=new Layer(window,root);
layer.setImageSize(2,1);layer.setPos(3,4);var tags=layer.loadImages("hero",0xc86432);
var loaded=layer.getMainPixel(0,0)==0xc86432 && layer.getMaskPixel(0,0)==0 && layer.getMaskPixel(1,0)==128 && layer.getProvincePixel(0,0)==0 && layer.getProvincePixel(1,0)==1 && tags.offs_x=="12" && tags.offs_y=="-7" && layer.left==3 && layer.top==4;
layer.setClip(1,0,1,1);layer.loadProvinceImage("tiny");
var tiled=layer.getProvincePixel(0,0)==29 && layer.getProvincePixel(1,0)==29 && layer.getMaskPixel(1,0)==128 && layer.clipLeft==1 && layer.clipWidth==1;
var result=layer.loadProvinceImage("alternate");copy.assignImages(layer);
var province=result===void && copy.getProvincePixel(1,0)==1 && copy.getMainPixel(0,0)==0xc86432;
layer.imageModified=false;var failures=0;
try{layer.loadImages("bad");}catch(e){failures++;}
try{layer.loadImages("invalid");}catch(e){failures++;}
try{layer.loadProvinceImage("plain");}catch(e){failures++;}
var failureState=failures==3 && layer.clipLeft==0 && layer.getProvincePixel(1,0)==0 && layer.getMainPixel(0,0)==0xc86432 && layer.getMaskPixel(0,0)==64 && layer.getMaskPixel(1,0)==128 && layer.imageModified;
layer.loadImages("plain");var cleared=layer.getProvincePixel(1,0)==0 && layer.getMaskPixel(0,0)==64 && layer.clipLeft==0;
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate('loaded && tiled && province && failureState && cleared'),
      '1',
    )
  } finally {
    await session.stop()
  }
})

test('explicit mask extensions take precedence and color matting follows mask replacement', async () => {
  const { session } = await headless({
    'scene.bmp': encodeBmp({
      width: 2,
      height: 1,
      data: new Uint8Array([200, 100, 50, 64, 201, 101, 51, 128]),
    }),
    'scene_m.bmp': encodeBmp({
      width: 2,
      height: 1,
      data: new Uint8Array([64, 64, 64, 255, 255, 255, 255, 255]),
    }),
    'scene_m.png': imageFixture('mask.png'),
    'startup.tjs': String.raw`
var window=new Window(),layer=new Layer(window,null);layer.loadImages("scene.bmp");
var preferred=layer.getMaskPixel(0,0)==64 && layer.getMaskPixel(1,0)==255;
layer.loadImages("scene",clAlphaMat+0xffffff);
var matted=layer.getMainPixel(0,0)==0xffffff && layer.getMainPixel(1,0)==0xe4b299 && layer.getMaskPixel(1,0)==255;
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('preferred && matted'), '1')
  } finally {
    await session.stop()
  }
})

test('image loading can pause and cancel while preparing a companion without committing pixels', async () => {
  let signal = () => {},
    release = () => {},
    held = false,
    ticks = 0
  const entered = new Promise<void>((resolve) => {
    signal = resolve
  })
  const { session, logs } = await headless(
    {
      'hero.bmp': encodeBmp({
        width: 2,
        height: 1,
        data: new Uint8Array([200, 100, 50, 255, 201, 101, 51, 255]),
      }),
      'hero_m.png': imageFixture('mask.png'),
      'startup.tjs':
        'var window=new Window(),layer=new Layer(window,null);Debug.message("load-start");layer.loadImages("hero.bmp");Debug.message("load-finished");',
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
    assert.ok(logs.includes('load-start'))
    session.pause()
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(logs.includes('load-finished'), false)
    const results = await Promise.allSettled([started, session.stop()])
    assert.equal(results[1]!.status, 'fulfilled')
    assert.equal(logs.includes('load-finished'), false)
  } finally {
    await session.stop()
  }
})

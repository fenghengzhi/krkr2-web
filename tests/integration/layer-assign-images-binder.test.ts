import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'

interface Frame {
  layers: FrameLayer[]
  width: number
  height: number
}

// Replay the renderer's nearest-sampled, source-over Frame contract. Expected
// scene colors below are independent of the composer's grouping decisions.
function render(frame: Frame): number[] {
  const output = new Uint8Array(frame.width * frame.height * 4)
  for (let at = 0; at < output.length; at += 4) output.set([8, 10, 15, 255], at)
  for (const layer of frame.layers) {
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const px = x + 0.5,
          py = y + 0.5
        if (
          px < layer.x ||
          py < layer.y ||
          px >= layer.x + layer.width ||
          py >= layer.y + layer.height ||
          px < layer.clip.x ||
          py < layer.clip.y ||
          px >= layer.clip.x + layer.clip.width ||
          py >= layer.clip.y + layer.clip.height
        )
          continue
        const sx = Math.max(
            0,
            Math.min(
              layer.pixels.width - 1,
              Math.floor(layer.source.x + ((px - layer.x) * layer.source.width) / layer.width),
            ),
          ),
          sy = Math.max(
            0,
            Math.min(
              layer.pixels.height - 1,
              Math.floor(layer.source.y + ((py - layer.y) * layer.source.height) / layer.height),
            ),
          ),
          from = (sy * layer.pixels.width + sx) * 4,
          at = (y * frame.width + x) * 4,
          alpha = (layer.type === 1 ? 1 : layer.pixels.data[from + 3]! / 255) * layer.opacity,
          factor = layer.type === 12 ? layer.opacity : alpha
        for (let channel = 0; channel < 3; channel++)
          output[at + channel] = Math.min(
            255,
            Math.round(
              layer.pixels.data[from + channel]! * factor + output[at + channel]! * (1 - alpha),
            ),
          )
        output[at + 3] = Math.round(255 * alpha + output[at + 3]! * (1 - alpha))
      }
    }
  }
  return [...output]
}

const rgba = (colors: number[]) =>
  colors.flatMap((color) => [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, 255])

async function fixture(binary: boolean, body: string) {
  const frames: Frame[] = [],
    { session } = await headless(
      {
        'startup.tjs': '',
        'assign-images-binder.tjs': String.raw`
var win=new Window();win.visible=true;win.setInnerSize(6,2);
var root=new Layer(win,null);root.setImageSize(6,2);root.setSize(6,2);root.fillRect(0,0,6,2,0xff000000);
var source=new Layer(win,root);source.setImageSize(2,2);source.setSize(2,2);source.fillRect(0,0,2,2,0xffc00000);
var saved=new Layer(win,root);saved.setImageSize(6,2);saved.setSize(6,2);
var snapshotColors="";
function capture(){
  saved.piledCopy(0,0,root,0,0,6,2);
  var colors=[];for(var y=0;y<2;y++)for(var x=0;x<6;x++)colors.add(saved.getMainPixel(x,y));
  snapshotColors=colors.join(",");
}
${body}
`,
      },
      {
        renderer: {
          present(layers, width, height) {
            frames.push({
              width,
              height,
              layers: layers.map((layer) => ({
                ...layer,
                clip: { ...layer.clip },
                source: { ...layer.source },
                pixels: { ...layer.pixels, data: layer.pixels.data.slice() },
              })),
            })
          },
          dispose() {},
        },
      },
    )
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("assign-images-binder.tjs","savedata/assign-images-binder.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/assign-images-binder.cjs")')
    } else await session.evaluate('Scripts.execStorage("assign-images-binder.tjs")')
    await session.idle()
    return {
      session,
      async execute(expression: string) {
        await session.evaluate(expression)
        await session.idle()
      },
      async expectPixels(colors: number[]) {
        const frame = frames.at(-1)
        assert(frame, 'Expected a presented scene frame')
        assert.equal(frame.width, 6)
        assert.equal(frame.height, 2)
        assert.equal(colors.length, 12)
        assert.deepEqual(render(frame), rgba(colors), 'Presented Frame pixels')
        assert.equal(
          await session.evaluate('snapshotColors'),
          colors.join(','),
          'Ancestor piledCopy RGB',
        )
      },
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

const sparseBinderSetup = String.raw`
source.setImageSize(3,2);source.setSize(3,2);source.fillRect(0,0,3,2,0x7f0000ff);
var sparseBinder=new Layer(win,root);sparseBinder.type=ltBinder;sparseBinder.setSize(3,2);sparseBinder.left=1;
sparseBinder.assignImages(source);sparseBinder.visible=true;
var sparseCopy=new Layer(win,root);sparseCopy.setImageSize(3,2);sparseCopy.setSize(3,2);
var sparsePixels="";
function captureSparse(){
  sparseCopy.piledCopy(0,0,sparseBinder,0,0,3,2);
  var result=[];for(var y=0;y<2;y++)for(var x=0;x<3;x++){
    result.add(sparseCopy.getMainPixel(x,y));result.add(sparseCopy.getMaskPixel(x,y));
  }
  sparsePixels=result.join(",");capture();
}
`

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  for (const type of ['ltBinder', 'ltEffect', 'ltFilter']) {
    test(`${mode}: ${type} keeps assigned pixels out of normal frames and ancestor snapshots`, async () => {
      const { session, execute, expectPixels, stop } = await fixture(
        binary,
        String.raw`
var binder=new Layer(win,root);binder.type=${type};binder.setSize(2,2);binder.setPos(1,0);
binder.assignImages(source);binder.visible=true;
var stored=binder.hasImage && binder.type==${type} && binder.opacity==255 && binder.getMainPixel(0,0)==0xc00000 && binder.getMaskPixel(0,0)==255;
capture();
function changeStoredPixels(){
  binder.face=dfAlpha;binder.fillRect(0,0,2,2,0xff0000c0);capture();
}
`,
      )
      try {
        assert.equal(await session.evaluate('stored'), '1')
        await expectPixels(Array<number>(12).fill(0))
        await execute('changeStoredPixels()')
        assert.equal(await session.evaluate('binder.getMainPixel(0,0)'), '192')
        await expectPixels(Array<number>(12).fill(0))
      } finally {
        await stop()
      }
    })
  }

  test(`${mode}: binder children preserve position bounds and their own opacity after image assignment`, async () => {
    const { session, execute, expectPixels, stop } = await fixture(
      binary,
      String.raw`
source.setImageSize(3,2);source.setSize(3,2);source.fillRect(0,0,3,2,0xffc00000);
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(3,2);binder.setPos(1,0);
binder.assignImages(source);binder.visible=true;binder.setClip(2,1,0,0);
var green=new Layer(win,binder);green.type=ltOpaque;green.setImageSize(2,2);green.setSize(2,2);
green.fillRect(0,0,2,2,0xff008000);green.left=-1;green.visible=true;green.setClip(0,0,0,0);
var blue=new Layer(win,binder);blue.type=ltOpaque;blue.setImageSize(1,2);blue.setSize(1,2);
blue.fillRect(0,0,1,2,0xff000080);blue.left=2;blue.opacity=128;blue.visible=true;
var retained=binder.hasImage && binder.opacity==255 && binder.width==3 && binder.height==2 && green.left==-1 && blue.left==2 && blue.opacity==128;
capture();
function halfBinder(){binder.opacity=128;capture();}
function dimChild(){green.opacity=128;capture();}
function hideBinder(){binder.opacity=0;capture();}
function showBinder(){binder.opacity=255;green.opacity=255;capture();}
`,
    )
    try {
      const initial = [0, 0x008000, 0, 0x000040, 0, 0, 0, 0x008000, 0, 0x000040, 0, 0],
        dimmed = [0, 0x004000, 0, 0x000040, 0, 0, 0, 0x004000, 0, 0x000040, 0, 0]
      assert.equal(await session.evaluate('retained'), '1')
      await expectPixels(initial)
      await execute('halfBinder()')
      await expectPixels(initial)
      await execute('dimChild()')
      await expectPixels(dimmed)
      await execute('hideBinder()')
      await expectPixels(Array<number>(12).fill(0))
      await execute('showBinder()')
      await expectPixels(initial)
    } finally {
      await stop()
    }
  })

  test(`${mode}: destination-dependent children blend through an assigned binder against the ancestor image`, async () => {
    const { execute, expectPixels, stop } = await fixture(
      binary,
      String.raw`
source.setImageSize(3,2);source.setSize(3,2);source.fillRect(0,0,3,2,0xffc00000);
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(3,2);binder.setPos(1,0);
binder.assignImages(source);binder.visible=true;
var child=new Layer(win,binder);child.type=ltAdditive;child.setImageSize(1,2);child.setSize(1,2);
child.fillRect(0,0,1,2,0xff008000);child.left=2;child.visible=true;
capture();
function changeStoredPixels(){binder.face=dfAlpha;binder.fillRect(0,0,3,2,0xff0000c0);capture();}
function halfBinder(){binder.opacity=128;capture();}
`,
    )
    try {
      const colors = [0, 0, 0, 0x008000, 0, 0, 0, 0, 0, 0x008000, 0, 0]
      await expectPixels(colors)
      await execute('changeStoredPixels()')
      await expectPixels(colors)
      await execute('halfBinder()')
      await expectPixels(colors)
    } finally {
      await stop()
    }
  })

  test(`${mode}: ordinary alpha and opaque layers display the same assigned image that a binder hides`, async () => {
    const { session, expectPixels, stop } = await fixture(
      binary,
      String.raw`
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(2,2);binder.assignImages(source);binder.visible=true;
var alpha=new Layer(win,root);alpha.type=ltAlpha;alpha.setSize(2,2);alpha.left=2;alpha.assignImages(source);alpha.visible=true;
var opaque=new Layer(win,root);opaque.type=ltOpaque;opaque.setSize(2,2);opaque.left=4;opaque.assignImages(source);opaque.visible=true;
var stored=binder.getMainPixel(0,0)==alpha.getMainPixel(0,0) && alpha.getMainPixel(0,0)==opaque.getMainPixel(0,0) && binder.getMaskPixel(0,0)==255;
capture();
`,
    )
    try {
      assert.equal(await session.evaluate('stored'), '1')
      await expectPixels([
        0, 0, 0xc00000, 0xc00000, 0xc00000, 0xc00000, 0, 0, 0xc00000, 0xc00000, 0xc00000, 0xc00000,
      ])
    } finally {
      await stop()
    }
  })

  test(`${mode}: directly copying a binder preserves its own image and raw child pixels while ancestor rendering blends the child`, async () => {
    const { session, execute, expectPixels, stop } = await fixture(
      binary,
      String.raw`
source.fillRect(0,0,2,2,0x7f0000ff);
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(2,2);
binder.assignImages(source);binder.visible=true;binder.opacity=128;
var red=new Layer(win,binder);red.setImageSize(1,1);red.setSize(1,1);
red.fillRect(0,0,1,1,0x40ff0000);red.opacity=128;red.visible=true;
var direct=new Layer(win,root);direct.setImageSize(2,2);direct.setSize(2,2);
var rawPixels="";
function copyBinder(){
  direct.piledCopy(0,0,binder,0,0,2,2);
  rawPixels=[direct.getMainPixel(0,0),direct.getMaskPixel(0,0),
    direct.getMainPixel(1,0),direct.getMaskPixel(1,0)].join(",");
}
copyBinder();capture();
function hideBinder(){binder.opacity=0;binder.visible=false;copyBinder();capture();}
function hideChild(){red.opacity=0;copyBinder();capture();}
`,
    )
    try {
      assert.equal(await session.evaluate('rawPixels'), '16711680,64,255,127')
      await expectPixels([0x200000, ...Array<number>(11).fill(0)])
      await execute('hideBinder()')
      assert.equal(await session.evaluate('rawPixels'), '16711680,64,255,127')
      await expectPixels(Array<number>(12).fill(0))
      // No seen child and an exact image viewport take native Complete's raw
      // MainImage fast path, even though the source binder itself is hidden.
      await execute('hideChild()')
      assert.equal(await session.evaluate('rawPixels'), '255,127,255,127')
      await expectPixels(Array<number>(12).fill(0))
    } finally {
      await stop()
    }
  })

  test(`${mode}: a cropped direct binder snapshot reads stored image offsets without exposing that image to its ancestor`, async () => {
    const { session, expectPixels, stop } = await fixture(
      binary,
      String.raw`
source.fillRect(0,0,2,2,0x7f112233);source.setMainPixel(1,1,0xabcdef);source.setMaskPixel(1,1,99);
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(2,2);
binder.assignImages(source);binder.setSize(1,1);binder.setImagePos(-1,-1);binder.visible=true;
var direct=new Layer(win,root);direct.setImageSize(1,1);direct.setSize(1,1);
direct.piledCopy(0,0,binder,0,0,1,1);
var cropped=direct.getMainPixel(0,0)+","+direct.getMaskPixel(0,0);
capture();
`,
    )
    try {
      assert.equal(await session.evaluate('cropped'), '11259375,99')
      await expectPixels(Array<number>(12).fill(0))
    } finally {
      await stop()
    }
  })

  test(`${mode}: nested binders keep raw completion separate from ancestor pass-through`, async () => {
    const { session, expectPixels, stop } = await fixture(
      binary,
      String.raw`
source.setImageSize(3,2);source.setSize(3,2);source.fillRect(0,0,3,2,0x7f0000ff);
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(3,2);binder.left=1;
binder.assignImages(source);binder.visible=true;binder.opacity=1;
var green=new Layer(win,root);green.setImageSize(2,2);green.setSize(2,2);green.fillRect(0,0,2,2,0x5a00ff00);
var nested=new Layer(win,binder);nested.type=ltBinder;nested.setSize(2,2);nested.left=1;
nested.assignImages(green);nested.opacity=128;nested.visible=true;
var red=new Layer(win,nested);red.setImageSize(1,1);red.setSize(1,1);
red.fillRect(0,0,1,1,0x40ff0000);red.opacity=128;red.visible=true;
var direct=new Layer(win,root);direct.setImageSize(3,2);direct.setSize(3,2);
direct.piledCopy(0,0,binder,0,0,3,2);
var raw=[];for(var y=0;y<2;y++)for(var x=0;x<3;x++){
  raw.add(direct.getMainPixel(x,y));raw.add(direct.getMaskPixel(x,y));
}
var rawPixels=raw.join(",");capture();
`,
    )
    try {
      assert.equal(
        await session.evaluate('rawPixels'),
        '255,127,16711680,64,65280,90,255,127,65280,90,65280,90',
      )
      await expectPixels([0, 0, 0x200000, ...Array<number>(9).fill(0)])
    } finally {
      await stop()
    }
  })

  test(`${mode}: an uncached empty alpha child emits no raw binder pixels while its cache emits transparent white`, async () => {
    const { session, execute, expectPixels, stop } = await fixture(
      binary,
      String.raw`
${sparseBinderSetup}
var sparseEmpty=new Layer(win,sparseBinder);sparseEmpty.type=ltAlpha;
sparseEmpty.setSize(1,1);sparseEmpty.left=1;sparseEmpty.hasImage=false;sparseEmpty.cached=false;sparseEmpty.visible=true;
captureSparse();
function cacheSparseEmpty(enabled){sparseEmpty.cached=enabled;captureSparse();}
`,
    )
    try {
      const blue = Array(6).fill('255,127').join(',')
      assert.equal(await session.evaluate('sparsePixels'), blue)
      await expectPixels(Array<number>(12).fill(0))
      await execute('cacheSparseEmpty(true)')
      assert.equal(
        await session.evaluate('sparsePixels'),
        '255,127,16777215,0,255,127,255,127,255,127,255,127',
      )
      await expectPixels(Array<number>(12).fill(0))
      await execute('cacheSparseEmpty(false)')
      assert.equal(await session.evaluate('sparsePixels'), blue)
      await expectPixels(Array<number>(12).fill(0))
    } finally {
      await stop()
    }
  })

  test(`${mode}: an image-less nested binder forwards only its grandchild coverage during raw completion`, async () => {
    const { session, expectPixels, stop } = await fixture(
      binary,
      String.raw`
${sparseBinderSetup}
var sparseNested=new Layer(win,sparseBinder);sparseNested.type=ltBinder;
sparseNested.setSize(2,2);sparseNested.left=1;sparseNested.visible=true;sparseNested.cached=false;
var sparseRed=new Layer(win,sparseNested);sparseRed.type=ltAlpha;sparseRed.setImageSize(1,1);sparseRed.setSize(1,1);
sparseRed.fillRect(0,0,1,1,0x40ff0000);sparseRed.opacity=128;sparseRed.visible=true;
captureSparse();
`,
    )
    try {
      assert.equal(await session.evaluate('int(sparseNested.hasImage)'), '0')
      assert.equal(
        await session.evaluate('sparsePixels'),
        '255,127,16711680,64,255,127,255,127,255,127,255,127',
      )
      await expectPixels([0, 0, 0x200000, ...Array<number>(9).fill(0)])
    } finally {
      await stop()
    }
  })

  test(`${mode}: a nested binder exposes its main image only outside an empty child's covered rectangle`, async () => {
    const { session, expectPixels, stop } = await fixture(
      binary,
      String.raw`
${sparseBinderSetup}
var sparseGreen=new Layer(win,root);sparseGreen.setImageSize(2,2);sparseGreen.setSize(2,2);sparseGreen.fillRect(0,0,2,2,0x5a00ff00);
var sparseNested=new Layer(win,sparseBinder);sparseNested.type=ltBinder;sparseNested.setSize(2,2);sparseNested.left=1;
sparseNested.assignImages(sparseGreen);sparseNested.visible=true;sparseNested.cached=false;
var sparseEmpty=new Layer(win,sparseNested);sparseEmpty.type=ltAlpha;
sparseEmpty.setSize(1,1);sparseEmpty.hasImage=false;sparseEmpty.cached=false;sparseEmpty.visible=true;
captureSparse();
`,
    )
    try {
      assert.equal(
        await session.evaluate('sparsePixels'),
        '255,127,255,127,65280,90,255,127,65280,90,65280,90',
      )
      await expectPixels(Array<number>(12).fill(0))
    } finally {
      await stop()
    }
  })

  test(`${mode}: a cached nested binder sends its stored cache after forwarding its child during raw completion`, async () => {
    const { session, execute, expectPixels, stop } = await fixture(
      binary,
      String.raw`
${sparseBinderSetup}
var sparseGreen=new Layer(win,root);sparseGreen.setImageSize(2,2);sparseGreen.setSize(2,2);sparseGreen.fillRect(0,0,2,2,0x5a00ff00);
var sparseNested=new Layer(win,sparseBinder);sparseNested.type=ltBinder;sparseNested.setSize(2,2);sparseNested.left=1;
sparseNested.assignImages(sparseGreen);sparseNested.opacity=128;sparseNested.visible=true;sparseNested.cached=false;
var sparseRed=new Layer(win,sparseNested);sparseRed.type=ltAlpha;sparseRed.setImageSize(1,1);sparseRed.setSize(1,1);
sparseRed.fillRect(0,0,1,1,0x40ff0000);sparseRed.opacity=128;sparseRed.visible=true;
function rebuildSparseNested(){
  sparseNested.update();
  sparseCopy.piledCopy(0,0,sparseBinder,0,0,3,2);
  var result=[];for(var y=0;y<2;y++)for(var x=0;x<3;x++){
    result.add(sparseCopy.getMainPixel(x,y));result.add(sparseCopy.getMaskPixel(x,y));
  }
  sparsePixels=result.join(",");
  sparseNested.update();capture();
}
rebuildSparseNested();
function cacheSparseNested(enabled){sparseNested.cached=enabled;rebuildSparseNested();}
`,
    )
    try {
      // Each sink receives a fresh rebuild: a native warm cache need not
      // forward the red child again. This case does not specify that history.
      const uncached = '255,127,16711680,64,65280,90,255,127,65280,90,65280,90',
        ancestor = [0, 0, 0x200000, ...Array<number>(9).fill(0)]
      assert.equal(await session.evaluate('sparsePixels'), uncached)
      await expectPixels(ancestor)
      await execute('cacheSparseNested(true)')
      assert.equal(
        await session.evaluate('sparsePixels'),
        '255,127,65280,90,65280,90,255,127,65280,90,65280,90',
      )
      await expectPixels(ancestor)
      await execute('cacheSparseNested(false)')
      assert.equal(await session.evaluate('sparsePixels'), uncached)
      await expectPixels(ancestor)
    } finally {
      await stop()
    }
  })

  for (const entry of [
    {
      title: 'an opaque child borrowing its alpha parent bitmap preserves its raw mask',
      imageLess: false,
      expected: '16711680,64',
      following: '',
    },
    {
      title:
        'an image-less cached alpha parent fills borrowed but unreported pixels with transparent white',
      imageLess: true,
      expected: '16777215,0',
      following: '',
    },
    {
      title: 'a later alpha sibling clears unreported borrowed pixels before its first blend',
      imageLess: true,
      expected: '255,32',
      following: String.raw`
var borrowedSibling=new Layer(win,borrowedParent);borrowedSibling.type=ltAlpha;
borrowedSibling.setImageSize(1,1);borrowedSibling.setSize(1,1);borrowedSibling.fillRect(0,0,1,1,0x400000ff);
borrowedSibling.opacity=128;borrowedSibling.cached=false;borrowedSibling.visible=true;
`,
    },
    {
      title:
        'a later cached binder sibling clears unreported borrowed pixels even though its blend is skipped',
      imageLess: true,
      expected: '16777215,0',
      following: String.raw`
source.fillRect(0,0,1,1,0x5a00ff00);
var borrowedSibling=new Layer(win,borrowedParent);borrowedSibling.type=ltBinder;borrowedSibling.setSize(1,1);
borrowedSibling.assignImages(source);borrowedSibling.opacity=255;borrowedSibling.cached=true;borrowedSibling.visible=true;
`,
    },
  ]) {
    test(`${mode}: ${entry.title}`, async () => {
      const { session, stop } = await fixture(
        binary,
        String.raw`
source.setImageSize(1,1);source.setSize(1,1);source.fillRect(0,0,1,1,0x7f0000ff);
var borrowedBinder=new Layer(win,root);borrowedBinder.type=ltBinder;borrowedBinder.setSize(1,1);
borrowedBinder.assignImages(source);borrowedBinder.opacity=255;borrowedBinder.cached=false;
var borrowedParent=new Layer(win,borrowedBinder);borrowedParent.type=ltAlpha;
borrowedParent.setImageSize(1,1);borrowedParent.setSize(1,1);borrowedParent.fillRect(0,0,1,1,0x5a00ff00);
borrowedParent.opacity=255;borrowedParent.visible=true;
${entry.imageLess ? 'borrowedParent.hasImage=false;borrowedParent.cached=true;' : 'borrowedParent.cached=false;'}
var borrowedOpaque=new Layer(win,borrowedParent);borrowedOpaque.type=ltOpaque;
borrowedOpaque.setImageSize(1,1);borrowedOpaque.setSize(1,1);borrowedOpaque.holdAlpha=false;
borrowedOpaque.fillRect(0,0,1,1,0x40ff0000);borrowedOpaque.opacity=255;borrowedOpaque.cached=false;borrowedOpaque.visible=true;
var borrowedEmpty=new Layer(win,borrowedOpaque);borrowedEmpty.type=ltAlpha;borrowedEmpty.setSize(1,1);
borrowedEmpty.hasImage=false;borrowedEmpty.opacity=255;borrowedEmpty.cached=false;borrowedEmpty.visible=true;
${entry.following}
var borrowedCopy=new Layer(win,root);borrowedCopy.setImageSize(1,1);borrowedCopy.setSize(1,1);
borrowedParent.update();borrowedCopy.piledCopy(0,0,borrowedBinder,0,0,1,1);
var borrowedRaw=borrowedCopy.getMainPixel(0,0)+","+borrowedCopy.getMaskPixel(0,0);
var originalMask=borrowedOpaque.getMaskPixel(0,0),parentHasImage=int(borrowedParent.hasImage);
`,
      )
      try {
        // Only direct Complete is observed. The normal ancestor composer's
        // separate opaque-target optimization is outside these regressions.
        assert.equal(await session.evaluate('borrowedRaw'), entry.expected)
        assert.equal(await session.evaluate('originalMask'), '64')
        assert.equal(await session.evaluate('parentHasImage'), entry.imageLess ? '0' : '1')
      } finally {
        await stop()
      }
    })
  }
}

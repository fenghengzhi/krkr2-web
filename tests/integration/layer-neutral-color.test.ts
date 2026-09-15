import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

async function fixture(binary: boolean, body: string) {
  const harness = await headless({
    'startup.tjs': '',
    'neutral-color.tjs': String.raw`
var win=new Window(),root=new Layer(win,null),layer=new Layer(win,root);
${body}
`,
  })
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("neutral-color.tjs","savedata/neutral-color.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/neutral-color.cjs")')
    } else await session.evaluate('Scripts.execStorage("neutral-color.tjs")')
    return {
      ...harness,
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

  test(`${mode}: neutralColor is an unsigned per-instance value independent of the initial bitmap`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var initial=root.neutralColor+","+layer.neutralColor+","+root.getMaskPixel(0,0)+","+layer.getMaskPixel(0,0);
layer.setClip(1,2,3,4);layer.imageModified=false;
layer.neutralColor=0x12345678abcdef01;
var wide=layer.neutralColor;
var preserved=!layer.imageModified && layer.getMainPixel(0,0)==0xffffff && layer.getMaskPixel(0,0)==0 && layer.clipLeft==1 && layer.clipTop==2 && layer.clipWidth==3 && layer.clipHeight==4;
var independent=root.neutralColor==0xffffffff;
layer.neutralColor=-1;var negative=layer.neutralColor;
layer.neutralColor=0x100000001;var wrapped=layer.neutralColor;
root.setImageSize(33,32);
var primaryGrowth=root.getMaskPixel(0,0)+","+root.getMaskPixel(32,0)+","+root.getMainPixel(32,0);
`,
    )
    try {
      assert.equal(await session.evaluate('initial'), '4294967295,16777215,0,0')
      assert.equal(
        await session.evaluate('wide+","+negative+","+wrapped'),
        '2882400001,4294967295,1',
      )
      assert.equal(await session.evaluate('preserved && independent'), '1')
      assert.equal(await session.evaluate('primaryGrowth'), '0,255,16777215')
      await session.evaluate(
        'Scripts.exec("var neutralPaints=0;root.onPaint=function(){neutralPaints++;};root.update(0,0,0,1);root.neutralColor=0xff224466;")',
      )
      assert.equal(await session.evaluate('neutralPaints+","+int(root.callOnPaint)'), '0,1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: image expansion fills only new pixels and leaves the new province plane zero`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setImageSize(2,1);layer.fillRect(0,0,2,1,0x49102030);layer.setProvincePixel(0,0,19);layer.setProvincePixel(1,0,23);
layer.setClip(0,0,1,1);layer.neutralColor=0x81234567;layer.holdAlpha=true;layer.face=dfProvince;layer.imageModified=false;
layer.setImageSize(3,2);
var oldPixels=layer.getMainPixel(0,0)+","+layer.getMaskPixel(0,0)+","+layer.getMainPixel(1,0)+","+layer.getMaskPixel(1,0);
var newPixels=layer.getMainPixel(2,0)+","+layer.getMaskPixel(2,0)+","+layer.getMainPixel(0,1)+","+layer.getMaskPixel(0,1);
var province=layer.getProvincePixel(0,0)+","+layer.getProvincePixel(1,0)+","+layer.getProvincePixel(2,0)+","+layer.getProvincePixel(0,1);
var clipReset=layer.clipLeft==0 && layer.clipTop==0 && layer.clipWidth==3 && layer.clipHeight==2 && layer.imageModified;
`,
    )
    try {
      assert.equal(await session.evaluate('oldPixels'), '1056816,73,1056816,73')
      assert.equal(await session.evaluate('newPixels'), '2311527,129,2311527,129')
      assert.equal(await session.evaluate('province'), '19,23,0,0')
      assert.equal(await session.evaluate('clipReset'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: display growth and image recreation use the destination's override`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setImageSize(1,1);layer.fillRect(0,0,1,1,0x55112233);layer.setProvincePixel(0,0,77);
layer.neutralColor=0x66123456;layer.setSize(2,2);
var grown=layer.getMainPixel(0,0)==0x112233 && layer.getMaskPixel(0,0)==85 && layer.getMainPixel(1,1)==0x123456 && layer.getMaskPixel(1,1)==102 && layer.getProvincePixel(1,1)==0;
layer.hasImage=false;layer.neutralColor=0x77445566;layer.hasImage=true;
var recreated=layer.imageWidth==2 && layer.imageHeight==2 && layer.getMainPixel(0,0)==0x445566 && layer.getMaskPixel(0,0)==119 && layer.getMainPixel(1,1)==0x445566 && layer.getProvincePixel(0,0)==0;
`,
    )
    try {
      assert.equal(await session.evaluate('grown && recreated'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: actual type changes reset the default while a same-type write preserves the override`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setImageSize(1,1);layer.fillRect(0,0,1,1,0x80112233);layer.neutralColor=0x99334455;layer.imageModified=false;
layer.type=layer.type;
var same=layer.neutralColor==0x99334455 && !layer.imageModified && layer.getMainPixel(0,0)==0x112233 && layer.getMaskPixel(0,0)==128;
layer.hasImage=false;layer.imageModified=false;layer.type=layer.type;
var absent=!layer.hasImage && !layer.imageModified && layer.neutralColor==0x99334455;
layer.hasImage=true;var allocation=layer.getMainPixel(0,0)==0x334455 && layer.getMaskPixel(0,0)==153;
var colors=[];
layer.type=ltAdditive;colors.add(layer.neutralColor);
layer.neutralColor=0xff123456;layer.type=ltPsOverlay;colors.add(layer.neutralColor);
layer.neutralColor=0xff123456;layer.type=ltBinder;colors.add(layer.neutralColor);
layer.neutralColor=0xff123456;layer.type=ltOpaque;colors.add(layer.neutralColor);
var resetPixels=layer.getMainPixel(0,0)==0xffffff && layer.getMaskPixel(0,0)==0;
layer.neutralColor=0x81223344;var rejected=0;try{layer.type=999;}catch(error){rejected++;}
var unchangedAfterError=rejected==1 && layer.type==ltOpaque && layer.neutralColor==0x81223344;
`,
    )
    try {
      assert.equal(
        await session.evaluate(
          'same && absent && allocation && resetPixels && unchangedAfterError',
        ),
        '1',
      )
      assert.equal(await session.evaluate('colors.join(",")'), '0,8421504,16777215,16777215')
    } finally {
      await stop()
    }
  })

  test(`${mode}: affine clear uses the instance RGBA while honoring clip, holdAlpha and province`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.setImageSize(1,1);source.fillRect(0,0,1,1,0x80abcdef);
layer.setImageSize(4,1);layer.fillRect(0,0,4,1,0x49112233);layer.setProvincePixel(1,0,17);layer.setProvincePixel(2,0,18);
layer.neutralColor=0x99123456;layer.setClip(1,0,2,1);layer.face=dfAlpha;
layer.affineCopy(source,0,0,1,1,true,1,0,0,1,2,0,stNearest,true);
var alpha=layer.getMainPixel(0,0)==0x112233 && layer.getMaskPixel(0,0)==73 && layer.getMainPixel(1,0)==0x123456 && layer.getMaskPixel(1,0)==153 && layer.getMainPixel(2,0)==0xabcdef && layer.getMaskPixel(2,0)==128;
var province=layer.getProvincePixel(1,0)==17 && layer.getProvincePixel(2,0)==18;
layer.face=dfOpaque;layer.holdAlpha=false;layer.setClip(0,0,4,1);layer.fillRect(0,0,4,1,0x49112233);layer.setClip(1,0,2,1);layer.holdAlpha=true;
layer.neutralColor=0xcc654321;layer.affineCopy(source,0,0,1,1,true,1,0,0,1,2,0,stNearest,true);
var held=layer.getMainPixel(1,0)==0x654321 && layer.getMaskPixel(1,0)==73 && layer.getMainPixel(2,0)==0xabcdef && layer.getMaskPixel(2,0)==73 && layer.getMainPixel(3,0)==0x112233;
layer.face=dfAddAlpha;layer.holdAlpha=true;layer.neutralColor=0x77332211;
layer.affineCopy(source,0,0,1,1,true,1,0,0,1,2,0,stNearest,true);
var additive=layer.getMainPixel(1,0)==0x332211 && layer.getMaskPixel(1,0)==119 && layer.getMainPixel(2,0)==0xabcdef && layer.getMaskPixel(2,0)==128;
`,
    )
    try {
      assert.equal(await session.evaluate('alpha && held && additive && province'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assigning images copies pixel data without copying the source neutralColor`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.setImageSize(1,1);source.fillRect(0,0,1,1,0x40111213);source.setProvincePixel(0,0,33);source.neutralColor=0xffabcdef;
layer.neutralColor=0x88123456;layer.assignImages(source);
var copied=layer.neutralColor==0x88123456 && layer.getMainPixel(0,0)==0x111213 && layer.getMaskPixel(0,0)==64 && layer.getProvincePixel(0,0)==33;
layer.setSize(2,1);
var ownGrowth=layer.getMainPixel(1,0)==0x123456 && layer.getMaskPixel(1,0)==136 && layer.getProvincePixel(1,0)==0 && source.imageWidth==1;
`,
    )
    try {
      assert.equal(await session.evaluate('copied && ownGrowth'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: a user neutralColor does not turn a transparent composition backing opaque`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
root.setSize(2,1);root.fillRect(0,0,2,1,0xff102030);
layer.setSize(2,1);layer.hasImage=false;layer.visible=true;layer.opacity=128;layer.neutralColor=0xff00ff00;
var child=new Layer(win,layer);child.setImageSize(2,1);child.type=ltPsNormal;child.visible=true;child.fillRect(0,0,2,1,0x00000000);
var snapshot=new Layer(win,root);snapshot.setImageSize(2,1);snapshot.piledCopy(0,0,root,0,0,2,1);
`,
    )
    try {
      const pixels = await session.evaluate(
        '[snapshot.getMainPixel(0,0),snapshot.getMaskPixel(0,0),snapshot.getMainPixel(1,0),snapshot.getMaskPixel(1,0)].join(",")',
      )
      // Native alpha-on-opaque with partial opacity writes RGB only, even when
      // source alpha is zero. The opaque display conversion to alpha 255 is
      // separate from the raw image planes returned by piledCopy.
      assert.equal(pixels, '1056816,0,1056816,0', `raw snapshot RGB/mask: ${pixels}`)
    } finally {
      await stop()
    }
  })
}

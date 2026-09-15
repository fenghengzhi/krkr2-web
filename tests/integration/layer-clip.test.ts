import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const originalPixels = '1056816,73,19,1056816,73,0,11259375,87,23'

async function fixture(binary: boolean, body: string) {
  const harness = await headless({
    'startup.tjs': '',
    'layer-clip.tjs': String.raw`
var win=new Window(),root=new Layer(win,null),layer=new Layer(win,root);
layer.setSize(2,2);layer.setImageSize(4,3);layer.setImagePos(-1,-1);
layer.fillRect(0,0,4,3,0x49102030);
layer.setProvincePixel(0,0,19);
layer.setMainPixel(3,2,0xabcdef);layer.setMaskPixel(3,2,87);layer.setProvincePixel(3,2,23);
layer.neutralColor=0x81234567;layer.imageModified=false;
function clipState(){return [layer.clipLeft,layer.clipTop,layer.clipWidth,layer.clipHeight].join(",");}
function pixelState(){return [layer.getMainPixel(0,0),layer.getMaskPixel(0,0),layer.getProvincePixel(0,0),layer.getMainPixel(1,1),layer.getMaskPixel(1,1),layer.getProvincePixel(1,1),layer.getMainPixel(3,2),layer.getMaskPixel(3,2),layer.getProvincePixel(3,2)].join(",");}
${body}
`,
  })
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-clip.tjs","savedata/layer-clip.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-clip.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-clip.tjs")')
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

  test(`${mode}: zero-argument setClip restores the full image without changing its planes`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setClip(1,1,1,1);layer.imageModified=false;
layer.setClip();
var resetClip=clipState(),preservedPixels=pixelState();
layer.setClip(2,1,-1,1);layer.setClip();var emptyResetClip=clipState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
var geometry=[layer.width,layer.height,layer.imageWidth,layer.imageHeight,layer.imageLeft,layer.imageTop].join(",");
layer.setMainPixel(3,2,0x445566);layer.setMaskPixel(3,2,105);layer.setProvincePixel(3,2,41);
var writable=[layer.getMainPixel(3,2),layer.getMaskPixel(3,2),layer.getProvincePixel(3,2)].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('resetClip'), '0,0,4,3')
      assert.equal(await session.evaluate('emptyResetClip'), '0,0,4,3')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged'), '1')
      assert.equal(await session.evaluate('geometry'), '2,2,4,3,-1,-1')
      assert.equal(await session.evaluate('writable'), '4478310,105,41')
    } finally {
      await stop()
    }
  })

  test(`${mode}: one through three setClip arguments throw before changing the old clip`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setClip(1,1,2,1);layer.imageModified=false;
var rejected=0,clips=[];
try{layer.setClip(0);}catch(error){rejected++;}clips.add(clipState());
try{layer.setClip(0,0);}catch(error){rejected++;}clips.add(clipState());
try{layer.setClip(0,0,4);}catch(error){rejected++;}clips.add(clipState());
var preservedPixels=pixelState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
`,
    )
    try {
      assert.equal(await session.evaluate('rejected'), '3')
      assert.equal(await session.evaluate('clips.join("|")'), '1,1,2,1|1,1,2,1|1,1,2,1')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: setClip ignores additional arguments and subsequent drawing uses only its rectangle`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setClip(1,0,2,2,"ignored",%[unused:1],null,void);
var selectedClip=clipState(),preservedPixels=pixelState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
layer.fillRect(0,0,4,3,0xcc445566);
var drawnPixels=pixelState();
`,
    )
    try {
      assert.equal(await session.evaluate('selectedClip'), '1,0,2,2')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged'), '1')
      assert.equal(
        await session.evaluate('drawnPixels'),
        '1056816,73,19,4478310,204,0,11259375,87,23',
      )
    } finally {
      await stop()
    }
  })

  test(`${mode}: negative clip dimensions become empty and outside origins remain observable`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var clips=[];
layer.setClip(2,1,-1,1);clips.add(clipState());layer.fillRect(0,0,4,3,0xff000000);
layer.setClip(1,2,2,-1);clips.add(clipState());layer.fillRect(0,0,4,3,0xff000000);
layer.setClip(2,1,-5,-2);clips.add(clipState());layer.fillRect(0,0,4,3,0xff000000);
layer.setClip(9,8,2,3);clips.add(clipState());layer.fillRect(0,0,4,3,0xff000000);
layer.setClip(-2,-1,5,3);clips.add(clipState());
layer.setClip(3,2,9,9);clips.add(clipState());
var preservedPixels=pixelState(),neutralUnchanged=layer.neutralColor==0x81234567;
`,
    )
    try {
      assert.equal(
        await session.evaluate('clips.join("|")'),
        '2,1,0,1|1,2,2,0|2,1,0,0|9,8,0,0|0,0,3,2|3,2,1,1',
      )
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('neutralUnchanged'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: clip properties share empty-region semantics without modifying image planes`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setClip(1,1,2,2);layer.imageModified=false;
var clips=[];
layer.clipWidth=-2;clips.add(clipState());
layer.clipHeight=-1;clips.add(clipState());
layer.clipLeft=9;clips.add(clipState());
layer.clipTop=8;clips.add(clipState());
var preservedPixels=pixelState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
`,
    )
    try {
      assert.equal(await session.evaluate('clips.join("|")'), '1,1,0,2|1,1,0,0|9,1,0,0|9,8,0,0')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: changing drawable layer types resets clip and neutralColor while retaining pixels`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.type=ltAlpha;layer.neutralColor=0x81234567;layer.setClip(1,1,1,1);layer.imageModified=false;
layer.type=ltAddAlpha;
var firstClip=clipState(),firstPixels=pixelState();
var firstReset=layer.neutralColor==0 && layer.imageModified;
layer.neutralColor=0x99123456;layer.setClip(2,1,1,1);layer.imageModified=false;
layer.type=ltPsOverlay;
var secondClip=clipState(),secondPixels=pixelState();
var secondReset=layer.neutralColor==0x808080 && layer.imageModified;
var geometry=[layer.width,layer.height,layer.imageWidth,layer.imageHeight,layer.imageLeft,layer.imageTop].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('firstClip+"|"+secondClip'), '0,0,4,3|0,0,4,3')
      assert.equal(await session.evaluate('firstPixels'), originalPixels)
      assert.equal(await session.evaluate('secondPixels'), originalPixels)
      assert.equal(await session.evaluate('firstReset && secondReset'), '1')
      assert.equal(await session.evaluate('geometry'), '2,2,4,3,-1,-1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: hasImage true resets an existing image clip without refilling or resizing it`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.setClip(1,1,1,1);layer.imageModified=false;
layer.hasImage=true;
var resetClip=clipState(),preservedPixels=pixelState();
var retained=layer.hasImage && layer.imageModified && layer.neutralColor==0x81234567;
var geometry=[layer.width,layer.height,layer.imageWidth,layer.imageHeight,layer.imageLeft,layer.imageTop].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('resetClip'), '0,0,4,3')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('retained'), '1')
      assert.equal(await session.evaluate('geometry'), '2,2,4,3,-1,-1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assigning the same type preserves clip and does not recreate a missing image`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var originalType=layer.type;
layer.setClip(1,1,2,1);layer.imageModified=false;
layer.type=originalType;
var sameClip=clipState(),preservedPixels=pixelState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
layer.hasImage=false;layer.imageModified=false;layer.type=originalType;
var stillAbsent=!layer.hasImage && !layer.imageModified && layer.neutralColor==0x81234567;
`,
    )
    try {
      assert.equal(await session.evaluate('sameClip'), '1,1,2,1')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged && stillAbsent'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: clip arguments and properties use signed low-32-bit TJS integer conversion`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var clips=[];
layer.setClip(0x20000000000001,0x100000001,0x20000000000002,0x20000000000001);clips.add(clipState());
layer.setClip(0x1ffffffff,void,4.9,2.9);clips.add(clipState());
layer.setClip(void,void,void,void);clips.add(clipState());
layer.setClip(0,0,3,2);
layer.clipLeft=0x20000000000001;layer.clipTop=0x100000001;
layer.clipWidth=0x20000000000002;layer.clipHeight=0x1ffffffff;clips.add(clipState());
var preservedPixels=pixelState();
var unchanged=!layer.imageModified && layer.neutralColor==0x81234567;
`,
    )
    try {
      assert.equal(await session.evaluate('clips.join("|")'), '1,1,2,1|0,0,3,2|0,0,0,0|1,1,2,0')
      assert.equal(await session.evaluate('preservedPixels'), originalPixels)
      assert.equal(await session.evaluate('unchanged'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: clip reset and assignment reject a missing main image without allocating one`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.imageModified=false;
var rejected=0;
try{layer.setClip();}catch(error){rejected++;}
try{layer.setClip(0,0,1,1);}catch(error){rejected++;}
var unchanged=!layer.hasImage && !layer.imageModified && layer.neutralColor==0x81234567;
layer.hasImage=true;
var allocatedClip=clipState();
var allocation=layer.imageWidth==2 && layer.imageHeight==2 && layer.imageLeft==0 && layer.imageTop==0 && layer.getMainPixel(0,0)==0x234567 && layer.getMaskPixel(0,0)==129 && layer.getProvincePixel(0,0)==0;
`,
    )
    try {
      assert.equal(await session.evaluate('rejected'), '2')
      assert.equal(await session.evaluate('unchanged && allocation'), '1')
      assert.equal(await session.evaluate('allocatedClip'), '0,0,2,2')
    } finally {
      await stop()
    }
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const sourceMain = [0x112233, 0x445566, 0x778899, 0xaabbcc, 0x010203, 0x040506],
  sourceMask = [17, 34, 51, 68, 85, 102],
  sourceProvince = [3, 0, 7, 0, 9, 11]

function sourcePixels(province = sourceProvince): string {
  return sourceMain.flatMap((main, index) => [main, sourceMask[index], province[index]]).join(',')
}

async function fixture(binary: boolean, body: string, withProvince = true) {
  const { session } = await headless({
    'startup.tjs': '',
    'layer-assign-images.tjs': String.raw`
var win=new Window(),root=new Layer(win,null);
var source=new Layer(win,root),target=new Layer(win,root);
source.setSize(2,1);source.setImageSize(3,2);source.setImagePos(-1,-1);source.setPos(3,5);
target.setSize(4,3);target.setImageSize(6,5);target.setImagePos(-2,-2);target.setPos(17,19);
var main=[0x112233,0x445566,0x778899,0xaabbcc,0x010203,0x040506],
  mask=[17,34,51,68,85,102],province=[3,0,7,0,9,11];
for(var y=0;y<2;y++)for(var x=0;x<3;x++){
  source.setMainPixel(x,y,main[y*3+x]);source.setMaskPixel(x,y,mask[y*3+x]);
  ${withProvince ? 'source.setProvincePixel(x,y,province[y*3+x]);' : ''}
}
target.fillRect(0,0,6,5,0x66102030);
target.setProvincePixel(0,0,17);target.setProvincePixel(5,4,23);
source.neutralColor=0x77112233;target.neutralColor=0x99334455;
source.imageModified=false;target.imageModified=false;
function pixel(layer,x,y){return [layer.getMainPixel(x,y),layer.getMaskPixel(x,y),layer.getProvincePixel(x,y)].join(",");}
function pixels(layer){
  var result=[];
  for(var y=0;y<layer.imageHeight;y++)for(var x=0;x<layer.imageWidth;x++)result.add(pixel(layer,x,y));
  return result.join(",");
}
function clip(layer){return [layer.clipLeft,layer.clipTop,layer.clipWidth,layer.clipHeight].join(",");}
function geometry(layer){return [layer.left,layer.top,layer.width,layer.height,layer.imageWidth,layer.imageHeight,layer.imageLeft,layer.imageTop].join(",");}
${body}
`,
  })
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-assign-images.tjs","savedata/layer-assign-images.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-assign-images.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-assign-images.tjs")')
    return {
      session,
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

  test(`${mode}: assignImages copies image dimensions and all planes while retaining destination state`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.visible=true;source.opacity=241;source.face=dfAlpha;source.holdAlpha=false;source.enabled=true;
source.setClip(1,0,1,1);
target.type=ltAdditive;target.neutralColor=0xa1234567;
target.visible=false;target.opacity=123;target.face=dfMask;target.holdAlpha=true;target.enabled=false;
target.setClip(1,1,1,1);target.imageModified=false;
target.assignImages(source);
var copied=pixels(target),targetGeometry=geometry(target),sourceGeometry=geometry(source);
var targetState=target.type==ltAdditive && target.neutralColor==0xa1234567 && !target.visible && target.opacity==123 && target.face==dfMask && target.holdAlpha && !target.enabled;
var clips=clip(target)+"|"+clip(source),modified=int(target.imageModified)+","+int(source.imageModified);
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), sourcePixels())
      assert.equal(await session.evaluate('targetGeometry'), '17,19,3,2,3,2,0,0')
      assert.equal(await session.evaluate('sourceGeometry'), '3,5,2,1,3,2,-1,-1')
      assert.equal(await session.evaluate('targetState'), '1')
      assert.equal(await session.evaluate('clips'), '0,0,3,2|1,0,1,1')
      assert.equal(await session.evaluate('modified'), '1,0')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assigned image bounds clamp destination offsets without copying source geometry`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.setImagePos(0,0);
target.setSize(2,1);target.setImagePos(-4,-4);
target.assignImages(source);
var clamped=geometry(target),copied=pixels(target);
var small=new Layer(win,root);small.setSize(1,1);small.setImageSize(6,5);small.setImagePos(-1,0);
small.assignImages(source);
var retained=geometry(small),smallPixels=pixels(small);
`,
    )
    try {
      assert.equal(await session.evaluate('clamped'), '17,19,2,1,3,2,-1,-1')
      assert.equal(await session.evaluate('retained'), '0,0,1,1,3,2,-1,0')
      assert.equal(await session.evaluate('copied'), sourcePixels())
      assert.equal(await session.evaluate('smallPixels'), sourcePixels())
    } finally {
      await stop()
    }
  })

  test(`${mode}: self assignImages resets clip and marks the existing image without changing its planes`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.assignImages(source);target.setSize(2,1);target.setImagePos(-1,-1);
target.face=dfMask;target.holdAlpha=true;target.neutralColor=0x99334455;
target.setClip(1,0,1,1);target.imageModified=false;
var before=pixels(target),beforeGeometry=geometry(target);
target.assignImages(target);
var after=pixels(target),afterGeometry=geometry(target),resetClip=clip(target);
var retained=target.imageModified && target.neutralColor==0x99334455 && target.face==dfMask && target.holdAlpha;
`,
    )
    try {
      assert.equal(await session.evaluate('before'), sourcePixels())
      assert.equal(await session.evaluate('after'), sourcePixels())
      assert.equal(await session.evaluate('beforeGeometry'), '17,19,2,1,3,2,-1,-1')
      assert.equal(await session.evaluate('afterGeometry'), '17,19,2,1,3,2,-1,-1')
      assert.equal(await session.evaluate('resetClip'), '0,0,3,2')
      assert.equal(await session.evaluate('retained'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: image-less self assignment still marks modified and retains the old drawing clip`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.face=dfAlpha;target.setClip(1,1,2,1);target.hasImage=false;target.imageModified=false;
target.assignImages(target);
var assigned=!target.hasImage && target.imageModified && target.neutralColor==0x99334455;
target.imageModified=false;var outsideErrors=0,insideErrors=0;
try{target.fillRect(0,0,1,1,0xffabcdef);}catch(error){outsideErrors++;}
try{target.fillRect(1,1,1,1,0xffabcdef);}catch(error){insideErrors++;}
var clipBehavior=outsideErrors+","+insideErrors+","+int(target.imageModified);
var retainedGeometry=[target.left,target.top,target.width,target.height].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('assigned'), '1')
      assert.equal(await session.evaluate('clipBehavior'), '0,1,0')
      assert.equal(await session.evaluate('retainedGeometry'), '17,19,4,3')
    } finally {
      await stop()
    }
  })

  test(`${mode}: self assignment does not flush a pending paint while a different image assignment requests an update`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var paints=0;
target.onPaint=function(){global.paints++;};
function markPaint(){global.target.update(0,0,0,1);}
function assignSelf(){global.target.assignImages(global.target);}
function assignOther(){global.target.assignImages(global.source);}
`,
    )
    try {
      // These functions are compiled with the fixture in bytecode mode. Keep
      // each completion separate from the fixture's initial drawing work.
      await session.evaluate('markPaint()')
      assert.equal(await session.evaluate('paints+","+int(target.callOnPaint)'), '0,1')
      await session.evaluate('assignSelf()')
      assert.equal(await session.evaluate('paints+","+int(target.callOnPaint)'), '0,1')
      await session.evaluate('assignOther()')
      assert.equal(await session.evaluate('paints+","+int(target.callOnPaint)'), '1,0')
    } finally {
      await stop()
    }
  })

  test(`${mode}: an image-less source removes destination images while retaining its clip and allocation color`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.hasImage=false;
target.face=dfAlpha;target.neutralColor=0x9a123456;target.setClip(1,1,2,1);target.imageModified=false;
target.assignImages(source);
var removed=!target.hasImage && target.imageModified && target.neutralColor==0x9a123456;
var retainedGeometry=[target.left,target.top,target.width,target.height].join(",");
target.imageModified=false;var outsideErrors=0,insideErrors=0;
try{target.fillRect(0,0,1,1,0xffabcdef);}catch(error){outsideErrors++;}
try{target.fillRect(1,1,1,1,0xffabcdef);}catch(error){insideErrors++;}
var clipBehavior=outsideErrors+","+insideErrors+","+int(target.imageModified);
target.hasImage=true;
var recreated=target.imageModified && target.imageWidth==4 && target.imageHeight==3 && target.imageLeft==0 && target.imageTop==0 && target.neutralColor==0x9a123456;
var first=pixel(target,0,0),last=pixel(target,3,2),resetClip=clip(target);
`,
    )
    try {
      assert.equal(await session.evaluate('removed && recreated'), '1')
      assert.equal(await session.evaluate('retainedGeometry'), '17,19,4,3')
      assert.equal(await session.evaluate('clipBehavior'), '0,1,0')
      assert.equal(await session.evaluate('first+"|"+last'), '1193046,154,0|1193046,154,0')
      assert.equal(await session.evaluate('resetClip'), '0,0,4,3')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assigning to an image-less destination preserves offsets that fit the received image`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setSize(1,1);target.setImagePos(-1,0);target.setClip(2,1,1,1);
target.hasImage=false;target.imageModified=false;
target.assignImages(source);
var copied=pixels(target),assignedGeometry=geometry(target),resetClip=clip(target);
var retained=target.imageModified && target.neutralColor==0x99334455;
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), sourcePixels())
      assert.equal(await session.evaluate('assignedGeometry'), '17,19,1,1,3,2,-1,0')
      assert.equal(await session.evaluate('resetClip'), '0,0,3,2')
      assert.equal(await session.evaluate('retained'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: copied main mask and province planes remain independent under writes in both directions`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.assignImages(source);var copied=pixels(target);
target.setMainPixel(0,0,0xfedcba);target.setMaskPixel(0,0,201);target.setProvincePixel(0,0,77);
var sourceFirst=pixel(source,0,0),targetFirst=pixel(target,0,0);
source.setMainPixel(2,1,0xabcdef);source.setMaskPixel(2,1,202);source.setProvincePixel(2,1,88);
var targetLast=pixel(target,2,1),sourceLast=pixel(source,2,1);
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), sourcePixels())
      assert.equal(await session.evaluate('sourceFirst'), '1122867,17,3')
      assert.equal(await session.evaluate('targetFirst'), '16702650,201,77')
      assert.equal(await session.evaluate('targetLast'), '263430,102,11')
      assert.equal(await session.evaluate('sourceLast'), '11259375,202,88')
    } finally {
      await stop()
    }
  })

  test(`${mode}: a source without province clears the old destination plane and future writes stay isolated`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.assignImages(source);var copied=pixels(target);
source.setMainPixel(0,0,0xaabbcc);source.setMaskPixel(0,0,201);source.setProvincePixel(0,0,77);
var targetFirst=pixel(target,0,0),sourceFirst=pixel(source,0,0);
target.setMainPixel(2,1,0xabcdef);target.setMaskPixel(2,1,202);target.setProvincePixel(2,1,88);
var sourceLast=pixel(source,2,1),targetLast=pixel(target,2,1);
`,
      false,
    )
    try {
      assert.equal(await session.evaluate('copied'), sourcePixels([0, 0, 0, 0, 0, 0]))
      assert.equal(await session.evaluate('targetFirst'), '1122867,17,0')
      assert.equal(await session.evaluate('sourceFirst'), '11189196,201,77')
      assert.equal(await session.evaluate('sourceLast'), '263430,102,0')
      assert.equal(await session.evaluate('targetLast'), '11259375,202,88')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assignImages can attach an image to a binder without changing its allocation restrictions`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setSize(1,1);target.setImagePos(-1,0);target.type=ltBinder;target.neutralColor=0x82123456;
target.imageModified=false;target.assignImages(source);
var copied=pixels(target),assignedGeometry=geometry(target),resetClip=clip(target);
var retained=target.hasImage && target.imageModified && target.type==ltBinder && target.neutralColor==0x82123456;
var rejected=0;try{target.hasImage=true;}catch(error){rejected++;}
var afterRejection=pixels(target),stillBinder=target.hasImage && target.type==ltBinder;
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), sourcePixels())
      assert.equal(await session.evaluate('afterRejection'), sourcePixels())
      assert.equal(await session.evaluate('assignedGeometry'), '17,19,1,1,3,2,-1,0')
      assert.equal(await session.evaluate('resetClip'), '0,0,3,2')
      assert.equal(await session.evaluate('retained && stillBinder'), '1')
      assert.equal(await session.evaluate('rejected'), '1')
    } finally {
      await stop()
    }
  })
}

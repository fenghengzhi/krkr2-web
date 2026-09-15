import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

async function fixture(binary: boolean, body: string) {
  const { session } = await headless({
    'startup.tjs': '',
    'copy-empty-region.tjs': String.raw`
var win=new Window(),root=new Layer(win,null);
var source=new Layer(win,root),target=new Layer(win,root);
source.setSize(4,2);source.setImageSize(4,2);
target.setSize(4,2);target.setImageSize(4,2);
source.fillRect(0,0,4,2,0x80112233);
for(var y=0;y<2;y++)for(var x=0;x<4;x++){
  source.setMainPixel(x,y,0x010000*(1+x)+y);source.setMaskPixel(x,y,100+x+y);
}
target.fillRect(0,0,4,2,0x55102030);target.setProvincePixel(1,0,37);
var paints=0;source.onPaint=function(){paints++;};
${body}
`,
  })
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("copy-empty-region.tjs","savedata/copy-empty-region.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/copy-empty-region.cjs")')
    } else await session.evaluate('Scripts.execStorage("copy-empty-region.tjs")')
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

  test(`${mode}: piledCopy returns before painting for empty dimensions and requests outside the destination clip`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,2);
var requests=[[1,0,0,1],[1,0,1,0],[1,0,-1,1],[1,0,1,-1],
  [0,0,1,1],[3,0,1,1],[1,-1,1,1],[1,2,1,1],[-8,0,2,1],[8,0,2,1]];
var results=[];
for(var i=0;i<requests.count;i++){
  var r=requests[i];target.imageModified=false;source.callOnPaint=true;
  target.piledCopy(r[0],r[1],source,0,0,r[2],r[3]);
  results.add(paints+","+int(source.callOnPaint)+","+int(target.imageModified));
}
var untouched=target.getMainPixel(1,0)==0x102030 && target.getMaskPixel(1,0)==85 && target.getProvincePixel(1,0)==37;
`,
    )
    try {
      assert.equal(await session.evaluate('results.join("|")'), Array(10).fill('0,1,0').join('|'))
      assert.equal(await session.evaluate('untouched'), '1')
      // The ordinary frame, after the script returns, can still consume paint.
      assert.equal(await session.evaluate('paints+","+int(source.callOnPaint)'), '1,0')
    } finally {
      await stop()
    }
  })

  test(`${mode}: an empty destination clip cannot be reopened by source or descendant onPaint during piledCopy`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var child=new Layer(win,source),childPaints=0;
child.onPaint=function(){childPaints++;};child.callOnPaint=true;
source.onPaint=function(){paints++;global.target.setClip(0,0,4,2);};
target.setClip(1,0,0,2);target.imageModified=false;source.callOnPaint=true;
target.piledCopy(0,0,source,0,0,4,2);
var before=paints+","+childPaints+","+int(source.callOnPaint)+","+int(child.callOnPaint)+","+target.clipWidth+","+int(target.imageModified);
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '0,0,1,1,0,0')
      assert.equal(await session.evaluate('paints+","+childPaints+","+target.clipWidth'), '1,1,4')
    } finally {
      await stop()
    }
  })

  test(`${mode}: partial destination clipping shifts source coordinates and ignores its drawing clip`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,2);source.setClip(0,0,0,0);
target.imageModified=false;source.callOnPaint=true;
target.piledCopy(0,-1,source,0,0,4,3);
var before=paints+","+int(source.callOnPaint)+","+int(target.imageModified);
var copied=[target.getMainPixel(1,0),target.getMaskPixel(1,0),target.getMainPixel(2,0),target.getMaskPixel(2,0)].join(",");
var untouched=target.getMainPixel(0,0)==0x102030 && target.getMainPixel(3,0)==0x102030 && target.getMainPixel(1,1)==0x102030 && target.getMaskPixel(1,1)==85 && target.getProvincePixel(1,0)==37;
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '1,0,1')
      assert.equal(await session.evaluate('copied'), '131073,102,196609,103')
      assert.equal(await session.evaluate('untouched'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: piledCopy captures destination clipping before a reentrant onPaint changes it`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,1);
source.onPaint=function(){paints++;global.target.setClip(0,0,0,0);};
target.imageModified=false;source.callOnPaint=true;
target.piledCopy(0,0,source,0,0,4,1);
var before=paints+","+target.clipWidth+","+target.clipHeight+","+int(target.imageModified);
var pixels=[target.getMainPixel(0,0),target.getMainPixel(1,0),target.getMaskPixel(1,0),target.getMainPixel(2,0),target.getMaskPixel(2,0),target.getMainPixel(3,0)].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '1,0,0,1')
      assert.equal(await session.evaluate('pixels'), '1056816,131072,101,196608,102,1056816')
    } finally {
      await stop()
    }
  })

  test(`${mode}: piledCopy uses current image bounds when onPaint shrinks the destination`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,1);
source.onPaint=function(){paints++;global.target.setImageSize(2,1);global.target.imageModified=false;};
source.callOnPaint=true;target.piledCopy(0,0,source,0,0,4,1);
var before=paints+","+target.imageWidth+","+target.imageHeight+","+int(target.imageModified);
var pixels=[target.getMainPixel(0,0),target.getMaskPixel(0,0),target.getMainPixel(1,0),target.getMaskPixel(1,0)].join(",");
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '1,2,1,1')
      assert.equal(await session.evaluate('pixels'), '1056816,85,131072,101')
    } finally {
      await stop()
    }
  })

  test(`${mode}: a source rectangle outside its image still paints before clipping and does not mark an empty copy modified`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.imageModified=false;source.callOnPaint=true;
target.piledCopy(1,0,source,9,0,1,1);
var before=paints+","+int(source.callOnPaint)+","+int(target.imageModified);
var pixel=target.getMainPixel(1,0)+","+target.getMaskPixel(1,0);
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '1,0,0')
      assert.equal(await session.evaluate('pixel'), '1056816,85')
    } finally {
      await stop()
    }
  })

  test(`${mode}: source onPaint can grow its image into a piledCopy source rectangle`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.onPaint=function(){paints++;setImageSize(10,2);setSize(10,2);setMainPixel(9,0,0xaabbcc);setMaskPixel(9,0,117);};
target.imageModified=false;source.callOnPaint=true;
target.piledCopy(1,0,source,9,0,1,1);
var before=paints+","+int(source.callOnPaint)+","+int(target.imageModified);
var pixel=target.getMainPixel(1,0)+","+target.getMaskPixel(1,0);
`,
    )
    try {
      assert.equal(await session.evaluate('before'), '1,0,1')
      assert.equal(await session.evaluate('pixel'), '11189196,117')
    } finally {
      await stop()
    }
  })

  for (const missing of ['source', 'target']) {
    for (const request of ['0,0,source,0,0,0,1', '9,0,source,0,0,1,1']) {
      test(`${mode}: missing ${missing} image errors precede empty clipping (${request})`, async () => {
        const { session, stop } = await fixture(
          binary,
          String.raw`
${missing}.hasImage=false;
source.onPaint=function(){paints++;global.${missing}.hasImage=true;};
source.callOnPaint=true;var rejected=0;
try{target.piledCopy(${request});}catch(error){rejected++;}
var before=rejected+","+paints+","+int(source.callOnPaint)+","+int(${missing}.hasImage);
`,
        )
        try {
          assert.equal(await session.evaluate('before'), '1,0,1,0')
          assert.equal(await session.evaluate('paints'), '1')
        } finally {
          await stop()
        }
      })
    }
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const sourceColors = [
    0x112233, 0x445566, 0x778899, 0xaabbcc, 0x010203, 0x040506, 0x070809, 0x0a0b0c,
  ],
  sourceMasks = [17, 34, 51, 68, 85, 102, 119, 136],
  targetColors = Array<number>(8).fill(0x102030),
  targetMasks = [101, 102, 103, 104, 105, 106, 107, 108]

function pairs(colors: number[], masks: number[]): string {
  return colors.flatMap((color, index) => [color, masks[index]]).join(',')
}

async function fixture(binary: boolean, body: string) {
  const { session } = await headless({
    'startup.tjs': '',
    'layer-copy-rect.tjs': String.raw`
var win=new Window(),root=new Layer(win,null);
var source=new Layer(win,root),target=new Layer(win,root);
source.setSize(4,2);source.setImageSize(4,2);
target.setSize(4,2);target.setImageSize(4,2);
var sourceColors=[0x112233,0x445566,0x778899,0xaabbcc,0x010203,0x040506,0x070809,0x0a0b0c];
var sourceMasks=[17,34,51,68,85,102,119,136];
function resetSource(){
  source.setClip();
  for(var y=0;y<2;y++)for(var x=0;x<4;x++){
    source.setMainPixel(x,y,sourceColors[y*4+x]);source.setMaskPixel(x,y,sourceMasks[y*4+x]);
  }
  source.imageModified=false;
}
function resetTarget(){
  target.setClip();target.face=dfAlpha;target.holdAlpha=false;
  target.fillRect(0,0,4,2,0x00102030);
  for(var y=0;y<2;y++)for(var x=0;x<4;x++)target.setMaskPixel(x,y,101+y*4+x);
  target.imageModified=false;
}
function pixels(layer){
  var result=[];
  for(var y=0;y<2;y++)for(var x=0;x<4;x++){
    result.add(layer.getMainPixel(x,y));result.add(layer.getMaskPixel(x,y));
  }
  return result.join(",");
}
resetSource();resetTarget();
${body}
`,
  })
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-copy-rect.tjs","savedata/layer-copy-rect.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-copy-rect.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-copy-rect.tjs")')
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

  test(`${mode}: opaque copyRect copies both main and mask when holdAlpha is false`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.face=dfOpaque;target.holdAlpha=false;
source.face=dfMask;source.holdAlpha=true;source.setClip(0,0,0,0);
target.copyRect(0,0,source,0,0,4,2);
var copied=pixels(target),sourcePixels=pixels(source);
var modified=int(target.imageModified)+","+int(source.imageModified);
target.imageModified=false;target.copyRect(0,0,source,0,0,4,2);
var sameCopyModified=int(target.imageModified);
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), pairs(sourceColors, sourceMasks))
      assert.equal(await session.evaluate('sourcePixels'), pairs(sourceColors, sourceMasks))
      assert.equal(await session.evaluate('modified'), '1,0')
      assert.equal(await session.evaluate('sameCopyModified'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: opaque copyRect with holdAlpha preserves each destination mask pixel`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.face=dfOpaque;target.holdAlpha=true;
target.copyRect(0,0,source,0,0,4,2);
var copied=pixels(target),modified=int(target.imageModified);
`,
    )
    try {
      assert.equal(await session.evaluate('copied'), pairs(sourceColors, targetMasks))
      assert.equal(await session.evaluate('modified'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: alpha and additive-alpha copyRect copy both planes regardless of holdAlpha`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var faces=[dfAlpha,dfAddAlpha],results=[],modified=[];
for(var f=0;f<faces.count;f++)for(var held=0;held<2;held++){
  resetTarget();target.face=faces[f];target.holdAlpha=held;
  target.copyRect(0,0,source,0,0,4,2);
  results.add(pixels(target));modified.add(int(target.imageModified));
}
`,
    )
    try {
      assert.equal(
        await session.evaluate('results.join("|")'),
        Array(4).fill(pairs(sourceColors, sourceMasks)).join('|'),
      )
      assert.equal(await session.evaluate('modified.join(",")'), '1,1,1,1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: mask copyRect preserves destination RGB for either holdAlpha value`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var results=[],modified=[];
for(var held=0;held<2;held++){
  resetTarget();target.face=dfMask;target.holdAlpha=held;
  target.copyRect(0,0,source,0,0,4,2);
  results.add(pixels(target));modified.add(int(target.imageModified));
}
`,
    )
    try {
      assert.equal(
        await session.evaluate('results.join("|")'),
        Array(2).fill(pairs(targetColors, sourceMasks)).join('|'),
      )
      assert.equal(await session.evaluate('modified.join(",")'), '1,1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: overlapping self-copy preserves original source pixels in both directions and channels`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.face=dfOpaque;source.holdAlpha=false;
source.copyRect(1,0,source,0,0,3,2);var right=pixels(source);
resetSource();source.copyRect(0,0,source,1,0,3,2);var left=pixels(source);
resetSource();source.holdAlpha=true;
source.copyRect(1,0,source,0,0,3,2);var held=pixels(source);
resetSource();source.face=dfMask;
source.copyRect(1,0,source,0,0,3,2);var mask=pixels(source);
var modified=int(source.imageModified);
source.imageModified=false;source.copyRect(0,0,source,0,0,4,2);
var samePositionModified=int(source.imageModified);
`,
    )
    try {
      const rightColors = [
          0x112233, 0x112233, 0x445566, 0x778899, 0x010203, 0x010203, 0x040506, 0x070809,
        ],
        rightMasks = [17, 17, 34, 51, 85, 85, 102, 119],
        leftColors = [
          0x445566, 0x778899, 0xaabbcc, 0xaabbcc, 0x040506, 0x070809, 0x0a0b0c, 0x0a0b0c,
        ],
        leftMasks = [34, 51, 68, 68, 102, 119, 136, 136]
      assert.equal(await session.evaluate('right'), pairs(rightColors, rightMasks))
      assert.equal(await session.evaluate('left'), pairs(leftColors, leftMasks))
      assert.equal(await session.evaluate('held'), pairs(rightColors, sourceMasks))
      assert.equal(await session.evaluate('mask'), pairs(sourceColors, rightMasks))
      assert.equal(await session.evaluate('modified'), '1')
      assert.equal(await session.evaluate('samePositionModified'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: empty copyRect destination intersections neither modify pixels nor change imageModified`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,2);
var requests=[[1,0,0,1],[1,0,1,0],[1,0,-1,1],[1,0,1,-1],
  [0,0,1,1],[3,0,1,1],[1,-1,1,1],[1,2,1,1]],modified=[];
for(var i=0;i<requests.count;i++){
  var r=requests[i];target.imageModified=false;
  target.copyRect(r[0],r[1],source,0,0,r[2],r[3]);modified.add(int(target.imageModified));
}
target.setClip(1,0,0,2);target.imageModified=false;
target.copyRect(0,0,source,0,0,4,2);modified.add(int(target.imageModified));
target.imageModified=true;target.copyRect(0,0,source,0,0,4,2);
var keptModified=int(target.imageModified),unchanged=pixels(target);
`,
    )
    try {
      assert.equal(await session.evaluate('modified.join(",")'), '0,0,0,0,0,0,0,0,0')
      assert.equal(await session.evaluate('keptModified'), '1')
      assert.equal(await session.evaluate('unchanged'), pairs(targetColors, targetMasks))
    } finally {
      await stop()
    }
  })

  for (const missing of ['source', 'target', 'both']) {
    test(`${mode}: empty target clipping precedes missing ${missing} images for copyRect but not piledCopy`, async () => {
      const removeImages =
          (missing !== 'target' ? 'source.hasImage=false;' : '') +
          (missing !== 'source' ? 'target.hasImage=false;target.hasImage=false;' : ''),
        { session, stop } = await fixture(
          binary,
          String.raw`
target.setClip(1,0,0,2);
${removeImages}
target.imageModified=false;
var emptyCopyErrors=0,emptyPiledErrors=0;
try{target.copyRect(0,0,source,0,0,4,2);}catch(error){emptyCopyErrors++;}
try{target.piledCopy(0,0,source,0,0,4,2);}catch(error){emptyPiledErrors++;}
var emptyState=emptyCopyErrors+","+emptyPiledErrors+","+int(target.imageModified);
target.hasImage=true;target.setClip(1,0,2,1);
${missing !== 'source' ? 'target.hasImage=false;' : ''}
target.imageModified=false;
var outsideErrors=0,insideErrors=0,piledErrors=0;
try{target.copyRect(0,1,source,0,0,1,1);}catch(error){outsideErrors++;}
try{target.copyRect(1,0,source,0,0,1,1);}catch(error){insideErrors++;}
try{target.piledCopy(0,1,source,0,0,1,1);}catch(error){piledErrors++;}
var boundedState=outsideErrors+","+insideErrors+","+piledErrors+","+int(target.imageModified);
var images=int(source.hasImage)+","+int(target.hasImage);
`,
        )
      try {
        assert.equal(await session.evaluate('emptyState'), '0,1,0')
        assert.equal(await session.evaluate('boundedState'), '0,1,1,0')
        assert.equal(
          await session.evaluate('images'),
          missing === 'source' ? '0,1' : missing === 'target' ? '1,0' : '0,0',
        )
      } finally {
        await stop()
      }
    })
  }

  test(`${mode}: a missing source image still throws before source-bounds clipping`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
source.hasImage=false;
var origins=[[0,0],[99,99],[-99,-99]],rejected=0,modified=[];
for(var i=0;i<origins.count;i++){
  target.imageModified=false;var origin=origins[i];
  try{target.copyRect(1,0,source,origin[0],origin[1],1,1);}catch(error){rejected++;}
  modified.add(int(target.imageModified));
}
var unchanged=pixels(target),sourceMissing=!source.hasImage;
`,
    )
    try {
      assert.equal(await session.evaluate('rejected'), '3')
      assert.equal(await session.evaluate('modified.join(",")'), '0,0,0')
      assert.equal(await session.evaluate('unchanged'), pairs(targetColors, targetMasks))
      assert.equal(await session.evaluate('sourceMissing'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: assigning absent images retains clip and later image retirement captures the new clip`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,1);source.hasImage=false;target.assignImages(source);
target.imageModified=false;
var outsideErrors=0,insideErrors=0;
try{target.copyRect(0,1,source,0,0,1,1);}catch(error){outsideErrors++;}
try{target.fillRect(0,1,1,1,0xffabcdef);}catch(error){outsideErrors++;}
try{target.copyRect(1,0,source,0,0,1,1);}catch(error){insideErrors++;}
try{target.fillRect(1,0,1,1,0xffabcdef);}catch(error){insideErrors++;}
var assignedState=outsideErrors+","+insideErrors+","+int(target.imageModified)+","+int(target.hasImage);
target.hasImage=true;target.setClip(2,1,1,1);target.hasImage=false;target.imageModified=false;
var staleClipErrors=0,newClipErrors=0;
try{target.copyRect(1,0,source,0,0,1,1);}catch(error){staleClipErrors++;}
try{target.fillRect(1,0,1,1,0xffabcdef);}catch(error){staleClipErrors++;}
try{target.copyRect(2,1,source,0,0,1,1);}catch(error){newClipErrors++;}
var replacedState=staleClipErrors+","+newClipErrors+","+int(target.imageModified)+","+int(target.hasImage);
`,
    )
    try {
      assert.equal(await session.evaluate('assignedState'), '0,2,0,0')
      assert.equal(await session.evaluate('replacedState'), '0,1,0,0')
    } finally {
      await stop()
    }
  })

  test(`${mode}: existing source images with empty source intersections leave imageModified unchanged`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
var origins=[[9,0],[0,9],[-9,0],[0,-9]],modified=[];
for(var i=0;i<origins.count;i++){
  target.imageModified=false;var origin=origins[i];
  target.copyRect(1,0,source,origin[0],origin[1],1,1);modified.add(int(target.imageModified));
}
target.imageModified=true;target.copyRect(1,0,source,99,99,1,1);
var keptModified=int(target.imageModified),unchanged=pixels(target);
`,
    )
    try {
      assert.equal(await session.evaluate('modified.join(",")'), '0,0,0,0')
      assert.equal(await session.evaluate('keptModified'), '1')
      assert.equal(await session.evaluate('unchanged'), pairs(targetColors, targetMasks))
    } finally {
      await stop()
    }
  })

  test(`${mode}: fillRect rejects a missing image only after its retained target clip intersects`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.fillRect(0,0,1,1,0x65102030);
var sameFillModified=int(target.imageModified),sameFillPixels=pixels(target);
target.setClip(1,0,2,1);target.imageModified=false;
target.fillRect(0,0,1,1,0xffabcdef);
var existingEmptyFill=!target.imageModified,existingFillPixels=pixels(target);
target.imageModified=true;target.fillRect(0,0,1,1,0xffabcdef);var keptFillModified=int(target.imageModified);
target.hasImage=false;target.hasImage=false;
target.type=ltBinder;target.face=dfAlpha;target.imageModified=false;
var requests=[[0,0,1,1],[0,1,4,1],[1,0,0,1],[1,0,1,0],[1,0,-1,1],[1,0,1,-1],[9,9,1,1]],
  rejected=0,modified=[];
for(var i=0;i<requests.count;i++){
  var r=requests[i];
  try{target.fillRect(r[0],r[1],r[2],r[3],0xffabcdef);}catch(error){rejected++;}
  modified.add(int(target.imageModified));
}
var insideErrors=0;
try{target.fillRect(1,0,1,1,0xffabcdef);}catch(error){insideErrors++;}
var absent=!target.hasImage && !target.imageModified;
target.type=ltAlpha;target.hasImage=true;target.setClip(1,0,0,1);target.hasImage=false;target.imageModified=false;
var emptyErrors=0;
try{target.fillRect(0,0,4,2,0xffabcdef);}catch(error){emptyErrors++;}
var emptyPreserved=!target.hasImage && !target.imageModified;
`,
    )
    try {
      assert.equal(await session.evaluate('sameFillModified'), '1')
      assert.equal(await session.evaluate('sameFillPixels'), pairs(targetColors, targetMasks))
      assert.equal(await session.evaluate('existingEmptyFill'), '1')
      assert.equal(await session.evaluate('existingFillPixels'), pairs(targetColors, targetMasks))
      assert.equal(await session.evaluate('keptFillModified'), '1')
      assert.equal(await session.evaluate('rejected'), '0')
      assert.equal(await session.evaluate('modified.join(",")'), '0,0,0,0,0,0,0')
      assert.equal(await session.evaluate('insideErrors'), '1')
      assert.equal(await session.evaluate('emptyErrors'), '0')
      assert.equal(await session.evaluate('absent && emptyPreserved'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: main and mask pixel writes outside clip leave pixels and imageModified unchanged`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,2,1);
var coordinates=[[0,0],[3,0],[1,1],[-1,0],[9,9]],modified=[];
for(var i=0;i<coordinates.count;i++){
  var point=coordinates[i];target.imageModified=false;
  target.setMainPixel(point[0],point[1],0xaabbcc);modified.add(int(target.imageModified));
  target.setMaskPixel(point[0],point[1],231);modified.add(int(target.imageModified));
}
var unchanged=pixels(target);
target.setMainPixel(1,0,0xaabbcc);var mainModified=int(target.imageModified);
target.imageModified=false;target.setMaskPixel(1,0,231);var maskModified=int(target.imageModified);
var written=target.getMainPixel(1,0)+","+target.getMaskPixel(1,0);
target.imageModified=false;target.setMainPixel(1,0,0xaabbcc);var sameMainModified=int(target.imageModified);
target.imageModified=false;target.setMaskPixel(1,0,231);var sameMaskModified=int(target.imageModified);
target.imageModified=true;target.setMainPixel(0,0,0);target.setMaskPixel(0,0,0);
var keptModified=int(target.imageModified);
`,
    )
    try {
      assert.equal(await session.evaluate('modified.join(",")'), '0,0,0,0,0,0,0,0,0,0')
      assert.equal(await session.evaluate('unchanged'), pairs(targetColors, targetMasks))
      assert.equal(await session.evaluate('mainModified+","+maskModified'), '1,1')
      assert.equal(await session.evaluate('sameMainModified+","+sameMaskModified'), '1,1')
      assert.equal(await session.evaluate('written'), '11189196,231')
      assert.equal(await session.evaluate('keptModified'), '1')
    } finally {
      await stop()
    }
  })

  test(`${mode}: main and mask pixel writes require an image even when the retained clip is empty`, async () => {
    const { session, stop } = await fixture(
      binary,
      String.raw`
target.setClip(1,0,0,1);target.hasImage=false;target.imageModified=false;
var coordinates=[[1,0],[99,99]],mainErrors=0,maskErrors=0;
for(var i=0;i<coordinates.count;i++){
  var point=coordinates[i];
  try{target.setMainPixel(point[0],point[1],0xaabbcc);}catch(error){mainErrors++;}
  try{target.setMaskPixel(point[0],point[1],231);}catch(error){maskErrors++;}
}
var unchanged=!target.hasImage && !target.imageModified;
`,
    )
    try {
      assert.equal(await session.evaluate('mainErrors+","+maskErrors'), '2,2')
      assert.equal(await session.evaluate('unchanged'), '1')
    } finally {
      await stop()
    }
  })
}

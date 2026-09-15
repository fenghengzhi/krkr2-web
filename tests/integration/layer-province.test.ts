import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { LayerTree } from '../../src/engine/scene/layers.ts'

async function fixture(binary: boolean, body: string) {
  const { session } = await headless({
    'startup.tjs': '',
    'layer-province.tjs': String.raw`
var win=new Window(),root=new Layer(win,null),layer=new Layer(win,root);
root.hasImage=false;
layer.setSize(4,3);layer.setImageSize(4,3);
function values(item,width=4,height=3){
  var result=[];
  for(var y=0;y<height;y++)for(var x=0;x<width;x++)result.add(item.getProvincePixel(x,y));
  return result.join(",");
}
function clip(item){return [item.clipLeft,item.clipTop,item.clipWidth,item.clipHeight].join(",");}
function pattern(item){
  for(var y=0;y<3;y++)for(var x=0;x<4;x++)item.setProvincePixel(x,y,1+y*4+x);
}
${body}
`,
  })
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-province.tjs","savedata/layer-province.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-province.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-province.tjs")')
    return {
      session,
      async plane(name = 'layer') {
        const id = Number(await session.evaluate(`${name}.__id`)),
          tree = (session as unknown as { layers: Pick<LayerTree, 'get'> }).layers,
          province = tree.get(id).province
        return (
          province && {
            width: province.width,
            height: province.height,
            data: [...province.data],
          }
        )
      },
      async stop() {
        await session.stop()
        assert.equal(session.snapshot().bitmapBytes, 0)
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

  test(`${mode}: Province operation argument counts reject before allocating or changing either plane`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.face=dfProvince;layer.imageModified=false;
var errors=[],calls=[
  function(){layer.getProvincePixel();},function(){layer.getProvincePixel(0);},
  function(){layer.setProvincePixel();},function(){layer.setProvincePixel(0);},function(){layer.setProvincePixel(0,0);},
  function(){layer.fillRect();},function(){layer.fillRect(0,0,4,3);},
  function(){layer.colorRect();},function(){layer.colorRect(0,0,4,3);},
  function(){layer.copyRect(0,0,layer,0,0,4);},
  function(){layer.loadProvinceImage();},function(){layer.loadImages();},
  function(){layer.getMainPixel();},function(){layer.getMaskPixel();},
  function(){layer.setMainPixel(0,0);},function(){layer.setMaskPixel(0,0);}
];
for(var i=0;i<calls.count;i++){try{calls[i]();}catch(error){errors.add(error.message);}}
var missingState=[int(layer.hasImage),int(layer.imageModified),layer.getProvincePixel(void,void)].join(",");
function explicitVoids(){layer.setProvincePixel(void,void,void);return layer.getProvincePixel(void,void);}
`,
    )
    try {
      const messages = (await f.session.evaluate('errors.join("|")')).split('|')
      assert.equal(messages.length, 16)
      for (const message of messages) assert.match(message, /Layer\.\w+ requires at least/)
      assert.equal(await f.session.evaluate('missingState'), '0,0,0')
      assert.equal(await f.plane(), undefined)
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.equal(await f.session.evaluate('explicitVoids()'), '0')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: Array(12).fill(0) })
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 12)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: province-only pixel writes allocate before clip checks while MainImage operations still reject`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.setClip(1,1,2,1);layer.hasImage=false;layer.imageModified=false;
var absent=[int(layer.hasImage),layer.getProvincePixel(1,1),layer.getProvincePixel(-1,0),
  layer.getProvincePixel(99,99),int(layer.imageModified)].join(","),savedClip=clip(layer);
layer.setProvincePixel(0,0,0x123);
var firstOutside=int(layer.imageModified);
layer.imageModified=false;layer.setProvincePixel(0,0,0x123);
var secondOutside=int(layer.imageModified);
layer.setProvincePixel(1,1,0x123);layer.setProvincePixel(2,1,-1);
var marked=values(layer),written=int(layer.imageModified);
layer.imageModified=false;
var errors=[];
try{layer.getMainPixel(0,0);}catch(error){errors.add("main-read");}
try{layer.getMaskPixel(0,0);}catch(error){errors.add("mask-read");}
try{layer.setMainPixel(99,99,0);}catch(error){errors.add("main-write");}
try{layer.setMaskPixel(99,99,0);}catch(error){errors.add("mask-write");}
try{layer.setClip();}catch(error){errors.add("clip-reset");}
try{layer.setClip(0,0,1,1);}catch(error){errors.add("clip-set");}
try{layer.clipLeft=0;}catch(error){errors.add("clip-property");}
try{layer.flipLR();}catch(error){errors.add("flip-lr");}
try{layer.flipUD();}catch(error){errors.add("flip-ud");}
var afterErrors=[int(layer.hasImage),int(layer.imageModified),clip(layer),values(layer)].join("|");
`,
    )
    try {
      const pixels = [0, 0, 0, 0, 0, 35, 255, 0, 0, 0, 0, 0]
      assert.equal(await f.session.evaluate('absent'), '0,0,0,0,0')
      assert.equal(await f.session.evaluate('savedClip'), '1,1,2,1')
      assert.equal(await f.session.evaluate('firstOutside+","+secondOutside+","+written'), '1,0,1')
      assert.equal(await f.session.evaluate('marked'), pixels.join(','))
      assert.equal(
        await f.session.evaluate('errors.join(",")'),
        'main-read,mask-read,main-write,mask-write,clip-reset,clip-set,clip-property,flip-lr,flip-ud',
      )
      assert.equal(await f.session.evaluate('afterErrors'), `0|0|1,1,2,1|${pixels.join(',')}`)
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: pixels })
      assert.equal(f.session.snapshot().bitmapBytes, 12)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Province integer coordinates and values retain low native bits beyond Number precision`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.face=dfProvince;
layer.setProvincePixel(0x20000000000001,0x100000001,0x200000000000ab);
var firstWide=layer.getProvincePixel(0x20000000000001,0x100000001);
layer.setProvincePixel(-0xffffffff,-0xffffffff,-0xffffffcd);
layer.fillRect(0x20000000000002,0x100000000,0x20000000000001,0x20000000000001,0x200000000000ef);
layer.colorRect(0x20000000000003,0x20000000000002,0x100000001,0x100000001,0x20000000000045,0);
layer.copyRect(0x20000000000000,0x100000002,layer,0x20000000000002,0x100000000,0x100000001,0x20000000000001);
var reads=[firstWide,layer.getProvincePixel(0x20000000000001,0x100000001),
  layer.getProvincePixel(-0xffffffff,-0xffffffff),
  layer.getProvincePixel(0x20000000000002,0x100000000),
  layer.getProvincePixel(0x20000000000003,0x20000000000002)].join(",");
`,
    )
    try {
      assert.equal(await f.session.evaluate('reads'), '171,51,51,239,69')
      assert.deepEqual(await f.plane(), {
        width: 4,
        height: 3,
        data: [0, 0, 239, 0, 0, 51, 0, 0, 239, 0, 0, 69],
      })
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Province retains its own dimensions through image-less Layer resizing and stale-clip bounds checks`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.setImageSize(6,4);layer.setImagePos(-1,-1);layer.hasImage=false;
layer.setProvincePixel(3,2,99);layer.setSize(2,1);
var afterShrink=[layer.width,layer.height,layer.getProvincePixel(3,2),clip(layer)].join(",");
layer.setSize(6,4);layer.imageModified=false;
var insideErrors=0,outsideErrors=0;
try{layer.setProvincePixel(5,3,77);}catch(error){insideErrors++;}
try{layer.setProvincePixel(6,3,77);}catch(error){outsideErrors++;}
var afterGrow=[layer.width,layer.height,layer.getProvincePixel(3,2),
  layer.getProvincePixel(5,3),insideErrors,outsideErrors,int(layer.imageModified)].join(",");
function restoreMain(){layer.hasImage=true;}
function growImages(){layer.setSize(8,5);}
function shrinkRect(){layer.setSize(2,1);}
`,
    )
    try {
      const original = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99]
      assert.equal(await f.session.evaluate('afterShrink'), '2,1,99,0,0,6,4')
      assert.equal(await f.session.evaluate('afterGrow'), '6,4,99,0,1,0,0')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: original })
      assert.equal(f.session.snapshot().bitmapBytes, 12)
      await f.session.evaluate('restoreMain()')
      const restored = Array<number>(24).fill(0)
      restored[15] = 99
      assert.deepEqual(await f.plane(), { width: 6, height: 4, data: restored })
      assert.equal(
        await f.session.evaluate(
          '[int(layer.hasImage),layer.imageLeft,layer.imageTop,clip(layer)].join(",")',
        ),
        '1,0,0,0,0,6,4',
      )
      assert.equal(f.session.snapshot().bitmapBytes, 120)
      await f.session.evaluate('growImages()')
      const grown = Array<number>(40).fill(0)
      grown[19] = 99
      assert.deepEqual(await f.plane(), { width: 8, height: 5, data: grown })
      assert.equal(f.session.snapshot().bitmapBytes, 200)
      await f.session.evaluate('shrinkRect()')
      assert.deepEqual(await f.plane(), { width: 8, height: 5, data: grown })
      assert.equal(f.session.snapshot().bitmapBytes, 200)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Province fill clips before allocating and only an exact full zero fill releases its plane`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.face=dfProvince;layer.imageModified=false;
layer.fillRect(4,0,1,1,7);layer.fillRect(0,0,0,1,7);
var emptyModified=int(layer.imageModified);
layer.fillRect(0,0,4,3,0x100);var zeroModified=int(layer.imageModified);
function fill(){layer.fillRect(0,0,4,3,0x107);}
function partialClear(){layer.imageModified=false;layer.fillRect(1,1,2,1,0x200);}
function fullClear(){layer.imageModified=false;layer.fillRect(0,0,4,3,0x300);}
`,
    )
    try {
      assert.equal(await f.session.evaluate('emptyModified+","+zeroModified'), '0,0')
      assert.equal(await f.plane(), undefined)
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('fill()')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: Array(12).fill(7) })
      assert.equal(f.session.snapshot().bitmapBytes, 12)
      await f.session.evaluate('partialClear()')
      assert.deepEqual(await f.plane(), {
        width: 4,
        height: 3,
        data: [7, 7, 7, 7, 7, 0, 0, 7, 7, 7, 7, 7],
      })
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 12)
      await f.session.evaluate('fullClear()')
      assert.equal(await f.plane(), undefined)
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Province colorRect ignores opacity and a clipped full clear frees the plane`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.face=dfProvince;
layer.colorRect(0,0,1,3,0x111,0);
layer.colorRect(1,0,1,3,0x122,-255);
layer.colorRect(2,0,1,3,0x133,255);
layer.colorRect(3,0,1,3,0x144,0x100000000);
var colored=values(layer);
function clear(){layer.imageModified=false;layer.colorRect(-1,-1,6,5,0x100,-999);}
`,
    )
    try {
      const pixels = [17, 34, 51, 68, 17, 34, 51, 68, 17, 34, 51, 68]
      assert.equal(await f.session.evaluate('colored'), pixels.join(','))
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: pixels })
      await f.session.evaluate('clear()')
      assert.equal(await f.plane(), undefined)
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Province copyRect needs no MainImage and clips against the source plane dimensions`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.setSize(4,3);source.setImageSize(4,3);
source.hasImage=false;pattern(source);source.setSize(1,1);
layer.hasImage=false;layer.face=dfProvince;
layer.copyRect(0,0,source,-1,-1,4,3);
var copied=values(layer),images=int(source.hasImage)+","+int(layer.hasImage);
`,
    )
    try {
      const expected = [0, 0, 0, 0, 0, 1, 2, 3, 0, 5, 6, 7]
      assert.equal(await f.session.evaluate('images'), '0,0')
      assert.equal(await f.session.evaluate('copied'), expected.join(','))
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: expected })
      assert.deepEqual(await f.plane('source'), {
        width: 4,
        height: 3,
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      })
      assert.equal(f.session.snapshot().bitmapBytes, 24)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: overlapping Province self-copy preserves the original rows in every direction`, async () => {
    const f = await fixture(
      binary,
      String.raw`
layer.hasImage=false;layer.face=dfProvince;
var copied=[],modified=[];
pattern(layer);layer.imageModified=false;layer.copyRect(1,0,layer,0,0,3,3);
copied.add(values(layer));modified.add(int(layer.imageModified));
pattern(layer);layer.imageModified=false;layer.copyRect(0,0,layer,1,0,3,3);
copied.add(values(layer));modified.add(int(layer.imageModified));
pattern(layer);layer.imageModified=false;layer.copyRect(0,1,layer,0,0,4,2);
copied.add(values(layer));modified.add(int(layer.imageModified));
pattern(layer);layer.imageModified=false;layer.copyRect(0,0,layer,0,1,4,2);
copied.add(values(layer));modified.add(int(layer.imageModified));
`,
    )
    try {
      assert.equal(
        await f.session.evaluate('copied.join("|")'),
        [
          [1, 1, 2, 3, 5, 5, 6, 7, 9, 9, 10, 11],
          [2, 3, 4, 4, 6, 7, 8, 8, 10, 11, 12, 12],
          [1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8],
          [5, 6, 7, 8, 9, 10, 11, 12, 9, 10, 11, 12],
        ]
          .map((pixels) => pixels.join(','))
          .join('|'),
      )
      assert.equal(await f.session.evaluate('modified.join(",")'), '1,1,1,1')
      assert.equal(f.session.snapshot().bitmapBytes, 12)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: absent-source Province copy clears the adjusted source rectangle without allocating or releasing planes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.hasImage=false;
layer.setClip(1,1,2,2);layer.hasImage=false;layer.face=dfProvince;
layer.setProvincePixel(1,1,9);layer.setProvincePixel(2,1,9);
layer.setProvincePixel(1,2,9);layer.setProvincePixel(2,2,9);
layer.imageModified=false;
// Clipping dx=0 to left=1 adjusts source x=0 to 1. Source y=0 stays 0.
// Native clears (1,0)-(3,2), not destination (1,1)-(3,3).
layer.copyRect(0,1,source,0,0,3,2);
var cleared=values(layer),modified=int(layer.imageModified);
function clearMissing(){layer.hasImage=false;layer.imageModified=false;layer.copyRect(1,1,source,99,99,1,1);}
function emptyDestination(){layer.imageModified=false;layer.copyRect(0,0,source,0,0,1,1);}
function clearWholeExisting(){
  source.setSize(4,3);source.face=dfProvince;source.setProvincePixel(0,0,87);
  source.imageModified=false;source.copyRect(0,0,layer,0,0,4,3);
}
`,
    )
    try {
      const expected = [0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 0]
      assert.equal(await f.session.evaluate('cleared'), expected.join(','))
      assert.equal(await f.session.evaluate('modified'), '1')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: expected })
      assert.equal(f.session.snapshot().bitmapBytes, 12)
      await f.session.evaluate('clearMissing()')
      assert.equal(await f.plane(), undefined)
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('emptyDestination()')
      assert.equal(await f.session.evaluate('int(layer.imageModified)'), '0')
      assert.equal(await f.plane(), undefined)
      await f.session.evaluate('clearWholeExisting()')
      assert.deepEqual(await f.plane('source'), { width: 4, height: 3, data: Array(12).fill(0) })
      assert.equal(await f.session.evaluate('int(source.imageModified)'), '1')
      assert.equal(f.session.snapshot().bitmapBytes, 12)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a present source Province allocates the destination before an empty source-bounds transfer`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.setSize(1,1);source.setImageSize(1,1);
source.hasImage=false;source.setProvincePixel(0,0,17);
layer.hasImage=false;layer.face=dfProvince;layer.imageModified=false;
layer.copyRect(0,0,source,99,99,1,1);
var allocatedModified=int(layer.imageModified);
layer.imageModified=false;layer.copyRect(0,0,source,99,99,1,1);
var existingModified=int(layer.imageModified);
`,
    )
    try {
      assert.equal(await f.session.evaluate('allocatedModified+","+existingModified'), '1,0')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: Array(12).fill(0) })
      assert.equal(f.session.snapshot().bitmapBytes, 13)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: assigning a distinct Province-only source preserves destination geometry but image-less self-assignment deletes the plane`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var source=new Layer(win,root);source.setSize(4,3);source.setImageSize(4,3);
source.hasImage=false;pattern(source);source.setSize(1,1);
layer.setImageSize(6,4);layer.setImagePos(-1,-1);layer.setPos(17,19);
layer.setClip(1,1,3,2);layer.imageModified=false;
layer.assignImages(source);
var assigned=[int(layer.hasImage),int(layer.imageModified),values(layer)].join("|");
var geometry=[layer.left,layer.top,layer.width,layer.height,layer.imageLeft,layer.imageTop,clip(layer)].join(",");
function selfAssign(){layer.imageModified=false;layer.assignImages(layer);}
function clearFromMissing(){source.hasImage=false;layer.assignImages(source);}
`,
    )
    try {
      const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      assert.equal(await f.session.evaluate('assigned'), `0|1|${expected.join(',')}`)
      assert.equal(await f.session.evaluate('geometry'), '17,19,4,3,-1,-1,1,1,3,2')
      assert.deepEqual(await f.plane(), { width: 4, height: 3, data: expected })
      assert.equal(f.session.snapshot().bitmapBytes, 24)
      await f.session.evaluate('selfAssign()')
      assert.equal(await f.plane(), undefined)
      assert.equal(
        await f.session.evaluate('[int(layer.imageModified),clip(layer),values(layer)].join("|")'),
        `1|1,1,3,2|${Array(12).fill(0).join(',')}`,
      )
      assert.deepEqual(await f.plane('source'), { width: 4, height: 3, data: expected })
      assert.equal(f.session.snapshot().bitmapBytes, 12)
      await f.session.evaluate('clearFromMissing()')
      assert.equal(await f.plane(), undefined)
      assert.equal(await f.plane('source'), undefined)
      assert.equal(f.session.snapshot().bitmapBytes, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Layer flips all MainImage and Province rows regardless of face and clip`, async () => {
    const f = await fixture(
      binary,
      String.raw`
for(var y=0;y<3;y++)for(var x=0;x<4;x++){
  var n=1+y*4+x;layer.setMainPixel(x,y,n*0x010101);
  layer.setMaskPixel(x,y,n*10);layer.setProvincePixel(x,y,n);
}
function allPixels(){
  var result=[];
  for(var y=0;y<3;y++)for(var x=0;x<4;x++)
    result.add([layer.getMainPixel(x,y),layer.getMaskPixel(x,y),layer.getProvincePixel(x,y)].join(","));
  return result.join(",");
}
layer.face=dfMask;layer.holdAlpha=true;layer.setClip(1,1,1,1);
layer.imageModified=false;layer.flipLR();var horizontal=allPixels(),horizontalModified=int(layer.imageModified);
layer.imageModified=false;layer.flipUD();var vertical=allPixels(),verticalModified=int(layer.imageModified);
var retainedClip=clip(layer);
`,
    )
    try {
      const pixels = (indices: number[]) =>
        indices.flatMap((n) => [n * 0x010101, n * 10, n]).join(',')
      assert.equal(
        await f.session.evaluate('horizontal'),
        pixels([4, 3, 2, 1, 8, 7, 6, 5, 12, 11, 10, 9]),
      )
      assert.equal(
        await f.session.evaluate('vertical'),
        pixels([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
      )
      assert.equal(await f.session.evaluate('horizontalModified+","+verticalModified'), '1,1')
      assert.equal(await f.session.evaluate('retainedClip'), '1,1,1,1')
      assert.equal(f.session.snapshot().bitmapBytes, 60)
    } finally {
      await f.stop()
    }
  })
}

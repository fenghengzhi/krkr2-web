import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'

// The checked-in TFT supplies a 3x2 A with [0,16,32,48,64,64] coverage
// and an empty space. No installed font, raster backend or screenshot is used.
const font = new Uint8Array(
  readFileSync(new URL('../fixtures/font/coverage-v1.tft', import.meta.url)),
)
const setup = String.raw`
var win=new Window(),a=new Layer(win,null),b=new Layer(win,a);
a.setImageSize(8,8);b.setImageSize(8,8);
a.font.height=8;b.font.height=8;
a.font.mapPrerenderedFont("coverage.tft");
function pixels(layer) {
  var result=[];
  for(var y=0;y<8;y++)for(var x=0;x<8;x++) {
    result.add(layer.getMainPixel(x,y));result.add(layer.getMaskPixel(x,y));
  }
  return result.join(",");
}
function reset(layer,face,hold) {
  layer.setClip();layer.face=dfAlpha;layer.holdAlpha=false;
  layer.fillRect(0,0,8,8,0x40123456);
  layer.face=face;layer.holdAlpha=hold;layer.imageModified=false;
}
`

async function fixture(binary: boolean, body: string) {
  const { session } = await headless({
    'startup.tjs': '',
    'text-pixels.tjs': setup + body,
    'coverage.tft': font,
  })
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("text-pixels.tjs","savedata/text-pixels.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/text-pixels.cjs")')
    } else await session.evaluate('Scripts.execStorage("text-pixels.tjs")')
    return session
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: fixed TFT coverage ignores holdAlpha on Alpha and AddAlpha while preserving opaque hold semantics`, async () => {
    const session = await fixture(
      binary,
      String.raw`
var comparisons=[],alphas=[],opaqueRGB=true,opaqueMasks=true;
for(var face=0;face<2;face++) {
  var drawingFace=face?dfAddAlpha:dfAlpha;
  reset(a,drawingFace,false);reset(b,drawingFace,true);
  a.drawText(0,0,"A",0xabcdef);b.drawText(0,0,"A",0xabcdef);
  comparisons.add(pixels(a)==pixels(b));
  alphas.add(b.getMaskPixel(1,5));
}
reset(a,dfAlpha,false);reset(b,dfAlpha,true);
a.drawText(0,0,"A",0xabcdef,-255);b.drawText(0,0,"A",0xabcdef,-255);
comparisons.add(pixels(a)==pixels(b));alphas.add(b.getMaskPixel(1,5));
var removedRGB=b.getMainPixel(1,5);
reset(a,dfOpaque,false);reset(b,dfOpaque,true);
a.drawText(0,0,"A",0xabcdef);b.drawText(0,0,"A",0xabcdef);
for(var y=4;y<6;y++)for(var x=0;x<3;x++) {
  opaqueRGB=opaqueRGB && a.getMainPixel(x,y)==b.getMainPixel(x,y);
  opaqueMasks=opaqueMasks && a.getMaskPixel(x,y)==0 && b.getMaskPixel(x,y)==64;
}
var outsideMask=a.getMaskPixel(3,4),zeroCoverageColor=a.getMainPixel(0,4);
`,
    )
    try {
      assert.equal(await session.evaluate('comparisons.join(",")'), '1,1,1')
      assert.equal(await session.evaluate('alphas.join(",")'), '255,255,0')
      assert.equal(await session.evaluate('removedRGB'), String(0x123456))
      assert.equal(await session.evaluate('opaqueRGB+","+opaqueMasks'), '1,1')
      assert.equal(await session.evaluate('outsideMask'), '64')
      assert.equal(await session.evaluate('zeroCoverageColor'), String(0x123456))
    } finally {
      await session.stop()
      assert.equal(session.snapshot().handles, 0)
    }
  })

  test(`${mode}: TFT drawText imageModified follows glyph update rectangles and preserves no-op pixels`, async () => {
    const session = await fixture(
      binary,
      String.raw`
var states=[],unchanged=[];
function record() {states.add(int(a.imageModified));unchanged.add(pixels(a)==before);}
reset(a,dfAlpha,false);var before=pixels(a);
a.drawText(0,0,"",0xffffff);record();
a.drawText(0,0," ",0xffffff);record();
a.drawText(8,0,"A",0xffffff);record();
a.setClip(0,0,0,0);a.drawText(0,0,"A",0xffffff);record();
a.setClip();a.drawText(0,0,"A",0xffffff,0);record();
a.face=dfOpaque;a.drawText(0,0,"A",0xffffff,-255);record();
// The A's top-left coverage is zero. Native InternalDrawText still returns
// its nonempty intersection, so ImageModified becomes true without a pixel diff.
a.face=dfAlpha;a.setClip(0,4,1,1);a.drawText(0,0,"A",0xffffff);record();
a.drawText(0,0,"A",0xffffff,0);record();
// A shadow may intersect even when the main glyph lies outside the clip.
reset(a,dfAlpha,false);a.drawText(20,0,"A",0xffffff,255,true,255,0xabcdef,0,-20,0);
var shadowModified=int(a.imageModified),shadowAlpha=a.getMaskPixel(1,5);
`,
    )
    try {
      assert.equal(await session.evaluate('states.join(",")'), '0,0,0,0,0,0,1,1')
      assert.equal(await session.evaluate('unchanged.join(",")'), '1,1,1,1,1,1,1,1')
      assert.equal(await session.evaluate('shadowModified+","+shadowAlpha'), '1,255')
    } finally {
      await session.stop()
      assert.equal(session.snapshot().handles, 0)
    }
  })
}

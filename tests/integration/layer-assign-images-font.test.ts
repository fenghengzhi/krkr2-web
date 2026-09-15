import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

/** One synthetic A in the documented v1 TFT layout. Measurements and pixels
 * must pass through the real pre-rendered parser and FontService; headless's
 * default text backend throws if a mapping is accidentally lost. */
function mappedFont(source: boolean): Uint8Array {
  const bytes = new Uint8Array(62),
    view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('TVP pre-rendered font\x1a'))
  bytes[22] = 1
  bytes[23] = 2
  view.setUint32(24, 1, true)
  view.setUint32(28, 36, true)
  view.setUint32(32, 38, true)
  view.setUint16(36, 65, true)
  view.setUint32(38, 58, true)
  view.setUint16(42, 2, true)
  view.setUint16(44, 2, true)
  // Target: height 8, angle 0, ascent (0,6). Source: height 16,
  // angle 900, ascent (12,0). Both bitmaps begin at the drawing origin.
  view.setInt16(46, source ? -12 : 0, true)
  view.setInt16(48, source ? 0 : 6, true)
  view.setInt16(50, source ? 9 : 4, true)
  view.setInt16(52, 0, true)
  view.setInt16(54, source ? 7 : 3, true)
  bytes.set(source ? [0, 64, 64, 0] : [64, 0, 16, 32], 58)
  return bytes
}

const setup = String.raw`
var win=new Window(),root=new Layer(win,null);
var target=new Layer(win,root),source=new Layer(win,root);
target.type=ltAlpha;source.type=ltAlpha;
target.setImageSize(16,16);source.setImageSize(16,16);
function configureFont(font,isSource) {
  font.face=isSource?"Assign source":"Assign target";
  font.height=isSource?16:8;
  font.angle=isSource?900:0;
  font.bold=isSource;
  font.italic=!isSource;
  font.underline=isSource;
  font.strikeout=!isSource;
}
function fontState(font) {
  return [font.face,font.height,font.angle,int(font.bold),int(font.italic),
    int(font.underline),int(font.strikeout),int(font.faceIsFileName)].join("|");
}
function coverage(layer) {
  return [layer.getMaskPixel(0,0),layer.getMaskPixel(1,0),
    layer.getMaskPixel(0,1),layer.getMaskPixel(1,1),
    layer.getMaskPixel(4,0),layer.getMaskPixel(5,0),
    layer.getMaskPixel(9,0),layer.getMaskPixel(10,0)].join(",");
}
function drawMapped(layer,color) {
  layer.setClip();
  layer.fillRect(0,0,16,16,0);
  layer.drawText(0,0,"AA",color);
}
`

const targetState = 'Assign target|8|0|0|1|0|1|0',
  sourceState = 'Assign source|16|900|1|0|1|0|0',
  targetCoverage = '255,0,64,128,255,0,0,0',
  sourceCoverage = '0,255,255,0,0,0,0,255'

async function fixture(binary: boolean, body: string) {
  const harness = await headless({
    'startup.tjs': '',
    'assign-font.tjs': setup + body,
    'target.tft': mappedFont(false),
    'source.tft': mappedFont(true),
  })
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("assign-font.tjs","savedata/assign-font.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/assign-font.cjs")')
    } else await session.evaluate('Scripts.execStorage("assign-font.tjs")')
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

  for (const cached of [false, true])
    for (const sourceImage of [false, true])
      test(
        `${mode}: assignImages preserves ${cached ? 'cached' : 'uncached'} target Font settings and mappings with ${sourceImage ? 'an image' : 'no main image'} on the source`,
        { timeout: 60000 },
        async () => {
          const { session, stop } = await fixture(
            binary,
            String.raw`
// new Font(target) observes the settings without initializing target.font.
var configured=${cached ? 'target.font' : 'new Font(target)'};
var independent=new Font(target),sourceFont=source.font;
configureFont(configured,false);configureFont(sourceFont,true);
configured.mapPrerenderedFont("target.tft");
sourceFont.mapPrerenderedFont("source.tft");
var beforeWidths=configured.getTextWidth("AA")+","+sourceFont.getTextWidth("AA");
drawMapped(target,0x123456);drawMapped(source,0xabcdef);
var beforeTargetCoverage=coverage(target),beforeSourceCoverage=coverage(source);
${sourceImage ? '' : 'source.hasImage=false;'}
target.assignImages(source);
var assignedHasImage=target.hasImage;
var configuredAfter=fontState(configured),independentAfter=fontState(independent);
var sourceAfter=fontState(sourceFont);
var cachedAfter=target.font;
var identities=(cachedAfter===target.font)+","+(cachedAfter===configured)+","+
  (independent!==cachedAfter)+","+(independent!==configured)+","+(isvalid independent);
var cachedState=fontState(cachedAfter);
${sourceImage ? 'var copiedCoverage=coverage(target);' : 'target.hasImage=true;'}
var afterWidths=configured.getTextWidth("AA")+","+independent.getTextWidth("AA")+","+
  cachedAfter.getTextWidth("AA");
drawMapped(target,0x123456);
var afterTargetCoverage=coverage(target),afterTargetColor=target.getMainPixel(0,0);
${sourceImage ? 'var afterSourceCoverage=coverage(source),afterSourceColor=source.getMainPixel(1,0);' : ''}
`,
          )
          try {
            assert.equal(await session.evaluate('beforeWidths'), '6,14')
            assert.equal(await session.evaluate('beforeTargetCoverage'), targetCoverage)
            assert.equal(await session.evaluate('beforeSourceCoverage'), sourceCoverage)
            assert.equal(await session.evaluate('assignedHasImage'), sourceImage ? '1' : '0')
            for (const state of ['configuredAfter', 'independentAfter', 'cachedState'])
              assert.equal(await session.evaluate(state), targetState)
            assert.equal(await session.evaluate('sourceAfter'), sourceState)
            assert.equal(await session.evaluate('identities'), cached ? '1,1,1,1,1' : '1,0,1,1,1')
            if (sourceImage) assert.equal(await session.evaluate('copiedCoverage'), sourceCoverage)
            assert.equal(await session.evaluate('afterWidths'), '6,6,6')
            assert.equal(await session.evaluate('afterTargetCoverage'), targetCoverage)
            assert.equal(await session.evaluate('afterTargetColor'), String(0x123456))
            if (sourceImage) {
              assert.equal(await session.evaluate('afterSourceCoverage'), sourceCoverage)
              assert.equal(await session.evaluate('afterSourceColor'), String(0xabcdef))
            }
          } finally {
            await stop()
          }
        },
      )

  test(
    `${mode}: self assignImages resets clipping while preserving cached and independent Fonts and their mapped pixels`,
    { timeout: 60000 },
    async () => {
      const { session, stop } = await fixture(
        binary,
        String.raw`
var cached=target.font,independent=new Font(target);
configureFont(cached,false);cached.mapPrerenderedFont("target.tft");
drawMapped(target,0x123456);
var beforeCoverage=coverage(target),beforeWidth=cached.getTextWidth("AA");
target.setClip(12,12,1,1);target.imageModified=false;
target.assignImages(target);
var afterState=fontState(cached),afterIndependent=fontState(independent);
var sameObjects=(target.font===cached)+","+(independent!==cached)+","+(isvalid independent);
var assignedClip=[target.clipLeft,target.clipTop,target.clipWidth,target.clipHeight,
  int(target.imageModified)].join(",");
var assignedCoverage=coverage(target);
var afterWidth=independent.getTextWidth("AA");
// Draw directly, without drawMapped/setClip, so this also exercises the reset.
target.drawText(0,0,"AA",0x654321);
var paintedColor=target.getMainPixel(0,0),paintedAdvanceColor=target.getMainPixel(4,0);
`,
      )
      try {
        assert.equal(await session.evaluate('beforeCoverage'), targetCoverage)
        assert.equal(await session.evaluate('beforeWidth+","+afterWidth'), '6,6')
        assert.equal(await session.evaluate('afterState'), targetState)
        assert.equal(await session.evaluate('afterIndependent'), targetState)
        assert.equal(await session.evaluate('sameObjects'), '1,1,1')
        assert.equal(await session.evaluate('assignedClip'), '0,0,16,16,1')
        assert.equal(await session.evaluate('assignedCoverage'), targetCoverage)
        assert.equal(await session.evaluate('paintedColor'), String(0x654321))
        assert.equal(await session.evaluate('paintedAdvanceColor'), String(0x654321))
      } finally {
        await stop()
      }
    },
  )
}

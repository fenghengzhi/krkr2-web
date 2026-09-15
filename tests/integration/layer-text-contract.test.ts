import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { GraphicsDecoder } from '../../src/engine/ports/graphics.ts'

const setup = String.raw`
var win=new Window(),layer=new Layer(win,null);
layer.type=ltAlpha;layer.face=dfAlpha;layer.setImageSize(16,16);
layer.font.height=12;
`

const queries = [
  'getTextWidth',
  'getTextHeight',
  'getEscWidthX',
  'getEscWidthY',
  'getEscHeightX',
  'getEscHeightY',
] as const

function catchCalls(calls: readonly string[], name = 'errors'): string {
  return `var ${name}=[];\n${calls
    .map((call) => `try{${call};${name}.add("");}catch(error){${name}.add(string(error.message));}`)
    .join('\n')}`
}

/** A guarded backend makes a caught backend exception distinguishable from
 * correct preflight rejection. Open it only after the script has returned and
 * every counter has been checked, then prove the same Font can do real work. */
function backend() {
  const calls = { decode: 0, text: 0, measure: 0, loadFont: 0, measureGlyph: 0, glyph: 0 }
  const antialiased: boolean[] = []
  let blocked = true,
    released = 0
  function enter(operation: keyof typeof calls) {
    calls[operation]++
    if (blocked) throw new Error(`Font backend reached before preflight: ${operation}`)
  }
  const graphics: GraphicsDecoder = {
    async decode() {
      enter('decode')
      throw new Error('Unexpected image decoding')
    },
    text() {
      enter('text')
      throw new Error('Native glyph fixture must not use fallback text drawing')
    },
    measure(text, font) {
      enter('measure')
      return { width: text.length * 7, height: font.height, ascent: 0 }
    },
    async loadFont(bytes) {
      enter('loadFont')
      assert.deepEqual([...bytes], [1, 2, 3])
      return {
        face: 'loaded-contract-font',
        dispose() {
          released++
        },
      }
    },
    measureGlyph() {
      enter('measureGlyph')
      return { left: 0, top: 0, right: 1, bottom: 1, advance: 7 }
    },
    glyph(_character, _font, aa) {
      enter('glyph')
      antialiased.push(aa)
      return {
        width: 1,
        height: 1,
        left: 0,
        top: 0,
        advance: 7,
        coverage: new Uint8Array([255]),
      }
    },
  }
  return {
    graphics,
    calls,
    antialiased,
    open() {
      blocked = false
    },
    assertUntouched() {
      assert.deepEqual(calls, {
        decode: 0,
        text: 0,
        measure: 0,
        loadFont: 0,
        measureGlyph: 0,
        glyph: 0,
      })
    },
    get released() {
      return released
    },
  }
}

async function fixture(
  binary: boolean,
  body: string,
  graphics: GraphicsDecoder,
  continuation = '',
) {
  const harness = await headless(
    {
      'startup.tjs': '',
      'text-contract.tjs': setup + body,
      'text-continuation.tjs': continuation,
      'contract.ttf': new Uint8Array([1, 2, 3]),
    },
    { graphics },
  )
  const { session } = harness
  async function run(name: string) {
    const script = `${name}.tjs`,
      compiled = `savedata/${name}.cjs`
    if (binary) {
      await session.evaluate(
        `Scripts.compileStorage(${JSON.stringify(script)},${JSON.stringify(compiled)},false,true,false)`,
      )
      await session.evaluate(`Scripts.execStorage(${JSON.stringify(compiled)})`)
    } else await session.evaluate(`Scripts.execStorage(${JSON.stringify(script)})`)
  }
  try {
    await session.start()
    await run('text-contract')
    return {
      ...harness,
      continue: () => run('text-continuation'),
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

  test(
    `${mode}: drawText requires four arguments but accepts an explicitly void color`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      const run = await fixture(
        binary,
        catchCalls([
          'layer.drawText()',
          'layer.drawText(0)',
          'layer.drawText(0,0)',
          'layer.drawText(0,0,"A")',
        ]),
        probe.graphics,
        String.raw`
layer.fillRect(0,0,16,16,0xffffffff);layer.imageModified=false;
layer.drawText(0,0,"A",void);
var explicitVoid=[layer.getMainPixel(0,0),layer.getMaskPixel(0,0),
  int(layer.imageModified)].join(",");
`,
      )
      try {
        const errors = (await run.session.evaluate('errors.join("|")')).split('|')
        assert.equal(errors.length, 4)
        for (const error of errors) assert.match(error, /requires at least four arguments/)
        probe.assertUntouched()
        probe.open()
        await run.continue()
        assert.equal(await run.session.evaluate('explicitVoid'), '0,255,1')
        assert.equal(probe.calls.glyph, 1)
        assert.equal(probe.calls.text, 0)
      } finally {
        await run.stop()
      }
    },
  )

  test(
    `${mode}: drawText passes TJS boolean antialias values including fractional reals to the glyph backend`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      probe.open()
      const run = await fixture(
        binary,
        String.raw`
layer.drawText(0,0,"A",0x123456);
layer.drawText(1,0,"A",0x123456,255,void);
layer.drawText(2,0,"A",0x123456,255,true);
layer.drawText(3,0,"A",0x123456,255,false);
layer.drawText(4,0,"A",0x123456,255,0.5);
layer.drawText(5,0,"A",0x123456,255,0);
layer.drawText(6,0,"A",0x123456,255,-0.5);
var colors=[],alpha=[];
for(var x=0;x<7;x++){
  colors.add(layer.getMainPixel(x,0));alpha.add(layer.getMaskPixel(x,0));
}
`,
        probe.graphics,
      )
      try {
        assert.deepEqual(probe.antialiased, [true, true, true, false, true, false, true])
        assert.equal(
          await run.session.evaluate('colors.join(",")'),
          Array(7).fill(0x123456).join(','),
        )
        assert.equal(await run.session.evaluate('alpha.join(",")'), Array(7).fill(255).join(','))
        assert.equal(probe.calls.glyph, 7)
        assert.equal(probe.calls.text, 0)
      } finally {
        await run.stop()
      }
    },
  )

  test(
    `${mode}: six Font measurements and mapPrerenderedFont reject missing required arguments before backend work`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      const run = await fixture(
        binary,
        'var font=layer.font;' +
          catchCalls([...queries.map((method) => `font.${method}()`), 'font.mapPrerenderedFont()']),
        probe.graphics,
        String.raw`
var explicitVoid=[font.getTextWidth(void),font.getTextHeight(void),
  int(font.getEscWidthX(void)),int(font.getEscWidthY(void)),
  int(font.getEscHeightX(void)),int(font.getEscHeightY(void))].join(",");
`,
      )
      try {
        const errors = (await run.session.evaluate('errors.join("|")')).split('|')
        assert.equal(errors.length, 7)
        for (let i = 0; i < queries.length; i++)
          assert.match(errors[i]!, new RegExp(`Missing text for ${queries[i]}`))
        assert.match(errors[6]!, /Missing storage for mapPrerenderedFont/)
        probe.assertUntouched()
        probe.open()
        await run.continue()
        assert.equal(await run.session.evaluate('explicitVoid'), '0,12,0,0,0,12')
        assert.equal(probe.calls.glyph, 0)
        assert.equal(probe.calls.loadFont, 0)
      } finally {
        await run.stop()
      }
    },
  )

  for (const cached of [false, true])
    test(
      `${mode}: ${cached ? 'cached' : 'independent'} Font rejects six measurements without an owner image while properties and restored measurements remain usable`,
      { timeout: 60000 },
      async () => {
        const probe = backend()
        const run = await fixture(
          binary,
          String.raw`
var font=${cached ? 'layer.font' : 'new Font(layer)'};
layer.hasImage=false;
font.face="contract.ttf";font.faceIsFileName=true;
font.height=12;font.angle=0;font.bold=true;font.italic=true;
font.underline=true;font.strikeout=true;
var properties=[font.face,int(font.faceIsFileName),font.height,font.angle,
  int(font.bold),int(font.italic),int(font.underline),int(font.strikeout)].join(",");
${catchCalls(queries.map((method) => `var measured=font.${method}("AB")`))}
`,
          probe.graphics,
          String.raw`
layer.hasImage=true;
var restored=[font.getTextWidth("AB"),font.getTextHeight("AB"),
  int(font.getEscWidthX("AB")),int(font.getEscWidthY("AB")),
  int(font.getEscHeightX("AB")),int(font.getEscHeightY("AB"))].join(",");
var restoredIdentity=(isvalid font)+","+(font===layer.font);
`,
        )
        try {
          const errors = (await run.session.evaluate('errors.join("|")')).split('|')
          assert.equal(errors.length, queries.length)
          for (const error of errors) assert.match(error, /This layer has no drawable image/)
          assert.equal(await run.session.evaluate('properties'), 'contract.ttf,1,12,0,1,1,1,1')
          probe.assertUntouched()
          probe.open()
          await run.continue()
          assert.equal(await run.session.evaluate('restored'), '14,12,14,0,0,12')
          assert.equal(await run.session.evaluate('restoredIdentity'), cached ? '1,1' : '1,0')
          assert.equal(probe.calls.loadFont, 1)
          assert.ok(probe.calls.measure > 0)
          assert.equal(probe.calls.glyph, 0)
          assert.equal(probe.calls.measureGlyph, 0)
        } finally {
          await run.stop()
        }
        assert.equal(probe.released, 1)
      },
    )

  test(
    `${mode}: drawText rejects missing images, mask/province faces and negative additive opacity before loading or rasterizing a font`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      const run = await fixture(
        binary,
        String.raw`
layer.font.face="contract.ttf";layer.font.faceIsFileName=true;
layer.hasImage=false;layer.imageModified=false;
${catchCalls(['layer.drawText(0,0,"A",0xabcdef,255)', 'layer.drawText(0,0,"A",0xabcdef,0)', 'layer.drawText(0,0,"",0xabcdef,0)'], 'imageErrors')}
var absentModified=int(layer.imageModified);
layer.hasImage=true;layer.setMainPixel(0,0,0x123456);layer.setMaskPixel(0,0,87);
layer.imageModified=false;
${catchCalls(
  [
    'layer.face=dfMask;layer.drawText(0,0,"A",0xabcdef,255)',
    'layer.face=dfMask;layer.drawText(0,0,"A",0xabcdef,0)',
    'layer.face=dfMask;layer.drawText(0,0,"",0xabcdef,0)',
    'layer.face=dfProvince;layer.drawText(0,0,"A",0xabcdef,255)',
    'layer.face=dfProvince;layer.drawText(0,0,"A",0xabcdef,0)',
    'layer.face=dfProvince;layer.drawText(0,0,"",0xabcdef,0)',
    'layer.face=dfAddAlpha;layer.drawText(0,0,"A",0xabcdef,-1)',
    'layer.face=dfAddAlpha;layer.drawText(0,0,"A",0xabcdef,-255)',
    'layer.face=dfAddAlpha;layer.drawText(0,0,"",0xabcdef,-1)',
  ],
  'faceErrors',
)}
var unchanged=[layer.getMainPixel(0,0),layer.getMaskPixel(0,0),
  int(layer.imageModified)].join(",");
`,
        probe.graphics,
        String.raw`
layer.face=dfAlpha;layer.drawText(0,0,"A",0xabcdef);
var drawn=[layer.getMainPixel(0,0),layer.getMaskPixel(0,0),
  int(layer.imageModified)].join(",");
`,
      )
      try {
        const imageErrors = (await run.session.evaluate('imageErrors.join("|")')).split('|'),
          faceErrors = (await run.session.evaluate('faceErrors.join("|")')).split('|')
        assert.equal(imageErrors.length, 3)
        for (const error of imageErrors) assert.match(error, /This layer has no drawable image/)
        assert.equal(faceErrors.length, 9)
        for (const error of faceErrors.slice(0, 6))
          assert.match(error, /Text drawing requires dfAlpha, dfOpaque or dfAddAlpha/)
        for (const error of faceErrors.slice(6))
          assert.match(error, /Negative text opacity is not supported on dfAddAlpha/)
        assert.equal(await run.session.evaluate('absentModified'), '0')
        assert.equal(await run.session.evaluate('unchanged'), `${0x123456},87,0`)
        probe.assertUntouched()
        probe.open()
        await run.continue()
        assert.equal(await run.session.evaluate('drawn'), `${0xabcdef},255,1`)
        assert.equal(probe.calls.loadFont, 1)
        assert.equal(probe.calls.glyph, 1)
      } finally {
        await run.stop()
      }
      assert.equal(probe.released, 1)
    },
  )

  test(
    `${mode}: drawText narrows native 32-bit fields before opacity checks, coordinate clipping and font work`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      const run = await fixture(
        binary,
        String.raw`
layer.font.face="contract.ttf";layer.font.faceIsFileName=true;
layer.setMainPixel(0,0,0x123456);layer.setMaskPixel(0,0,87);
var cases=[[dfAlpha,0x100000000],[dfOpaque,0x100000000],
  [dfAddAlpha,0x100000000],[dfAlpha,-0x100000000],
  [dfOpaque,0xffffffff],[dfOpaque,-0x100000001],
  [dfAlpha,0x20000000000000]],states=[];
for(var i=0;i<cases.count;i++){
  layer.face=cases[i][0];layer.imageModified=false;
  layer.drawText(0,0,"A",0xabcdef,cases[i][1]);
  states.add([layer.getMainPixel(0,0),layer.getMaskPixel(0,0),
    int(layer.imageModified)].join(","));
}
layer.face=dfAddAlpha;
${catchCalls(['layer.drawText(0,0,"A",0xabcdef,0xffffffff)'])}
`,
        probe.graphics,
        String.raw`
// Values beyond Number.MAX_SAFE_INTEGER retain their low DWORD in the host.
// All coordinates and shadow parameters below wrap to zero.
layer.face=dfAlpha;
layer.drawText(0x100000000,-0x100000000,"A",0x20000000abcdef,
  0x200000000000ff,true,0x100000000,0x20000000123456,
  0x100000000,-0x100000000,0x100000000);
var painted=[layer.getMainPixel(0,0),layer.getMaskPixel(0,0)].join(",");
// Positive TJS integer -> negative native opacity; remove alpha only.
layer.drawText(0,0,"A",0,0xffffff01);
var removed=[layer.getMainPixel(0,0),layer.getMaskPixel(0,0)].join(",");
// Negative TJS integer -> positive native opacity; AddAlpha must accept it.
layer.face=dfAddAlpha;layer.drawText(1,0,"A",0xabcdef,-0xffffff01);
var added=[layer.getMainPixel(1,0),layer.getMaskPixel(1,0)].join(",");
`,
      )
      try {
        assert.equal(
          await run.session.evaluate('states.join("|")'),
          Array(7).fill(`${0x123456},87,0`).join('|'),
        )
        assert.match(
          await run.session.evaluate('errors[0]'),
          /Negative text opacity is not supported on dfAddAlpha/,
        )
        probe.assertUntouched()
        probe.open()
        await run.continue()
        assert.equal(await run.session.evaluate('painted'), `${0xabcdef},255`)
        assert.equal(await run.session.evaluate('removed'), `${0xabcdef},0`)
        assert.equal(await run.session.evaluate('added'), `${0xabcdef},255`)
        assert.equal(probe.calls.loadFont, 1)
        assert.equal(probe.calls.glyph, 3)
      } finally {
        await run.stop()
      }
      assert.equal(probe.released, 1)
    },
  )

  test(
    `${mode}: zero opacity on valid text faces and negative opaque opacity preserve pixels and imageModified without backend work`,
    { timeout: 60000 },
    async () => {
      const probe = backend()
      const run = await fixture(
        binary,
        String.raw`
layer.font.face="contract.ttf";layer.font.faceIsFileName=true;
layer.setMainPixel(0,0,0x123456);layer.setMaskPixel(0,0,87);
var cases=[[dfAlpha,0],[dfOpaque,0],[dfAddAlpha,0],[dfAuto,0],
  [dfOpaque,-1],[dfOpaque,-255]],states=[];
for(var hold=0;hold<2;hold++)for(var i=0;i<cases.count;i++){
  layer.face=cases[i][0];layer.holdAlpha=hold;layer.imageModified=false;
  layer.drawText(0,0,"A",0xabcdef,cases[i][1]);
  states.add([layer.getMainPixel(0,0),layer.getMaskPixel(0,0),
    int(layer.imageModified)].join(","));
}
`,
        probe.graphics,
      )
      try {
        assert.equal(
          await run.session.evaluate('states.join("|")'),
          Array(12).fill(`${0x123456},87,0`).join('|'),
        )
        probe.assertUntouched()
      } finally {
        await run.stop()
      }
      assert.equal(probe.released, 0)
    },
  )
}

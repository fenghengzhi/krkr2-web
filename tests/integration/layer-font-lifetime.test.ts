import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { FontSpec, GraphicsDecoder } from '../../src/engine/ports/graphics.ts'

const lifetimeScript = String.raw`
var layerDeaths=0;
class FontOwnerLayer extends Layer {
  function FontOwnerLayer(window){super.Layer(window,null);}
  function finalize(){layerDeaths++;}
}
var win=new Window();
`

async function fixture(binary: boolean, source: string, graphics?: GraphicsDecoder) {
  const harness = await headless(
    { 'startup.tjs': '', 'layer-font-lifetime.tjs': lifetimeScript + source },
    graphics ? { graphics } : {},
  )
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("layer-font-lifetime.tjs","savedata/layer-font-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-font-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-font-lifetime.tjs")')
    return harness
  } catch (error) {
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(
    `${mode}: an external cached Font does not retain its Layer and is invalidated with it`,
    { timeout: 60000 },
    async () => {
      const { session } = await fixture(
        binary,
        'var owner=new FontOwnerLayer(win),font=owner.font;delete global.owner;',
      )
      try {
        assert.equal(await session.evaluate('layerDeaths+","+(isvalid font)'), '1,0')
        await assert.rejects(session.evaluate('font.height'))
      } finally {
        await session.stop()
      }
    },
  )
  test(
    `${mode}: Layer native invalidation releases its cached Font after the script finalizer`,
    { timeout: 60000 },
    async () => {
      const { session } = await fixture(
        binary,
        'var owner=new FontOwnerLayer(win),font=owner.font;owner.finalize();var before=(isvalid owner)+","+(isvalid font);invalidate owner;',
      )
      try {
        assert.equal(await session.evaluate('before'), '1,1')
        assert.equal(await session.evaluate('layerDeaths+","+(isvalid font)'), '2,0')
      } finally {
        await session.stop()
      }
    },
  )
  test(
    `${mode}: a cached Font finalizer failure preserves native bindings for Layer invalidation retry`,
    { timeout: 60000 },
    async () => {
      const { session } = await fixture(
        binary,
        String.raw`
var owner=new FontOwnerLayer(win),font=owner.font,failFont=true,fontDeaths=0,caught="";
font.height=27;
font.finalize=function(){global.fontDeaths++;if(global.failFont)throw new global.Exception("font-finalizer");};
try{invalidate owner;}catch(error){caught=error.message;}
`,
      )
      try {
        assert.match(await session.evaluate('caught'), /font-finalizer/)
        assert.equal(
          await session.evaluate(
            '(isvalid owner)+","+(isvalid font)+","+font.height+","+fontDeaths',
          ),
          '1,1,27,1',
        )
        assert.equal(session.inspectOwnership().layerSources, 1)
        assert.equal(session.inspectOwnership().fontSources, 1)
        await session.evaluate('Scripts.exec("failFont=false;invalidate owner;")')
        assert.equal(await session.evaluate('(isvalid font)+","+fontDeaths'), '0,2')
        assert.equal(session.inspectOwnership().layerSources, 0)
        assert.equal(session.inspectOwnership().fontSources, 0)
      } finally {
        await session.stop()
      }
    },
  )
  test(
    `${mode}: Font construction rejects missing, null, primitive and forged Layer arguments`,
    { timeout: 60000 },
    async () => {
      const { session } = await fixture(
        binary,
        String.raw`
var owner=new FontOwnerLayer(win),rejected=0;
try{new Font();}catch(error){rejected++;}
try{new Font(null);}catch(error){rejected++;}
try{new Font(3);}catch(error){rejected++;}
try{new Font(win);}catch(error){rejected++;}
try{new Font(%[__id:owner.__id]);}catch(error){rejected++;}
`,
      )
      try {
        assert.equal(await session.evaluate('rejected'), '5')
        assert.equal(session.inspectOwnership().layerSources, 1)
        assert.equal(session.inspectOwnership().fontSources, 0)
      } finally {
        await session.stop()
      }
    },
  )
  test(
    `${mode}: calling Font's constructor again preserves its original native Layer binding`,
    { timeout: 60000 },
    async () => {
      const { session } = await fixture(
        binary,
        'var owner=new FontOwnerLayer(win),other=new Layer(win,owner),font=owner.font;font.height=23;other.font.height=7;font.Font(other);',
      )
      try {
        assert.equal(await session.evaluate('font.height+","+other.font.height'), '23,7')
        assert.equal(session.inspectOwnership().fontSources, 2)
      } finally {
        await session.stop()
      }
    },
  )
  test(
    `${mode}: invalidating the cached Font preserves its identity and the Layer's drawing settings`,
    { timeout: 60000 },
    async () => {
      const drawn: FontSpec[] = []
      const graphics: GraphicsDecoder = {
        async decode() {
          throw new Error('Unexpected image decoding')
        },
        measure(text, font) {
          return { width: text.length, height: font.height, ascent: 0 }
        },
        text(_text, _size, _color, font) {
          assert.ok(font)
          drawn.push({ ...font })
          return {
            width: 1,
            height: 1,
            left: 0,
            top: 0,
            data: new Uint8Array([255, 255, 255, 255]),
          }
        },
      }
      const { session } = await fixture(
        binary,
        'var owner=new FontOwnerLayer(win);owner.setSize(8,8);var font=owner.font;font.height=23;font.bold=true;invalidate font;owner.drawText(0,0,"A");',
        graphics,
      )
      try {
        assert.equal(await session.evaluate('(owner.font===font)+","+(isvalid owner.font)'), '1,0')
        assert.equal(drawn.length, 1)
        assert.equal(drawn[0]!.height, 23)
        assert.equal(drawn[0]!.bold, true)
      } finally {
        await session.stop()
      }
    },
  )
}

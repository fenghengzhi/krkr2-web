import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'

async function fixture(binary: boolean, source: string) {
  const frames: Array<{ layers: FrameLayer[]; width: number; height: number }> = []
  const harness = await headless(
    { 'startup.tjs': '', 'opaque-fill.tjs': source },
    {
      renderer: {
        present(layers, width, height) {
          frames.push({
            width,
            height,
            layers: layers.map((layer) => ({
              ...layer,
              clip: { ...layer.clip },
              source: { ...layer.source },
              pixels: { ...layer.pixels, data: layer.pixels.data.slice() },
            })),
          })
        },
        dispose() {},
      },
    },
  )
  const { session } = harness
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("opaque-fill.tjs","savedata/opaque-fill.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/opaque-fill.cjs")')
    } else await session.evaluate('Scripts.execStorage("opaque-fill.tjs")')
    await session.idle()
    return {
      ...harness,
      frames,
      execute: (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      frame(width: number, height: number) {
        const frame = frames.at(-1)
        assert(frame, 'Expected a presented frame')
        assert.equal(frame.width, width)
        assert.equal(frame.height, height)
        assert.equal(frame.layers.length, 1, 'Expected the complete opaque primary frame')
        const layer = frame.layers[0]!
        assert.equal(layer.pixels.width, width)
        assert.equal(layer.pixels.height, height)
        return layer
      },
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

  test(`${mode}: an image-less opaque child preserves raw snapshot masks but renders opaque and refreshes after update`, async () => {
    const { session, execute, frames, frame, stop } = await fixture(
      binary,
      String.raw`
var win=new Window();win.visible=true;win.setInnerSize(2,1);
var root=new Layer(win,null);root.setImageSize(2,1);root.setSize(2,1);root.fillRect(0,0,2,1,0xff000000);
var solid=new Layer(win,root);solid.type=ltOpaque;solid.setSize(1,1);solid.hasImage=false;
solid.neutralColor=0x00123456;solid.visible=true;
var target=new Layer(win,root);target.setImageSize(2,1);
var rejected=0;try{target.piledCopy(0,0,solid,0,0,1,1);}catch(error){rejected++;}
target.piledCopy(0,0,root,0,0,2,1);
var raw=target.getMainPixel(0,0)==0x123456 && target.getMaskPixel(0,0)==0 && target.getMainPixel(1,0)==0 && target.getMaskPixel(1,0)==255;
`,
    )
    try {
      assert.equal(await session.evaluate('raw && rejected==1 && !solid.hasImage'), '1')
      assert.deepEqual([...frame(2, 1).pixels.data], [18, 52, 86, 255, 0, 0, 0, 255])
      const presented = frames.length
      await execute('solid.neutralColor=0x00654321;')
      assert.equal(frames.length, presented, 'The setter alone must not request presentation')
      assert.deepEqual([...frame(2, 1).pixels.data], [18, 52, 86, 255, 0, 0, 0, 255])
      await execute('solid.update();')
      assert(frames.length > presented)
      assert.deepEqual([...frame(2, 1).pixels.data], [101, 67, 33, 255, 0, 0, 0, 255])
      await execute('target.piledCopy(0,0,root,0,0,2,1);')
      assert.equal(
        await session.evaluate(
          'target.getMainPixel(0,0)==0x654321 && target.getMaskPixel(0,0)==0 && !solid.hasImage',
        ),
        '1',
      )
    } finally {
      await stop()
    }
  })

  test(`${mode}: an image-less opaque group blends once while alpha and binder overrides remain transparent`, async () => {
    const { session, frame, stop } = await fixture(
      binary,
      String.raw`
var win=new Window();win.visible=true;win.setInnerSize(6,1);
var root=new Layer(win,null);root.setImageSize(6,1);root.setSize(6,1);root.fillRect(0,0,6,1,0xff000000);
var group=new Layer(win,root);group.type=ltOpaque;group.setSize(2,1);group.hasImage=false;
group.neutralColor=0x00800000;group.opacity=128;group.visible=true;
var child=new Layer(win,group);child.type=ltOpaque;child.setImageSize(1,1);child.setSize(1,1);child.left=1;
child.fillRect(0,0,1,1,0xff008000);child.visible=true;
var alpha=new Layer(win,root);alpha.setSize(2,1);alpha.left=2;alpha.hasImage=false;
alpha.neutralColor=0xff0000ff;alpha.opacity=128;alpha.visible=true;
var binder=new Layer(win,root);binder.type=ltBinder;binder.setSize(2,1);binder.left=4;
binder.neutralColor=0xffffff00;binder.opacity=128;binder.visible=true;
var target=new Layer(win,root);target.setImageSize(6,1);target.piledCopy(0,0,root,0,0,6,1);
var colors=[];for(var x=0;x<6;x++)colors.add(target.getMainPixel(x,0));
`,
    )
    try {
      assert.equal(await session.evaluate('colors.join(",")'), '4194304,16384,0,0,0,0')
      assert.equal(
        await session.evaluate('!group.hasImage && !alpha.hasImage && !binder.hasImage'),
        '1',
      )
      assert.deepEqual(
        [...frame(6, 1).pixels.data],
        [64, 0, 0, 255, 0, 64, 0, 255, ...Array(4).fill([0, 0, 0, 255]).flat()],
      )
    } finally {
      await stop()
    }
  })

  test(`${mode}: a primary opaque fill follows resize and image restoration without allocating a hidden bitmap`, async () => {
    const { session, execute, frame, stop } = await fixture(
      binary,
      String.raw`
var win=new Window();win.visible=true;win.setInnerSize(2,1);
var root=new Layer(win,null);root.setSize(2,1);root.hasImage=false;root.neutralColor=0x00123456;
`,
    )
    try {
      assert.equal(await session.evaluate('int(root.hasImage)'), '0')
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert.deepEqual([...frame(2, 1).pixels.data], [18, 52, 86, 255, 18, 52, 86, 255])
      await execute('root.setSize(3,2);win.setInnerSize(3,2);')
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert.deepEqual([...frame(3, 2).pixels.data], Array(6).fill([18, 52, 86, 255]).flat())
      await execute('root.hasImage=true;root.fillRect(0,0,3,2,0xff00ff00);')
      assert.equal(session.snapshot().bitmapBytes, 24)
      assert.equal(await session.evaluate('root.imageWidth+","+root.imageHeight'), '3,2')
      assert.deepEqual([...frame(3, 2).pixels.data], Array(6).fill([0, 255, 0, 255]).flat())
      await execute('root.neutralColor=0x00000080;root.update();')
      assert.deepEqual([...frame(3, 2).pixels.data], Array(6).fill([0, 255, 0, 255]).flat())
      await execute('root.hasImage=false;')
      assert.equal(session.snapshot().bitmapBytes, 0)
      assert.deepEqual([...frame(3, 2).pixels.data], Array(6).fill([0, 0, 128, 255]).flat())
    } finally {
      await stop()
    }
  })
}

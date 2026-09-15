import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'

async function fixture(
  binary: boolean,
  options: {
    kind?: 'crossfade' | 'universal'
    children?: boolean
    rule?: number[]
    vague?: number
    time?: number
    type?: string
    afterBegin?: string
    sourceMask?: number
  },
) {
  const levels = options.rule ?? [127, 127],
    width = levels.length
  let displayed: number[] = []
  const { session } = await headless(
    {
      'startup.tjs': '',
      'rule.bmp': encodeBmp({
        width,
        height: 1,
        data: Uint8Array.from(levels.flatMap((value) => [value, value, value, 255])),
      }),
      'opaque-transition.tjs': String.raw`
var win=new Window();win.setInnerSize(${width},1);win.visible=true;
var root=new Layer(win,null),fore=new Layer(win,root),back=new Layer(win,root),saved=new Layer(win,root);
root.setSize(${width},1);root.fillRect(0,0,${width},1,0xff000000);
fore.setImageSize(${width},1);fore.setSize(${width},1);fore.type=${options.type ?? 'ltOpaque'};fore.visible=true;
back.setImageSize(${width},1);back.setSize(${width},1);back.type=ltAlpha;
saved.setImageSize(${width},1);saved.setSize(${width},1);
for(var x=0;x<${width};x++){
  fore.setMainPixel(x,0,0);fore.setMaskPixel(x,0,19);
  back.setMainPixel(x,0,0xffffff);back.setMaskPixel(x,0,${options.sourceMask ?? 1});
}
// Drawing-face flags do not select the transition's destination kernel.
fore.face=dfAlpha;fore.holdAlpha=true;back.face=dfMask;back.holdAlpha=false;
${options.children ? 'var child=new Layer(win,back);child.setImageSize(1,1);child.setSize(1,1);child.setPos(1,0);child.type=ltOpaque;child.setMainPixel(0,0,0x00ff00);child.visible=true;' : ''}
var tick=0,done=0;
fore.onTransitionCompleted=function(dest,src){if(dest!==fore||src!==back)throw new Exception("wrong transition identity");done++;};
fore.beginTransition("${options.kind ?? 'crossfade'}",${!!options.children},back,%[time:${options.time ?? 1000},rule:"rule",vague:${options.vague ?? 64},selfupdate:true,callback:function(){return tick;}]);
${options.afterBegin ?? ''}
function sample(next){
  tick=next;fore.update();
  saved.piledCopy(0,0,fore,0,0,${width},1);
  var row=[];for(var x=0;x<${width};x++)row.add(saved.getMainPixel(x,0)+":"+saved.getMaskPixel(x,0));
  return row.join(",");
}
`,
    },
    {
      renderer: {
        present(layers) {
          const fore = layers.find((layer) => layer.id === -2 || layer.id === -1)
          if (fore) displayed = [...fore.pixels.data]
        },
        dispose() {},
      },
    },
  )
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("opaque-transition.tjs","savedata/opaque-transition.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/opaque-transition.cjs")')
    } else await session.evaluate('Scripts.execStorage("opaque-transition.tjs")')
    // Warm and sample in distinct VM calls. A synchronous completion may
    // coalesce paints within one call; it must not accidentally be our clock.
    assert.equal(
      await session.evaluate('sample(0)'),
      Array.from({ length: width }, () =>
        options.type === 'ltAlpha' || options.type === 'ltAddAlpha' ? '0:255' : '0:19',
      ).join(','),
    )
    return {
      session,
      displayed: () => displayed,
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
  for (const children of [false, true])
    test(`${mode}: opaque crossfade ${children ? 'includes completed children' : 'blends only main images'} with exact fixed pixels`, async () => {
      const f = await fixture(binary, { children })
      try {
        assert.equal(
          await f.session.evaluate('sample(500)'),
          children ? '8289918:0,32256:0' : '8289918:0,8289918:0',
        )
        assert.deepEqual(
          f.displayed(),
          children
            ? [126, 126, 126, 255, 0, 126, 0, 255]
            : [126, 126, 126, 255, 126, 126, 126, 255],
        )
        assert.equal(
          await f.session.evaluate('sample(999)'),
          children ? '16645629:0,64768:0' : '16645629:0,16645629:0',
        )
        // evaluate uses TJS expression mode, which injects an initial return.
        // Keep both statements inside a callable expression so update runs.
        await f.session.evaluate('(function(){tick=1000;fore.update();return 0;})()')
        assert.equal(
          await f.session.evaluate(
            '[done,int(back.visible),int(fore.visible),back.getMainPixel(0,0),back.getMaskPixel(0,0)].join(",")',
          ),
          '1,1,0,16777215,1',
          'completion count, source visibility, destination visibility, source RGB, source mask',
        )
      } finally {
        await f.stop()
      }
    })

  test(`${mode}: opaque universal preserves strict copy boundaries and the integer blend table`, async () => {
    const f = await fixture(binary, { kind: 'universal', rule: [94, 95, 127, 158, 159] })
    try {
      assert.equal(
        await f.session.evaluate('sample(500)'),
        '16777215:1,16711422:0,8355711:0,197379:0,0:19',
      )
      assert.deepEqual(
        f.displayed(),
        [255, 255, 255, 255, 254, 254, 254, 255, 127, 127, 127, 255, 3, 3, 3, 255, 0, 0, 0, 255],
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: universal rule zero at phase equal to vague still blends instead of copying`, async () => {
    const f = await fixture(binary, { kind: 'universal', rule: [0], time: 319, vague: 64 })
    try {
      assert.equal(await f.session.evaluate('sample(64)'), '16711422:0')
      assert.equal(await f.session.evaluate('sample(65)'), '16777215:1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: universal vague 512 uses table blending even below the lower threshold`, async () => {
    const f = await fixture(binary, { kind: 'universal', rule: [31, 32], time: 767, vague: 512 })
    try {
      assert.equal(await f.session.evaluate('sample(544)'), '16711422:0,16711422:0')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: the opaque transition kernel retains its begin-time destination type`, async () => {
    const f = await fixture(binary, { afterBegin: 'fore.type=ltAlpha;' })
    try {
      assert.equal(await f.session.evaluate('sample(500)'), '8289918:0,8289918:0')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: basic additive display type uses the native opaque transition kernel`, async () => {
    const f = await fixture(binary, { type: 'ltAdditive' })
    try {
      assert.equal(await f.session.evaluate('sample(500)'), '8289918:0,8289918:0')
    } finally {
      await f.stop()
    }
  })

  for (const type of ['ltAlpha', 'ltAddAlpha'])
    test(`${mode}: ${type} retains its existing transition path independently of drawing face`, async () => {
      const f = await fixture(binary, {
        type,
        sourceMask: 255,
        afterBegin: 'fore.setMaskPixel(0,0,255);fore.setMaskPixel(1,0,255);fore.face=dfOpaque;',
      })
      try {
        assert.equal(await f.session.evaluate('sample(500)'), '8355711:255,8355711:255')
      } finally {
        await f.stop()
      }
    })
}

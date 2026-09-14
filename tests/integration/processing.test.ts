import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'

test('TJS image processing selects representation from face and preserves unrelated planes', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root);
layer.setImageSize(2,1);layer.fillRect(0,0,2,1,0x80c86432);layer.setProvincePixel(0,0,11);layer.setProvincePixel(1,0,22);
layer.setClip(0,0,1,1);layer.face=dfAddAlpha;layer.convertType(dfAlpha);
var converted=layer.getMainPixel(0,0)==0x643219 && layer.getMainPixel(1,0)==0x643219 && layer.getMaskPixel(1,0)==128 && layer.type==ltAlpha;
layer.face=dfAlpha;layer.convertType(dfAddAlpha);
var restored=layer.getMainPixel(1,0)==0xc76331 && layer.getMaskPixel(1,0)==128;
layer.face=dfProvince;layer.holdAlpha=true;layer.imageModified=false;layer.flipLR();
var flipped=layer.getProvincePixel(0,0)==22 && layer.getProvincePixel(1,0)==11 && layer.imageModified;
layer.doGrayScale();var clipped=layer.getMainPixel(0,0)==0x747474 && layer.getMainPixel(1,0)==0xc76331 && layer.getMaskPixel(0,0)==128 && layer.getProvincePixel(0,0)==22;
layer.setClip(0,0,2,1);layer.face=dfAlpha;layer.fillRect(0,0,1,1,0x00ff0000);layer.fillRect(1,0,1,1,0xff0000ff);layer.doBoxBlur(1,0);
var blurred=layer.getMainPixel(0,0)==0x0000ff && layer.getMaskPixel(0,0)==128 && layer.getProvincePixel(0,0)==22;
layer.imageModified=false;layer.doBoxBlur(0,0);var zeroOK=!layer.imageModified;
var rejected=0;try{layer.convertType(dfAuto);}catch(e){rejected++;}try{layer.convertType(dfAlpha);}catch(e){rejected++;}
layer.hasImage=false;layer.face=dfAddAlpha;layer.convertType(dfAlpha);var absentOK=!layer.hasImage && layer.imageModified;
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'converted && restored && flipped && clipped && blurred && zeroOK && absentOK && rejected==2',
      ),
      '1',
    )
  } finally {
    await session.stop()
  }
})

test('cancelling box blur releases suspended work before any completion callback', async () => {
  let resolveYield: () => void = () => {},
    wake: () => void = () => {},
    held = false,
    ticks = 0
  const yielded = new Promise<void>((resolve) => {
    resolveYield = resolve
  })
  const { session, logs } = await headless(
    {
      'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null);root.setImageSize(256,256);root.fillRect(0,0,256,256,0xff123456);
Debug.message("blur-start");root.doBoxBlur(30,30);Debug.message("blur-finished");
`,
    },
    {
      now: () => (ticks += 10),
      schedule: (callback, delay) => {
        if (delay === 0 && !held) {
          held = true
          wake = callback
          resolveYield()
          return () => {}
        }
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      },
    },
  )
  try {
    const started = session.start()
    await yielded
    assert.ok(logs.includes('blur-start'))
    session.pause()
    wake()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(logs.includes('blur-finished'), false)
    const results = await Promise.allSettled([started, session.stop()])
    assert.equal(results[1]!.status, 'fulfilled')
    assert.equal(logs.includes('blur-finished'), false)
  } finally {
    await session.stop()
  }
})

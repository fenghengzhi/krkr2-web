import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'

test('TJS affine methods use image coordinates, omAuto, legacy alpha semantics and reusable image storage', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),source=new Layer(window,root),target=new Layer(window,root);
source.setImageSize(3,2);source.fillRect(0,0,3,2,0x00204060);source.type=ltAdditive;source.face=dfProvince;
target.setImageSize(6,4);target.fillRect(0,0,6,4,0x49406080);target.face=dfOpaque;target.holdAlpha=true;
target.operateAffine(source,1,0,2,2,true,0,1,-1,0,3,1);
var operationOK=target.getMainPixel(3,1)==0x60a0e0 && target.getMainPixel(2,2)==0x60a0e0 && target.getMaskPixel(3,1)==73 && target.getMainPixel(1,1)==0x406080;
target.affinePile(source,1,0,2,2,false,1.5,0.5,3.5,0.5,1.5,2.5);
var pileOK=target.getMainPixel(2,1)==0x60a0e0;
target.affineBlend(source,1,0,2,2,true,1,0,0,1,2,1);
var blendOK=target.getMainPixel(2,1)==0x204060 && target.getMaskPixel(2,1)==73;
target.setClip(1,1,4,2);target.affineCopy(source,1,0,2,2,true,1,0,0,1,2,1,stNearest,true);
var clearOK=target.getMainPixel(1,1)==0xffffff && target.getMaskPixel(1,1)==73 && target.getMainPixel(2,1)==0x204060 && target.getMainPixel(0,0)==0x406080;
target.imageModified=false;target.operateAffine(source,0,0,3,2,true,1,0,0,1,0,0,omAuto,0);
var zeroOK=!target.imageModified;
target.face=dfMask;var rejected=0;try{target.affineCopy(source,0,0,1,1,true,1,0,0,1,0,0);}catch(e){rejected++;}
target.face=dfAlpha;try{target.operateAffine(source,0,0,1,1,true,1,0,0,1,0,0,0);}catch(e){rejected++;}
try{target.affineCopy(source,-1,0,1,1,true,1,0,0,1,0,0,stNearest,true);}catch(e){rejected++;}
target.hasImage=false;target.imageModified=false;target.type=target.type;
var unchangedTypeOK=!target.hasImage && !target.imageModified;
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'operationOK && pileOK && blendOK && clearOK && zeroOK && unchangedTypeOK && rejected==3',
      ),
      '1',
    )
  } finally {
    await session.stop()
  }
})

test('long affine filtering pauses and cancels before committing pixels', async () => {
  let entered: () => void = () => {},
    resume: () => void = () => {},
    ticks = 0,
    held = false
  const yielded = new Promise<void>((resolve) => {
    entered = resolve
  })
  const { session, logs } = await headless(
    {
      'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),source=new Layer(window,root),target=new Layer(window,root);
source.setImageSize(128,128);source.fillRect(0,0,128,128,0xff123456);
target.setImageSize(128,128);target.fillRect(0,0,128,128,0xffabcdef);
Debug.message("affine-start");target.affineCopy(source,0,0,128,128,true,1,0,0,1,0,0,stGaussian);Debug.message("affine-finished");
`,
    },
    {
      now: () => (ticks += 10),
      schedule: (callback, delay) => {
        if (delay === 0 && !held) {
          held = true
          resume = callback
          entered()
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
    assert.ok(logs.includes('affine-start'))
    session.pause()
    resume()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(logs.includes('affine-finished'), false)
    const stopping = session.stop()
    await Promise.allSettled([started, stopping])
    assert.equal(logs.includes('affine-finished'), false)
  } finally {
    await session.stop()
  }
})

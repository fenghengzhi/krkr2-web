import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'

test('basic and Photoshop operations select the main image even for mask or province draw faces', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),source=new Layer(window,root),target=new Layer(window,root);
source.setImageSize(1,1);source.fillRect(0,0,1,1,0xff102030);
target.setImageSize(3,1);target.fillRect(0,0,3,1,0x49202020);
target.face=dfProvince;target.fillRect(0,0,3,1,101);
target.operateRect(0,0,source,0,0,1,1,omAdditive);
target.operateStretch(1,0,1,1,source,0,0,1,1,omAdditive);
target.operateAffine(source,0,0,1,1,true,1,0,0,1,2,0,omAdditive);
var basicOK=true;
for(var x=0;x<3;x++)basicOK=basicOK && target.getMainPixel(x,0)==0x304050 && target.getProvincePixel(x,0)==101 && target.getMaskPixel(x,0)==255;
target.face=dfMask;target.holdAlpha=true;source.setMaskPixel(0,0,0);
target.operateRect(0,0,source,0,0,1,1,omPsNormal);
target.operateStretch(1,0,1,1,source,0,0,1,1,omPsNormal);
target.operateAffine(source,0,0,1,1,true,1,0,0,1,2,0,omPsNormal);
var psOK=true;for(var x=0;x<3;x++)psOK=psOK && target.getMainPixel(x,0)==0x304050 && target.getMaskPixel(x,0)==255 && target.getProvincePixel(x,0)==101;
var rejected=0;try{target.operateRect(0,0,source,0,0,1,1,omAlpha);}catch(e){rejected++;}
try{target.affineCopy(source,0,0,1,1,true,1,0,0,1,0,0);}catch(e){rejected++;}
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('basicOK && psOK && rejected==2'), '1')
  } finally {
    await session.stop()
  }
})

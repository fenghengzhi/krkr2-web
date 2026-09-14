import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('TJS image operations resolve omAuto, preserve holdAlpha and distinguish legacy pile/blend calls', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),source=new Layer(window,root),target=new Layer(window,root);
source.setImageSize(2,1);source.fillRect(0,0,2,1,0x00204060);source.type=ltAdditive;source.face=dfProvince;
target.setImageSize(4,1);target.fillRect(0,0,4,1,0x49406080);target.face=dfOpaque;target.holdAlpha=true;
target.operateRect(0,0,source,0,0,2,1);
var autoOK=target.getMainPixel(0,0)==0x60a0e0 && target.getMaskPixel(0,0)==73;
target.pileRect(0,0,source,0,0,1,1);
var pileOK=target.getMainPixel(0,0)==0x60a0e0;
target.blendRect(1,0,source,0,0,1,1);
var blendOK=target.getMainPixel(1,0)==0x204060 && target.getMaskPixel(1,0)==73;
target.operateStretch(2,0,2,1,source,0,0,1,1);
var stretchOK=target.getMainPixel(2,0)==0x60a0e0 && target.getMainPixel(3,0)==0x60a0e0;
target.stretchBlend(2,0,2,1,source,0,0,1,1);
target.stretchPile(2,0,2,1,source,0,0,1,1);
var legacyStretchOK=target.getMainPixel(2,0)==0x204060 && target.getMaskPixel(3,0)==73;
target.imageModified=false;target.operateStretch(0,0,4,1,source,0,0,2,1,omAuto,0);
var zeroOpacityOK=!target.imageModified;
target.face=dfAddAlpha;var rejected=0;try{target.pileRect(0,0,source,0,0,1,1);}catch(e){rejected++;}
try{target.operateRect(0,0,source,0,0,1,1,999);}catch(e){rejected++;}
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'autoOK && pileOK && blendOK && stretchOK && legacyStretchOK && zeroOpacityOK && rejected==2',
      ),
      '1',
    )
  } finally {
    await session.stop()
  }
})

test('all drawable layer types expose the proper automatic draw face and neutral allocation color', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root),results=[];
var modes=[1,2,3,4,5,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28];
for(var i=0;i<modes.count;i++){
 layer.type=ltBinder;layer.type=modes[i];
 var color=layer.neutralColor;
 var allocation=layer.getMainPixel(0,0)==color && layer.getMaskPixel(0,0)==0;
 layer.fillRect(0,0,1,1,0x40302010);layer.holdAlpha=true;layer.fillRect(0,0,1,1,0x80102030);
 results.add(string(modes[i])+":"+string(allocation)+":"+string(layer.getMaskPixel(0,0)));
 layer.holdAlpha=false;
}
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate('results.join(",")'),
      '1:1:64,2:1:128,3:1:64,4:1:64,5:1:64,8:1:64,9:1:64,10:1:64,11:1:64,12:1:128,13:1:128,14:1:128,15:1:128,16:1:128,17:1:128,18:1:128,19:1:128,20:1:128,21:1:128,22:1:128,23:1:128,24:1:128,25:1:128,26:1:128,27:1:128,28:1:128',
    )
  } finally {
    await session.stop()
  }
})

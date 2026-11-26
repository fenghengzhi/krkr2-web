import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { spriteSamplingCases, spriteSamplingSource } from '../helpers/sprite-sampling.ts'
import { Bitmap } from '../../src/engine/graphics/bitmap.ts'
import { affinePixels } from '../../src/engine/graphics/affine.ts'
import { stretchPixels } from '../../src/engine/graphics/resample.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: scaled and turned sprites select native samples and masks`, async () => {
  const { session } = await headless({ 'sprites.tjs': spriteSamplingSource, 'startup.tjs': binary
    ? 'Scripts.compileStorage("sprites.tjs","savedata/sprites.cjs",false,true,false);Scripts.execStorage("savedata/sprites.cjs");'
    : 'Scripts.execStorage("sprites.tjs");' })
  try {
    await session.start()
    for (const { id, expected } of spriteSamplingCases)
      assert.equal(await session.evaluate(`spriteSamplingRun("${id}")`), expected, id)
    await session.evaluate('spriteSamplingClose()')
  } finally { await session.stop() }
})

const scriptFilters = [
  ['stSemiFastLinear', 4], ['stFastCubic', 5], ['stLanczos2', 6], ['stFastLanczos2', 7],
  ['stLanczos3', 8], ['stFastLanczos3', 9], ['stSpline16', 10], ['stFastSpline16', 11],
  ['stSpline36', 12], ['stFastSpline36', 13], ['stAreaAvg', 14], ['stFastAreaAvg', 15],
  ['stGaussian', 16], ['stFastGaussian', 17], ['stBlackmanSinc', 18], ['stFastBlackmanSinc', 19],
] as const
const entryPoints = ['stretchCopy', 'operateStretch', 'stretchPile', 'stretchBlend',
  'affineCopy', 'operateAffine', 'affinePile', 'affineBlend'] as const
const abiSource = String.raw`
function spriteAbiRead(){
 var pixels=[];
 for(var y=0;y<4;y++)for(var x=0;x<4;x++)pixels.add(spriteOut.getMainPixel(x,y)+"/"+spriteOut.getMaskPixel(x,y));
 return pixels.join(",");
}
function spriteAbiInitialize(){
 spriteInit(spriteIn,4,4);spriteInit(spriteOut,4,4);
 for(var y=0;y<4;y++)for(var x=0;x<4;x++){
  var i=1+y*4+x;
  spriteIn.setMainPixel(x,y,(i*11<<16)|(i*7<<8)|i*3);spriteIn.setMaskPixel(x,y,255);
 }
}
function spriteAbiDraw(method,type,provided){
 spriteOut.fillRect(0,0,4,4,0x00102030);
 var args,draw;
 if(method<4){
  args=[0,0,4,4,spriteIn,1,1,2,2];
  if(method==0)draw=spriteOut.stretchCopy;
  else if(method==1){draw=spriteOut.operateStretch;args.add(omOpaque);args.add(255);}
  else {draw=method==2?spriteOut.stretchPile:spriteOut.stretchBlend;args.add(255);}
 }else{
  args=[spriteIn,1,1,2,2,true,2,0,0,2,.5,.5];
  if(method==4)draw=spriteOut.affineCopy;
  else if(method==5){draw=spriteOut.operateAffine;args.add(omOpaque);args.add(255);}
  else {draw=method==6?spriteOut.affinePile:spriteOut.affineBlend;args.add(255);}
 }
 if(provided)args.add(type);
 draw(args*);return spriteAbiRead();
}
`

// This is a public-script/embedding ABI comparison, not an independent pixel
// oracle. Stock pixel expectations above remain literal SDK observations.
// The existing direct TypeScript API keeps its modern filter IDs and flag.
function embeddingPixels(method: number, type: number): string {
  const source = new Bitmap(4, 4), target = new Bitmap(4, 4, 0x00102030),
    rect = { x: 1, y: 1, width: 2, height: 2 }, clip = { x: 0, y: 0, width: 4, height: 4 },
    mode = method % 4 === 0 ? 'copy' : method % 4 === 2 ? 2 : 1
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const i = 1 + y * 4 + x
    source.setPixel(x, y, (i * 11 << 16) | (i * 7 << 8) | i * 3, 'main')
    source.setPixel(x, y, 255, 'mask')
  }
  if (method < 4) {
    const output = stretchPixels(source.readPixels, clip, rect, clip, type)
    if (mode === 'copy') target.copyPixels(output.pixels, 0, 0, clip, false, clip)
    else target.operate(output.pixels, 0, 0, clip, mode, 0, 255, false, true)
  } else {
    const work = affinePixels(source.readPixels, rect, true, [2, 0, 0, 2, .5, .5], clip, type)
    let step = work.next()
    while (!step.done) step = work.next()
    target.affine(step.value, mode, 0)
  }
  const pixels: string[] = []
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    pixels.push(target.getPixel(x, y, 'main') + '/' + target.getPixel(x, y, 'mask'))
  return pixels.join(',')
}

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: Layer filter names preserve the modern embedding kernels without colliding with stock flags`, async () => {
  const { session } = await headless({ 'sprites.tjs': spriteSamplingSource + abiSource, 'startup.tjs': binary
    ? 'Scripts.compileStorage("sprites.tjs","savedata/sprites.cjs",false,true,false);Scripts.execStorage("savedata/sprites.cjs");'
    : 'Scripts.execStorage("sprites.tjs");' })
  try {
    await session.start()
    assert.equal(await session.evaluate('[stRefNoClip,stGaussian,stFastGaussian,stBlackmanSinc,stFastBlackmanSinc].join(",")'),
      '16,131072,131073,131074,131075')
    await session.evaluate('spriteAbiInitialize()')
    for (const [method, name] of entryPoints.entries()) {
      for (const [constant, type] of scriptFilters) for (const neighbor of [false, true]) {
        const script = `${constant}${neighbor ? '|stRefNoClip' : ''}`
        assert.equal(await session.evaluate(`spriteAbiDraw(${method},${script},true)`),
          embeddingPixels(method, type | (neighbor ? 0x10000 : 0)), `${name}: ${script}`)
      }
      const nearest = embeddingPixels(method, 0)
      assert.equal(await session.evaluate(`spriteAbiDraw(${method},void,false)`), nearest, `${name}: omitted filter`)
      assert.equal(await session.evaluate(`spriteAbiDraw(${method},void,true)`), nearest, `${name}: void filter`)
      assert.equal(await session.evaluate(`spriteAbiDraw(${method},stNearest,true)`), nearest, `${name}: named nearest`)
      for (const bad of [-1, 0x20004, 0x40000]) {
        await assert.rejects(session.evaluate(`spriteAbiDraw(${method},${bad},true)`), /(?:stretch|affine).*filter/i)
        assert.equal(await session.evaluate('spriteAbiRead()'), Array(16).fill('1056816/0').join(','), `${name}: rejected ${bad} left pixels intact`)
      }
    }
    await session.evaluate('spriteSamplingClose()')
  } finally { await session.stop() }
})

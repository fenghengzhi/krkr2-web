import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import type { EngineSession } from '../../src/engine/session.ts'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import { layerFixture } from '../helpers/layer-lifetime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

// Every operation under test lives in the fixture, so bytecode mode executes
// compiled function bodies rather than merely constructing compiled classes.
const owners = String.raw`
var win=null,root=null,layer=null,child=null;
function makeOwner(width,height) {
  global.win=new global.LifetimeLayerWindow();
  global.root=new global.Layer(win,null);root.hasImage=false;root.setSize(8,8);
  global.layer=new global.LifetimeLayer(win,root);
  layer.setSize(width,height);layer.setImageSize(width,height);
}
function dropOwners() {
  delete global.child;delete global.layer;delete global.root;delete global.win;
}
`

function layers(session: EngineSession) {
  return (session as unknown as { layers: Pick<LayerTree, 'get' | 'has'> }).layers
}

function planeSnapshot(session: EngineSession, id: number) {
  const layer = layers(session).get(id)
  return {
    geometry: [layer.left, layer.top, layer.width, layer.height, layer.imageLeft, layer.imageTop],
    clip: { ...(layer.bitmap?.clip ?? layer.clipBeforeRelease) },
    main: layer.bitmap
      ? {
          width: layer.bitmap.pixels.width,
          height: layer.bitmap.pixels.height,
          data: [...layer.bitmap.pixels.data],
        }
      : undefined,
    province: layer.province
      ? {
          width: layer.province.width,
          height: layer.province.height,
          data: [...layer.province.data],
        }
      : undefined,
    imageModified: layer.imageModified,
    revision: layer.revision,
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: independent Province dimensions account exact bytes through restoration and image release`, async () => {
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
function createProvince() {
  makeOwner(3,2);layer.hasImage=false;layer.setProvincePixel(2,1,41);
}
function growRect() {layer.setSize(5,4);}
function restoreMain() {layer.hasImage=true;}
function resizeImages() {layer.setImageSize(6,5);}
function dropMain() {layer.hasImage=false;}
function recreateProvince() {layer.setProvincePixel(2,1,53);}
function becomeBinder() {layer.type=ltBinder;}
function sameBinder() {layer.type=ltBinder;}
function becomeAlpha() {layer.type=ltAlpha;}
`,
    )
    try {
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('createProvince()')
      const id = Number(await f.session.evaluate('layer.__id'))
      assert.equal(f.session.snapshot().bitmapBytes, 6)
      await f.session.evaluate('growRect()')
      assert.equal(f.session.snapshot().bitmapBytes, 6)
      assert.deepEqual(
        [layers(f.session).get(id).province?.width, layers(f.session).get(id).province?.height],
        [3, 2],
      )
      await f.session.evaluate('restoreMain()')
      assert.equal(f.session.snapshot().bitmapBytes, 100, '5 × 4 RGBA plus 5 × 4 Province')
      assert.equal(await f.session.evaluate('layer.getProvincePixel(2,1)'), '41')
      await f.session.evaluate('resizeImages()')
      assert.equal(f.session.snapshot().bitmapBytes, 150, '6 × 5 RGBA plus 6 × 5 Province')
      await f.session.evaluate('dropMain()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('recreateProvince()')
      assert.equal(f.session.snapshot().bitmapBytes, 20, 'Province uses the 5 × 4 Layer rect')
      await f.session.evaluate('dropMain()')
      assert.equal(f.session.snapshot().bitmapBytes, 0, 'Repeated false also releases Province')
      await f.session.evaluate('recreateProvince()')
      await f.session.evaluate('becomeBinder()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('recreateProvince()')
      assert.equal(f.session.snapshot().bitmapBytes, 20)
      await f.session.evaluate('sameBinder()')
      assert.equal(f.session.snapshot().bitmapBytes, 20)
      await f.session.evaluate('becomeAlpha()')
      assert.equal(f.session.snapshot().bitmapBytes, 100)
      assert.equal(await f.session.evaluate('layer.getProvincePixel(2,1)'), '53')
      await f.session.evaluate('dropOwners()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.restored()
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: detaching a Layer keeps both planes until each native owner is destroyed`, async () => {
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
function createFamily() {
  makeOwner(2,2);layer.setProvincePixel(1,1,17);
  global.child=new global.LifetimeLayer(win,layer);
  child.setSize(3,1);child.setImageSize(3,1);child.setProvincePixel(2,0,29);
}
function detachChild() {child.parent=null;}
function invalidateParent() {invalidate layer;}
function destroyChild() {delete global.child;}
`,
    )
    try {
      await f.session.evaluate('createFamily()')
      const id = Number(await f.session.evaluate('child.__id'))
      assert.equal(f.session.snapshot().bitmapBytes, 35)
      const before = planeSnapshot(f.session, id)
      await f.session.evaluate('detachChild()')
      assert.equal(f.session.snapshot().bitmapBytes, 35)
      assert.deepEqual(planeSnapshot(f.session, id), before)
      assert.equal(await f.session.evaluate('child.parent===null'), '1')
      await f.session.evaluate('invalidateParent()')
      assert.equal(f.session.snapshot().bitmapBytes, 15)
      assert.equal(
        await f.session.evaluate('(isvalid child)+","+child.getProvincePixel(2,0)'),
        '1,29',
      )
      assert.equal(
        f.session.inspectOwnership().layerSources,
        2,
        'Root and detached child stay live',
      )
      await f.session.evaluate('destroyChild()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.equal(layers(f.session).has(id), false)
      assert.equal(await f.session.evaluate('layerDeaths'), '2')
      await f.session.evaluate('dropOwners()')
      await f.restored()
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: a failing Font finalizer preserves both planes until Layer releaseImage can finish`, async () => {
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
var font=null,failProvinceFont=true,provinceFontDeaths=0,provinceTrace="",provinceCaught="";
function createFailingFont() {
  makeOwner(2,2);layer.setProvincePixel(1,1,37);global.font=layer.font;
  font.finalize=function() {
    global.provinceFontDeaths++;
    global.provinceTrace+=int(global.layer.hasImage)+":"+global.layer.getProvincePixel(1,1)+";";
    if(global.failProvinceFont)throw new global.Exception("province-font-finalizer");
  };
}
function tryRelease() {try{invalidate layer;}catch(error){global.provinceCaught=error.message;}}
function finishRelease() {global.failProvinceFont=false;invalidate layer;}
function dropFont() {delete global.font;dropOwners();}
`,
    )
    try {
      await f.session.evaluate('createFailingFont()')
      const id = Number(await f.session.evaluate('layer.__id'))
      const before = planeSnapshot(f.session, id)
      assert.equal(f.session.snapshot().bitmapBytes, 20)
      await f.session.evaluate('tryRelease()')
      assert.match(await f.session.evaluate('provinceCaught'), /province-font-finalizer/)
      assert.equal(await f.session.evaluate('(isvalid layer)+","+(isvalid font)'), '1,1')
      assert.equal(await f.session.evaluate('provinceTrace'), '1:37;')
      assert.deepEqual(planeSnapshot(f.session, id), before)
      assert.equal(f.session.snapshot().bitmapBytes, 20)
      assert.equal(f.session.inspectOwnership().closingLayers, 0)
      await f.session.evaluate('finishRelease()')
      assert.equal(await f.session.evaluate('provinceTrace'), '1:37;1:37;')
      assert.equal(
        await f.session.evaluate('layerDeaths+","+provinceFontDeaths+","+(isvalid font)'),
        '2,2,0',
      )
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.equal(layers(f.session).has(id), false)
      await f.session.evaluate('dropFont()')
      await f.restored()
      assert.deepEqual(f.logs, [])
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: Window managed cleanup and Session stop release independent Province owners`, async () => {
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
function createManagedPlanes() {
  makeOwner(2,2);layer.setProvincePixel(1,1,61);
  global.child=new global.LifetimeLayer(win,root);
  child.setSize(3,1);child.setImageSize(3,1);child.hasImage=false;child.setProvincePixel(2,0,71);
  win.add(layer);win.add(child);win.add(root);
}
function closeManagedWindow() {win.close();}
`,
    )
    try {
      await f.session.evaluate('createManagedPlanes()')
      assert.equal(f.session.snapshot().bitmapBytes, 23)
      await f.session.evaluate('closeManagedWindow()')
      assert.equal(
        await f.session.evaluate('(isvalid win)+","+(isvalid layer)+","+(isvalid child)'),
        '0,0,0',
      )
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.session.evaluate('dropOwners()')
      await f.restored()
      await f.session.evaluate('createManagedPlanes()')
      assert.equal(f.session.snapshot().bitmapBytes, 23)
    } finally {
      await f.session.stop()
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      f.stopped()
    }
  })

  test(`${mode}: independ image APIs preserve absent main Province and combined planes for every copy argument`, async () => {
    let presents = 0,
      rendererCloses = 0
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
function prepareIndependent(shape) {
  layer.hasImage=false;layer.hasImage=true;
  layer.setSize(2,1);layer.setImageSize(4,3);layer.setImagePos(-1,-1);
  layer.fillRect(0,0,4,3,0x7f123456);layer.setClip(1,0,2,2);
  if(shape==0 || shape==2)layer.hasImage=false;
  if(shape==2)layer.setSize(4,3);
  if(shape==2 || shape==3) {
    layer.setProvincePixel(1,0,19);layer.setProvincePixel(2,1,23);
  }
  if(shape==2)layer.setSize(2,1);
  layer.imageModified=false;
}
function independBoth(argument) {
  var mainResult,provinceResult;
  if(argument==0) {mainResult=layer.independMainImage();provinceResult=layer.independProvinceImage();}
  if(argument==1) {mainResult=layer.independMainImage(void);provinceResult=layer.independProvinceImage(void);}
  if(argument==2) {mainResult=layer.independMainImage(false);provinceResult=layer.independProvinceImage(false);}
  if(argument==3) {mainResult=layer.independMainImage(0);provinceResult=layer.independProvinceImage(0);}
  if(argument==4) {mainResult=layer.independMainImage(true);provinceResult=layer.independProvinceImage(true);}
  if(argument==5) {mainResult=layer.independMainImage(0.5);provinceResult=layer.independProvinceImage(0.5);}
  if(argument==6) {mainResult=layer.independMainImage(-0.5);provinceResult=layer.independProvinceImage(-0.5);}
  return mainResult===void && provinceResult===void;
}
`,
      {
        renderer: {
          present() {
            presents++
          },
          dispose() {
            rendererCloses++
          },
        },
      },
    )
    try {
      await f.session.evaluate('makeOwner(2,1)')
      const id = Number(await f.session.evaluate('layer.__id'))
      for (const [shape, bytes] of [0, 48, 12, 60].entries()) {
        await f.session.evaluate(`prepareIndependent(${shape})`)
        const before = planeSnapshot(f.session, id),
          ownership = f.session.inspectOwnership(),
          handles = f.session.snapshot().handles,
          presented = presents
        assert.equal(before.imageModified, false)
        assert.equal(f.session.snapshot().bitmapBytes, bytes)
        for (let argument = 0; argument < 7; argument++) {
          const context = `plane shape ${shape}, copy argument ${argument}`
          assert.equal(await f.session.evaluate(`independBoth(${argument})`), '1', context)
          assert.deepEqual(planeSnapshot(f.session, id), before, context)
          assert.equal(f.session.snapshot().bitmapBytes, bytes, context)
          assert.deepEqual(f.session.inspectOwnership(), ownership, context)
          assert.equal(f.session.snapshot().handles, handles, context)
          assert.equal(presents, presented, context)
        }
      }
      await f.session.evaluate('dropOwners()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      await f.restored()
    } finally {
      await f.session.stop()
      assert.equal(f.session.snapshot().handles, 0)
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      assert.equal(rendererCloses, 1)
    }
  })

  test(`${mode}: invalidated independ receivers reject direct and retained method calls without allocating`, async () => {
    const f = await layerFixture(
      binary,
      owners +
        String.raw`
var retainedMain=null,retainedProvince=null;
function retireIndependentOwner() {
  makeOwner(2,1);layer.setProvincePixel(1,0,83);
  global.retainedMain=layer.independMainImage;
  global.retainedProvince=layer.independProvinceImage;
  invalidate layer;
}
function rejectedIndependentCalls() {
  var rejected=0;
  try{layer.independMainImage();}catch(error){rejected|=1;}
  try{layer.independProvinceImage(false);}catch(error){rejected|=2;}
  try{retainedMain(true);}catch(error){rejected|=4;}
  try{retainedProvince(-0.5);}catch(error){rejected|=8;}
  return rejected;
}
function dropIndependentMethods() {
  delete global.retainedMain;delete global.retainedProvince;dropOwners();
}
`,
    )
    try {
      await f.session.evaluate('retireIndependentOwner()')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      const ownership = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles
      assert.equal(await f.session.evaluate('rejectedIndependentCalls()'), '15')
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.deepEqual(f.session.inspectOwnership(), ownership)
      assert.equal(f.session.snapshot().handles, handles)
      await f.session.evaluate('dropIndependentMethods()')
      await f.restored()
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })
}

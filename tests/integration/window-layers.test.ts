import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

test('image names without extensions resolve through auto-paths without changing file lookup', async () => {
  const decoded: string[] = []
  const { session } = await headless(
    {
      'pictures/face.PNG': 'image-bytes',
      'startup.tjs': String.raw`
Storages.addAutoPath("pictures/");
var window=new Window(),root=new Layer(window,null);root.loadImages("face");
`,
    },
    {
      graphics: {
        decode: async (bytes) => {
          decoded.push(new TextDecoder().decode(bytes))
          return { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }
        },
        text: () => {
          throw new Error('Unexpected text drawing')
        },
      },
    },
  )
  try {
    await session.start()
    assert.deepEqual(decoded, ['image-bytes'])
    assert.equal(
      await session.evaluate('root.imageWidth==1 && root.getMainPixel(0,0)==0xff0000'),
      '1',
    )
    assert.equal(await session.evaluate('Storages.isExistentStorage("face")'), '0')
  } finally {
    await session.stop()
  }
})

test('Window zoom/offset and Layer image offset preserve local input coordinates', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window();window.visible=true;window.setInnerSize(32,32);window.setZoom(2,1);window.setLayerPos(3,4);
var root=new Layer(window,null),child=new Layer(window,root);child.setImageSize(8,8);child.setSize(2,2);child.setImagePos(-3,-2);child.setPos(2,3);child.visible=true;child.hitThreshold=0;
var clicked="";child.onClick=function(x,y){clicked=x+","+y;};
`,
  })
  try {
    await session.start()
    await session.idle()
    await session.click(9, 12)
    assert.equal(await session.evaluate('clicked'), '1,1')
    assert.equal(await session.evaluate('child.cursorX+","+child.cursorY'), '1,1')
    assert.equal(await session.evaluate('child.imageWidth+","+child.width'), '8,2')
    assert.equal(await session.evaluate('root.children[0]===child'), '1')
    await session.evaluate('(function(){invalidate child;return 0;})()')
    assert.equal(await session.evaluate('root.children.count'), '0')
  } finally {
    await session.stop()
  }
})

test('Layer.adjustGamma preserves fractional gamma values and defaults for omitted channels', async () => {
  const { session } = await headless({
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null);root.setSize(2,1);root.fillRect(0,0,2,1,0x80404040);
root.setClip(0,0,1,1);root.adjustGamma(1.5);
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('root.getMainPixel(0,0)'), String(0x654040))
    assert.equal(await session.evaluate('root.getMainPixel(1,0)'), String(0x404040))
    assert.equal(await session.evaluate('root.getMaskPixel(0,0)'), '128')
  } finally {
    await session.stop()
  }
})

test('Window resize notifications coalesce and close invalidates only registered managed objects', async () => {
  const { session, logs } = await headless({
    'startup.tjs': String.raw`
class TestWindow extends Window {
  var resizes=0,allow=false;
  function TestWindow(){super.Window();}
  function onResize(){resizes++;}
  function onCloseQuery(){super.onCloseQuery(allow);}
}
class Managed {
  var name;
  function Managed(name){this.name=name;}
  function finalize(){Debug.message("disposed:"+name);}
}
var window=new TestWindow();window.setInnerSize(100,80);window.setInnerSize(120,90);
var keep=new Managed("keep"),remove=new Managed("remove");window.add(keep);window.add(keep);window.add(remove);window.remove(remove);window.close();
`,
  })
  try {
    await session.start()
    await session.idle()
    assert.equal(await session.evaluate('window.resizes'), '1')
    assert.equal(await session.evaluate('window.innerWidth'), '120')
    await session.evaluate('(function(){window.allow=true;window.close();})()')
    await session.stop()
    assert.deepEqual(
      logs.filter((message) => message.startsWith('disposed:')),
      ['disposed:keep'],
    )
  } finally {
    await session.stop()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
const scene = String.raw`
var window=new Window();window.visible=true;window.setInnerSize(2,1);
var root=new Layer(window,null),fore=new Layer(window,root),back=new Layer(window,root);
root.setSize(2,1);fore.setSize(2,1);back.setSize(2,1);
fore.visible=true;fore.fillRect(0,0,2,1,0xffff0000);back.fillRect(0,0,2,1,0xff0000ff);
var oldChild=new Layer(window,fore),newChild=new Layer(window,back),done=0,tick=0;
fore.onTransitionCompleted=function(dest,src){done++;if(dest!==fore||src!==back)throw new Exception("Wrong transition identity");};
`
test('a scripted transition clock supports seeking and structural completion before its callback', async () => {
  let pixels: number[] = []
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        String.raw`
fore.beginTransition("crossfade",true,back,%[time:1000,selfupdate:true,callback:function(){return tick;}]);
`,
    },
    {
      renderer: {
        present(layers) {
          const frame = layers.find((layer) => layer.id === -2)
          if (frame) pixels = [...frame.pixels.data.subarray(0, 4)]
        },
        dispose() {},
      },
    },
  )
  try {
    await session.start()
    assert.deepEqual(pixels, [255, 0, 0, 255])
    await session.evaluate('(function(){tick=500;fore.update();return 0;})()')
    assert.deepEqual(pixels, [128, 0, 127, 255])
    await session.evaluate('(function(){tick=250;fore.update();return 0;})()')
    assert.deepEqual(pixels, [192, 0, 63, 255])
    await session.evaluate('(function(){tick=1000;fore.update();return 0;})()')
    assert.equal(
      await session.evaluate(
        'done==1 && root.children[0]===back && back.visible && !fore.visible && oldChild.parent===fore && newChild.parent===back',
      ),
      '1',
    )
    await session.evaluate('fore.stopTransition()')
    assert.equal(await session.evaluate('done'), '1')
  } finally {
    await session.stop()
  }
})
test('manual stop exchanges only the selected nodes and allows a new transition from completion', async () => {
  const { session } = await headless({
    'startup.tjs':
      scene +
      String.raw`
fore.onTransitionCompleted=function(dest,src){done++;if(done==1)back.beginTransition("scroll",false,fore,%[time:1000,selfupdate:true]);};
fore.beginTransition("crossfade",false,back,%[time:1000,selfupdate:true]);
`,
  })
  try {
    await session.start()
    await session.evaluate('fore.stopTransition()')
    assert.equal(
      await session.evaluate(
        'done==1 && oldChild.parent===back && newChild.parent===fore && root.children[0]===back',
      ),
      '1',
    )
    await session.evaluate('back.stopTransition()')
    assert.equal(await session.evaluate('root.children[0]===fore && oldChild.parent===fore'), '1')
  } finally {
    await session.stop()
  }
})
test('automatic transition time freezes during pause and pending callbacks disappear on stop', async () => {
  let now = 0
  const scheduled = new Set<() => void>()
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        String.raw`
fore.beginTransition("crossfade",true,back,%[time:100]);
`,
    },
    {
      now: () => now,
      schedule: (callback) => {
        scheduled.add(callback)
        return () => {
          scheduled.delete(callback)
        }
      },
    },
  )
  const advance = async (value: number) => {
    now = value
    const callback = scheduled.values().next().value
    if (callback) {
      scheduled.delete(callback)
      callback()
      await session.idle()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  try {
    await session.start()
    await advance(40)
    session.pause()
    assert.equal(scheduled.size, 0)
    now = 1000
    session.resume()
    await advance(1059)
    assert.equal(await session.evaluate('done'), '0')
    await advance(1060)
    assert.equal(await session.evaluate('done'), '1')
    await session.evaluate('back.beginTransition("crossfade",true,fore,%[time:100])')
    await session.stop()
    assert.equal(scheduled.size, 0)
  } finally {
    await session.stop()
  }
})

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
test('automatic transition time freezes during pause and pending callbacks disappear on stop', { timeout: 60000 }, async () => {
  let now = 0
  let lastLayers: { id: number; pixels: number[] }[] = []
  const scheduled = new Set<{ at: number; callback: () => void }>()
  const { session } = await headless(
    {
      'startup.tjs':
        scene +
        String.raw`
fore.onTransitionCompleted=function(dest,src){global.done++;if(dest!==global.fore||src!==global.back)throw new Exception("Wrong transition identity");};
fore.beginTransition("crossfade",true,back,%[time:100]);
`,
    },
    {
      renderer: {
        present(layers) { lastLayers = layers.map((layer) => ({ id: layer.id, pixels: [...layer.pixels.data.subarray(0, 8)] })) },
        dispose() {},
      },
      now: () => now,
      schedule: (callback, delay) => {
        const task = { at: now + delay, callback }
        scheduled.add(task)
        return () => {
          scheduled.delete(task)
        }
      },
    },
  )
  const advance = async (value: number) => {
    now = value
    for (const task of [...scheduled].sort((a, b) => a.at - b.at)) {
      if (task.at <= now && scheduled.delete(task)) task.callback()
    }
    await session.idle()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const failures: unknown[] = []
  try {
    await session.start()
    const foreId = Number(await session.evaluate('fore.__id')), backId = Number(await session.evaluate('back.__id'))
    await advance(40)
    assert.deepEqual(lastLayers.find((layer) => layer.id === -foreId)?.pixels, [153, 0, 102, 255, 153, 0, 102, 255])
    session.pause()
    assert.equal(scheduled.size, 0)
    now = 1000
    session.resume()
    await advance(1059)
    // As in graphics recovery, a jump to 1059 executes a due frame at that
    // time and rearms it for 1075. Explicit completion samples the strict
    // 99/100 ms boundary without waiting for a later automatic frame.
    assert.equal(await session.evaluate('(function(){global.fore.update();global.window.update();return global.done;})()'), '0')
    assert.equal(await session.evaluate('done'), '0')
    assert.deepEqual(lastLayers.find((layer) => layer.id === -foreId)?.pixels, [3, 0, 252, 255, 3, 0, 252, 255])
    await advance(1060)
    assert.equal(await session.evaluate('(function(){global.fore.update();global.window.update();return global.done;})()'), '1')
    assert.equal(await session.evaluate('done'), '1')
    assert.deepEqual(lastLayers.find((layer) => layer.id === backId)?.pixels, [0, 0, 255, 255, 0, 0, 255, 255])
    await session.evaluate('back.beginTransition("crossfade",true,fore,%[time:100])')
    await session.stop()
    assert.equal(scheduled.size, 0)
  } catch (error) { failures.push(error) }
  try {
    await session.stop()
    assert.equal(scheduled.size, 0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Transition pause or cleanup failed', { cause: failures[0] })
})

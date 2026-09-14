import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { tlgFixture, tlgSds, tlgTags } from '../helpers/tlg-fixtures.ts'

test('loadImages resolves TLG extensions, returns tags and preserves alpha and failed-load pixels', async () => {
  const { session } = await headless({
    'five.tlg5': tlgFixture('5-3-solid-17x9-auto'),
    'six.tlg6': tlgFixture('6-4-solid-17x9-auto'),
    'tagged.tlg': tlgSds(tlgFixture('6-4-solid-17x9-auto'), [
      [
        'tags',
        tlgTags([
          ['LEFT', '20'],
          ['题😀', 'あ,=:文😀'],
          ['__proto__', 'safe'],
        ]),
      ],
    ]),
    'broken.tlg': Buffer.from('TLG'),
    'startup.tjs': String.raw`
var window=new Window(),root=new Layer(window,null),layer=new Layer(window,root);
var empty=layer.loadImages("five");var five=empty===null && layer.imageWidth==17 && layer.imageHeight==9 && layer.getMainPixel(16,8)==0xca3511 && layer.getMaskPixel(16,8)==255;
layer.loadImages("six");var six=layer.getMainPixel(8,8)==0xca3511 && layer.getMaskPixel(8,8)==128;
layer.setPos(3,4);var tags=layer.loadImages("tagged");var meta=tags.LEFT=="20" && tags["题😀"]=="あ,=:文😀" && tags["__proto__"]=="safe" && layer.left==3 && layer.top==4;
var failed=false;try{layer.loadImages("broken");}catch(e){failed=true;}var unchanged=failed && layer.getMainPixel(8,8)==0xca3511 && layer.getMaskPixel(8,8)==128;
layer.loadImages("six",0xca3511);var keyed=layer.getMaskPixel(8,8)==0 && layer.getMainPixel(8,8)==0xca3511;
`,
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('five && six && meta && unchanged && keyed'), '1')
  } finally {
    await session.stop()
  }
})

test('pausing and cancelling a TLG decode releases suspended work without completing the load', async () => {
  let wake = () => {},
    signal = () => {},
    held = false,
    ticks = 0
  const yielded = new Promise<void>((resolve) => {
    signal = resolve
  })
  const { session, logs } = await headless(
    {
      'image.tlg': tlgFixture('6-4-noise-129x65-auto'),
      'startup.tjs':
        'var window=new Window(),root=new Layer(window,null);Debug.message("tlg-start");root.loadImages("image");Debug.message("tlg-finished");',
    },
    {
      now: () => (ticks += 10),
      schedule: (callback, delay) => {
        if (delay === 0 && !held) {
          held = true
          wake = callback
          signal()
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
    assert.ok(logs.includes('tlg-start'))
    session.pause()
    wake()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(logs.includes('tlg-finished'), false)
    const results = await Promise.allSettled([started, session.stop()])
    assert.equal(results[1]!.status, 'fulfilled')
    assert.equal(logs.includes('tlg-finished'), false)
  } finally {
    await session.stop()
  }
})

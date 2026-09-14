import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
test('VideoOverlay validates its Window, preserves layer identity and revokes weak registrations', async () => {
  const { session } = await headless({
    'startup.tjs':
      'var window=new Window();var root=new Layer(window,null);var video=new VideoOverlay(window);video.layer1=root;video.layer2=root;',
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        '[video.width,video.height,video.visible,video.mode,video.status].join(",")',
      ),
      '320,240,0,0,unload',
    )
    assert.equal(await session.evaluate('video.layer1===root && video.layer2===root'), '1')
    const handles = session.snapshot().handles
    const ownership = session.inspectOwnership()
    assert.equal(await session.evaluate('window.__windowObjects.count'), '0')
    assert.equal(
      await session.evaluate('(function(){try{new VideoOverlay(null);}catch(error){return 1;}})()'),
      '1',
    )
    await session.evaluate('(function(){invalidate video;return 0;})()')
    assert.equal(session.snapshot().handles, handles)
    assert.equal(session.inspectOwnership().videoSources, ownership.videoSources - 1)
    assert.equal(session.inspectOwnership().weakOwners, ownership.weakOwners - 4)
    assert.equal(await session.evaluate('window.__windowObjects.count'), '0')
  } finally {
    await session.stop()
  }
})
test('System.getArgument distinguishes an absent argument from supplied text', async () => {
  const { session } = await headless(
    { 'startup.tjs': 'var option=System.getArgument("-mode");' },
    { arguments: new Map([['-mode', 'preview']]) },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('option'), 'preview')
    assert.equal(await session.evaluate('System.getArgument("-ovr")===void'), '1')
  } finally {
    await session.stop()
  }
})

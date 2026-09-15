import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from './headless.ts'
import { LifetimeVideoBackend, videoGate } from './video-lifetime-backend.ts'
import { windowLifetimeScript } from './window-lifetime-script.ts'
export { videoGate }

export async function windowFixture(
  binary: boolean,
  extra = '',
  overrides: Partial<SessionDependencies> = {},
) {
  const video = new LifetimeVideoBackend()
  let frames: FrameLayer[] = [],
    rendererCloses = 0
  const harness = await headless(
    {
      'startup.tjs': '',
      'movie.mp4': new Uint8Array([1, 2, 3]),
      'window-owned.tjs': windowLifetimeScript(extra),
    },
    {
      video,
      renderer: {
        present(layers) {
          frames = layers
        },
        dispose() {
          rendererCloses++
        },
      },
      ...overrides,
    },
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("window-owned.tjs","savedata/window-owned.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/window-owned.cjs")')
    } else await session.evaluate('Scripts.execStorage("window-owned.tjs")')
    await execute(
      'var warm=new LifetimeWindow();warm.caption;invalidate warm;delete global.warm;finalized=0;',
    )
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    const restored = async () => {
      await session.idle()
      assert.deepEqual(session.inspectOwnership(), baseline)
      assert.equal(session.snapshot().handles, handles)
      assert.equal(session.snapshot().state, 'running')
      assert.equal(video.movies.size, 0)
    }
    const stopped = () => {
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      assert.equal(session.snapshot().handles, 0)
      assert.equal(rendererCloses, 1)
      assert.equal(video.movies.size, 0)
    }
    return {
      ...harness,
      video,
      execute,
      baseline,
      handles,
      restored,
      stopped,
      frames: () => frames,
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

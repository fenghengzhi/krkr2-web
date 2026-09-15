import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { headless } from './headless.ts'
import { layerLifetimeScript } from './layer-lifetime-script.ts'

export async function layerFixture(
  binary: boolean,
  extra = '',
  overrides: Partial<SessionDependencies> = {},
) {
  let rendererCloses = 0
  const harness = await headless(
    { 'startup.tjs': '', 'layer-lifetime.tjs': layerLifetimeScript(extra) },
    {
      renderer: {
        present() {},
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
        'Scripts.compileStorage("layer-lifetime.tjs","savedata/layer-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/layer-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("layer-lifetime.tjs")')
    // Warm lazy native Array, Font and Exception classes before measuring owners.
    // The fixture continues inspecting ownership after its main Windows die.
    await execute(
      'System.exitOnWindowClose=false;Debug.getLastLog();var warmWindow=new LifetimeLayerWindow(),warm=new LifetimeLayer(warmWindow);' +
        'warm.children;warm.font.height;invalidate warm;delete global.warm;' +
        'delete global.warmWindow;try{throw new Exception("warm layer");}catch(e){}' +
        'layerDeaths=0;layerWindowDeaths=0;',
    )
    await session.idle()
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    return {
      ...harness,
      execute,
      baseline,
      handles,
      async restored() {
        await session.idle()
        assert.deepEqual(session.inspectOwnership(), baseline)
        assert.equal(session.snapshot().handles, handles)
        assert.equal(session.snapshot().state, 'running')
      },
      stopped() {
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
        assert.equal(session.snapshot().handles, 0)
        assert.equal(rendererCloses, 1)
      },
    }
  } catch (error) {
    await session.stop()
    throw error
  }
}

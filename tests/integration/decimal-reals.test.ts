import assert from 'node:assert/strict'
import test from 'node:test'
import { decimalCases, decimalPaths, decimalPoolExpected, decimalSource, doubleBits, savedRealBits } from '../helpers/decimal-reals.ts'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: game decimal literals and converted strings retain their binary64 values across save and load`, async () => {
  const { session } = await headless({ 'decimals.tjs': decimalSource,
    'startup.tjs': (binary ? 'Scripts.compileStorage("decimals.tjs",System.dataPath+"decimals.cjs",false,true,false);Scripts.execStorage(System.dataPath+"decimals.cjs");'
      : 'Scripts.execStorage("decimals.tjs");') + 'decimalObserve(System.dataPath);' })
  try {
    await session.start()
    assert.equal(await session.evaluate('decimalPoolControl()'), decimalPoolExpected)
    const saves = new Map(session.exportSaves().map((entry) => [entry.path, entry.bytes]))
    if (binary) assert.equal(Buffer.from(saves.get('savedata/decimals.cjs')!).toString('ascii', 0, 4), 'TJS2')
    for (const name of decimalPaths) {
      const bytes = saves.get('savedata/' + name + '.tjs')!
      assert(bytes)
      const bits = savedRealBits(new TextDecoder('utf-16le').decode(bytes))
      assert.deepEqual(bits, decimalCases.map(({ value }) => doubleBits(value)), name)
    }
  } finally { await session.stop() }
})

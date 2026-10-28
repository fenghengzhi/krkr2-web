import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { bmpNativeFiles, bmpNativeSource } from '../helpers/bmp-native-files.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: CORE image, RGB555 mask and indexed CORE province use portable selected BMP decoding`, { timeout: 60000 }, async () => {
  // The headless graphics fallback throws. Success must come from the real
  // selected portable decoder, including the under-54-byte CORE payloads.
  const f = await headless({ ...bmpNativeFiles(), 'bmp-native.tjs': bmpNativeSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("bmp-native.tjs","savedata/bmp-native.cjs",false,true,false);Scripts.execStorage("savedata/bmp-native.cjs");'
      : 'Scripts.execStorage("bmp-native.tjs");' }), failures: unknown[] = []
  try {
    await f.session.start()
    assert.equal(await f.session.evaluate('bmpNativeReady'), '1')
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/bmp-native.cjs')!.bytes.subarray(0, 4)), 'TJS2')
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Portable BMP scenario or cleanup failed', { cause: failures[0] })
})

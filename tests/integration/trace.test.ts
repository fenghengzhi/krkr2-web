import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { headless } from '../helpers/headless.ts'
import { exerciseTrace } from '../helpers/trace-runtime.ts'

test('native stack traces retain source positions across suspension, callbacks, bytecode and cancellation', async () => {
  const directory = resolve('.generated/wasm')
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'))
  const assets = manifest.variants.asyncify
  const { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href)
  await exerciseTrace(
    factory,
    new Uint8Array(await readFile(resolve(directory, assets.wasm.file))),
    'asyncify',
  )
})

for (const option of [undefined, 'no', 'yes']) {
  test(`Scripts.getTraceString honors immutable startup debug option ${option}`, async () => {
    const { session } = await headless(
      {
        'startup.tjs': [
          'function capture(){return Scripts.getTraceString();}',
          'var before=capture();',
          `System.setArgument("-debug",${JSON.stringify(option === 'yes' ? 'no' : 'yes')});`,
          'var after=capture();',
        ].join('\n'),
      },
      { arguments: new Map(option ? [['-debug', option]] : []) },
    )
    try {
      await session.start()
      if (option === 'yes') {
        assert.match(
          await session.evaluate('before'),
          /^startup.tjs\(1\)\[\(function\) capture\] <-- startup.tjs\(2\)/,
        )
        assert.match(
          await session.evaluate('after'),
          /^startup.tjs\(1\)\[\(function\) capture\] <-- startup.tjs\(4\)/,
        )
        assert.equal(await session.evaluate('before.indexOf("bootstrap")'), '-1')
      } else {
        assert.equal(await session.evaluate('before'), '')
        assert.equal(await session.evaluate('after'), '')
      }
      assert.equal(await session.evaluate('Scripts.getTraceString instanceof "Function"'), '1')
    } finally {
      await session.stop()
    }
  })
}

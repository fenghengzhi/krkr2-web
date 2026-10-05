import test from 'node:test'
import assert from 'node:assert/strict'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { archivePatchFiles } from '../helpers/archive-patch.ts'

const resource = (name: string, value: string, aliasOf?: string): Resource => ({
  name, size: value.length, aliasOf, read: async () => new TextEncoder().encode(value),
})

for (const reverse of [false, true])
  test(`archive search ${reverse ? 'reverse' : 'forward'} imports preserve canonical identity and registered patch precedence`, { timeout: 60000 }, async () => {
    const resolver = new StorageResolver(), files = archivePatchFiles()
    if (reverse) files.reverse()
    resolver.mount(await importResources(files.map(({ path, bytes }) => ({ path, blob: new Blob([Uint8Array.from(bytes).buffer]) })), async () => {}))
    resolver.addAutoPath('system/'); resolver.addAutoPath('patch.xp3>'); resolver.addAutoPath('patch2.xp3>')
    assert.equal(resolver.resolve('patch-value.tjs').name, 'patch2.xp3>patch-value.tjs')
    assert.equal(resolver.resolve('patch-value.tjs'), resolver.find('patch2.xp3>patch-value.tjs'))
    const token = resolver.resolve('patch-value.tjs').cacheToken
    resolver.addAutoPath('patch.xp3>') // Duplicate registration must not move its priority.
    assert.equal(resolver.resolve('missing/patch-value.tjs').cacheToken, token)
    resolver.removeAutoPath('patch2.xp3>')
    assert.equal(resolver.resolve('patch-value.tjs').name, 'patch.xp3>patch-value.tjs')
    assert.notEqual(resolver.resolve('patch-value.tjs').cacheToken, token)
    resolver.removeAutoPath('patch.xp3>')
    assert.equal(resolver.resolve('patch-value.tjs').name, 'data.xp3>system/patch-value.tjs')
    assert.equal(resolver.resolve('system/patch-value.tjs'), resolver.find('data.xp3>system/patch-value.tjs'))
    assert.equal(resolver.find('system/patch-value.tjs'), undefined, 'An import alias is not a writable loose file')
    assert.equal(resolver.list().some((entry) => entry.name === 'system/patch-value.tjs'), false)
    assert.equal(resolver.list().some((entry) => entry.name === 'data.xp3>system/patch-value.tjs'), true)
  })

test('loose files and save observations precede archive aliases without depending on import order', () => {
  const resolver = new StorageResolver(), first = resource('scene.tjs', 'loose'),
    qualified = resource('data.xp3>scene.tjs', 'base'), alias = resource('scene.tjs', 'base', qualified.name)
  resolver.mount([first, alias, qualified, resource('patch.xp3>scene.tjs', 'patch')])
  resolver.addAutoPath('patch.xp3>')
  assert.equal(resolver.resolve('scene.tjs').name, 'scene.tjs')
  assert.notEqual(resolver.resolve('scene.tjs').cacheToken, resolver.resolve(qualified.name).cacheToken)
  const saved = resource('scene.tjs', 'saved')
  assert.equal(resolver.lookup('SCENE.TJS', (name) => name === 'SCENE.TJS' ? saved : undefined), saved)
  resolver.mount([alias, qualified])
  assert.equal(resolver.resolve('scene.tjs').name, 'scene.tjs', 'Later package aliases cannot overwrite loose files')
})

test('invalid alias batches are atomic and alias case collisions retain the ordinary ambiguity rules', () => {
  const resolver = new StorageResolver()
  resolver.mount([resource('kept.tjs', 'old')])
  const kept = resolver.find('kept.tjs')
  for (const aliasOf of ['missing.xp3>one.tjs', 'new.tjs', 'pack.xp3>other.tjs'])
    assert.throws(() => resolver.mount([resource('kept.tjs', 'new'), resource('one.tjs', 'x', aliasOf)]), /Invalid archive compatibility alias/)
  assert.equal(resolver.count, 1)
  assert.equal(resolver.find('kept.tjs'), kept)
  resolver.mount([resource('pack.xp3>one.tjs', 'a'), resource('pack.xp3>One.tjs', 'b'),
    resource('one.tjs', 'a', 'pack.xp3>one.tjs'), resource('One.tjs', 'b', 'pack.xp3>One.tjs')])
  assert.equal(resolver.resolve('one.tjs').name, 'pack.xp3>one.tjs')
  assert.throws(() => resolver.resolve('ONE.TJS'), /Ambiguous archive compatibility alias/)
  resolver.clear()
  assert.equal(resolver.count, 0); assert.equal(resolver.exists('one.tjs'), false)
})

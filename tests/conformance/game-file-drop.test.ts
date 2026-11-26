import assert from 'node:assert/strict'
import test from 'node:test'
import { gameDropFiles } from '../../src/app/game-file-drop.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { gameIdentity } from '../../src/player/game-identity.ts'
import { captureDrop, enumerateDrop } from '../../src/player/drop-files.ts'

test('one dropped release directory has the same nested paths, Blob ownership and save identity as the folder picker', async () => {
  const files = [
    { path: '合集/Novel/data.xp3', blob: new Blob(['original game']) },
    { path: '合集/Novel/extras/prompt #1.tjs', blob: new Blob(['"chapter"']) },
    { path: '合集/Novel/Empty.dat', blob: new Blob([]) },
  ]
  const selected = gameDropFiles({ roots: [{ name: 'Release', kind: 'directory' }], entries: [
    { root: 0, path: '', kind: 'directory' }, { root: 0, path: 'Empty', kind: 'directory' },
    ...files.map((file) => ({ root: 0, path: file.path, kind: 'file' as const, source: file.blob })),
  ] })
  assert.equal(selected.directory, true)
  assert.deepEqual(selected.files, files)
  selected.files.forEach((file, i) => assert.equal(file.blob, files[i]!.blob))
  const resources = (entries: typeof files) => entries.map(({ path, blob }) => ({ path, source: new BlobSource(blob) }))
  assert.equal(await gameIdentity(resources(selected.files)), await gameIdentity(resources(files)))
})

test('multiple dropped roots retain sibling directories and a standalone XP3 retains the file picker path', () => {
  const main = new Blob(['main']), patch = new Blob(['patch']), scene = new Blob(['scene'])
  const selected = gameDropFiles({ roots: [{ name: 'data.xp3', kind: 'file' }, { name: 'Extras', kind: 'directory' },
    { name: 'patch.xp3', kind: 'file' }], entries: [
    { root: 0, path: '', kind: 'file', source: main }, { root: 1, path: '', kind: 'directory' },
    { root: 1, path: 'Routes/開幕.tjs', kind: 'file', source: scene },
    { root: 2, path: '', kind: 'file', source: patch },
  ] })
  assert.equal(selected.directory, true)
  assert.deepEqual(selected.files.map((file) => file.path), ['data.xp3', 'Extras/Routes/開幕.tjs', 'patch.xp3'])
  assert.deepEqual(selected.files.map((file) => file.blob), [main, scene, patch])
  assert.deepEqual(gameDropFiles({ roots: [{ name: 'data.xp3', kind: 'file' }], entries: [
    { root: 0, path: '', kind: 'file', source: main },
  ] }), { directory: false, files: [{ path: 'data.xp3', blob: main }] })
})

test('empty directories and colliding dropped files report an import error without reading file contents', () => {
  const blob = new Blob(['unchanged'])
  blob.arrayBuffer = async () => { throw new Error('Import mapping must not read the payload') }
  assert.throws(() => gameDropFiles({ roots: [{ name: 'Release', kind: 'directory' }],
    entries: [{ root: 0, path: '', kind: 'directory' }] }), /没有可读取/)
  assert.throws(() => gameDropFiles({ roots: [{ name: 'same.xp3', kind: 'file' }, { name: 'same.xp3', kind: 'file' }], entries: [
    { root: 0, path: '', kind: 'file', source: blob }, { root: 1, path: '', kind: 'file', source: blob },
  ] }), /重复/)
  assert.equal(gameDropFiles({ roots: [{ name: 'again.xp3', kind: 'file' }], entries: [
    { root: 0, path: '', kind: 'file', source: blob },
  ] }).files[0]!.blob, blob)
})

test('whole-game imports admit hundreds of loose files while Window file-drop keeps its default root limit', async () => {
  const files = Array.from({ length: 301 }, (_, i) => new File(['file ' + i], i + '.txt')),
    transfer = { items: [], files, types: ['Files'] } as unknown as DataTransfer
  assert.throws(() => captureDrop(transfer), /top-level item budget/)
  const captured = captureDrop(transfer, 10000)
  await assert.rejects(enumerateDrop(captured, { signal: new AbortController().signal }), /Invalid captured drop/)
  const tree = await enumerateDrop(captured, { signal: new AbortController().signal, rootLimit: 10000 }), selected = gameDropFiles(tree)
  assert.equal(selected.directory, false)
  assert.equal(selected.files.length, 301)
  assert.deepEqual(selected.files.map((file) => file.path), files.map((file) => file.name))
  selected.files.forEach((file, i) => assert.equal(file.blob, files[i]))
})

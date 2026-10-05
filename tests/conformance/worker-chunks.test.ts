import test from 'node:test'
import assert from 'node:assert/strict'
import { assertWorkerEntryIsolation } from '../../scripts/build/worker-chunks.ts'

test('Worker build rejects the observed Vorbis static import of its executable Session entry', () => {
  assert.throws(() => assertWorkerEntryIsolation([
    { type: 'chunk', fileName: 'assets/session.worker.js', isEntry: true,
      dynamicImports: ['assets/ogg-vorbis.js'] },
    { type: 'chunk', fileName: 'assets/ogg-vorbis.js', imports: ['assets/session.worker.js'] },
  ]), /ogg-vorbis.*imports executable entry.*session\.worker/)
})

test('Worker build also rejects relative, dynamic and self imports of an entry', () => {
  for (const dependency of [
    { imports: ['./session.worker.js'] }, { dynamicImports: ['./session.worker.js'] },
  ]) assert.throws(() => assertWorkerEntryIsolation([
    { type: 'chunk', fileName: 'assets/session.worker.js', isEntry: true },
    { type: 'chunk', fileName: 'assets/lazy.js', ...dependency },
  ]), /imports executable entry/)
  assert.throws(() => assertWorkerEntryIsolation([
    { type: 'chunk', fileName: 'assets/session.worker.js', isEntry: true,
      imports: ['assets/session.worker.js'] },
  ]), /imports executable entry/)
})

test('Worker build permits an ordinary shared parser while preserving the lazy decoder edge', () => {
  assert.deepEqual(assertWorkerEntryIsolation([
    { type: 'chunk', fileName: 'assets/session.worker.js', isEntry: true,
      imports: ['assets/parser.js'], dynamicImports: ['assets/ogg-vorbis.js'] },
    { type: 'chunk', fileName: 'assets/ogg-vorbis.js', imports: ['./parser.js'] },
    { type: 'chunk', fileName: 'assets/parser.js', imports: [] },
    { type: 'asset', fileName: 'assets/codec.wasm' },
  ]), { entries: 1, chunks: 3 })
  assert.throws(() => assertWorkerEntryIsolation([{ type: 'asset', fileName: 'worker.js' }]), /no entry/)
})

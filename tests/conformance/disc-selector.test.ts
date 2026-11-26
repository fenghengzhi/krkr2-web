import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { CddaDiscs } from '../../src/engine/storage/cdda.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { StorageSelector } from '../../src/engine/storage/selector.ts'
import { discStoryImage } from '../helpers/disc-story.ts'

test('open-file selector browses a bound ISO, its empty directory and nested archive; save mode keeps the disc read-only', async () => {
  const bytes = discStoryImage(), disc = { name: 'story.iso', size: bytes.length, read: async () => bytes }
  const discs = new CddaDiscs({ currentDirectory: '', exact: async (path) => path === disc.name ? disc : undefined,
    exists: async () => false, cues: async () => [], read: (file) => file.read(), decodeText: () => '',
    checkpoint: async () => {} }, [{ drive: 'G', cue: 'story.iso' }])
  const archives = createSessionArchiveReader(), storage = new StorageResolver('', false, archives, async () => {}, discs)
  const saves = new SaveOverlay(new MemorySaveStore()), selector = new StorageSelector(storage, saves, 'savedata/')
  try {
    const open = await selector.prepare([0n, '', '', undefined, 0n, undefined, 0n])
    assert(open.presentation.directories.includes('file://./g/'))
    const root = await open.browse('file://./g/')
    assert(root.directories.includes('file://./g/routes/')); assert(root.directories.includes('file://./g/empty/'))
    assert(root.entries.some((entry) => entry.name === 'file://./g/empty.dat' && entry.size === 0))
    assert.deepEqual((await open.browse('file://./g/empty/')).entries, [])
    const books = await open.browse('file://./g/books/')
    assert(books.directories.includes('file://./g/books/scenes.zip>'))
    const choice = (name: string) => JSON.stringify({ name, overwrite: false, filterIndex: 0 })
    assert.equal(await open.choose(choice('G:/Books/Scenes.zip>Bonus.tjs')), '0\nfile://./g/books/scenes.zip>bonus.tjs')
    const save = await selector.prepare([0n, '', '', undefined, 1n, undefined, 0n])
    assert(!save.presentation.directories.includes('file://./g/'))
    await assert.rejects(save.choose(choice('G:/New.dat')), /read.only/i)
    await assert.rejects(save.browse('file://./g/'), /read.only/i)
  } finally { storage.dispose(); archives.dispose(); saves.close() }
})

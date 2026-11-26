import assert from 'node:assert/strict'
import test from 'node:test'
import { copyGameEncodings, copyProjectSelection, registryResourceFile } from '../../src/engine/storage/project.ts'
import { summary, validateRecord, validateSummary, type LibraryRecord } from '../../src/player/library/records.ts'

test('explicit registry resources remain anchored to the imported namespace across project selection', () => {
  for (const [input, expected] of [
    ['Game/settings.reg', 'game://./Game/settings.reg'],
    ['Game/data.xp3>設定.reg', 'game://./Game/data.xp3>設定.reg'],
    ['D:\\Config\\Game.reg', 'file://./d/config/game.reg'],
  ]) {
    assert.equal(registryResourceFile(input), expected)
    const selected = copyProjectSelection({ mode: 'root', directory: 'Game/data.xp3>', executableDirectory: 'Game/', registryFile: input })
    assert.equal(selected.registryFile, expected)
    assert.deepEqual(copyProjectSelection(selected), selected)
  }
  assert.deepEqual(copyGameEncodings({}), {})
  assert.deepEqual(copyProjectSelection(), { mode: 'collection' })
  for (const invalid of ['', '../outside.reg', 'Game/', 'data.xp3>', 'https://example.test/game.reg', 'bad\0name', 12, null])
    assert.throws(() => registryResourceFile(invalid))
})

test('library records and catalog summaries retain the selected registry without adding it to old records', () => {
  const legacy: LibraryRecord = {
    version: 1, id: 'entry-12345678-1234-4123-8123-123456789abc', gameId: 'game-' + 'a'.repeat(64),
    title: 'Registry game', entry: 'startup.tjs', backend: 'asyncify', createdAt: 1, size: 0, fileCount: 1,
    files: [{ path: 'startup.tjs', size: 0, hashes: [] }],
  }
  assert.equal(Object.hasOwn(validateRecord(legacy), 'registryFile'), false)
  assert.equal(Object.hasOwn(validateSummary(summary(legacy)), 'registryFile'), false)
  const configured = validateRecord({ ...legacy, registryFile: 'game://./Game/settings.reg' }),
    catalog = validateSummary(summary(configured))
  assert.equal(catalog.registryFile, 'game://./Game/settings.reg')
  assert.equal(catalog.gameId, legacy.gameId)
  assert.deepEqual(copyGameEncodings(catalog), { registryFile: 'game://./Game/settings.reg' })
  assert.equal(validateRecord({ ...configured, ...catalog }).registryFile, configured.registryFile)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { copyProjectSelection } from '../../src/engine/storage/project.ts'
import { readNativeSaves, writeNativeSaves } from '../../src/player/native-saves.ts'
import { summary, validateSummary } from '../../src/player/library/records.ts'
import { legacyZip } from '../helpers/legacy-zip-names.ts'
import type { ZipNameEncoding } from '../../src/formats/zip/names.ts'

const checkpoint = async () => {}
function packed(bytes: Buffer, name = 'scenes.zip') {
  const source = new BlobSource(new Blob([Uint8Array.from(bytes).buffer]))
  return { name, size: bytes.length, source, read: () => source.read(0, source.size) }
}
const file = (bytes: Buffer) => new File([Uint8Array.from(bytes).buffer], 'savedata.zip')

for (const [encoding, raw, decoded] of [
  ['cp437', [0x82], 'é'], ['shift_jis', [0x83, 0x5c], 'ソ'], ['gbk', [0xd6, 0xd0], '中'],
  ['cp850', [0x9b], 'ø'], ['cp866', [0x84, 0xa8, 0xe1, 0xaa], 'Диск'], ['windows-1252', [0xe9], 'é'],
  ['big5', [0xa4, 0xa4], '中'], ['utf-8', [0xe6, 0x97, 0xa5], '日'],
  ['euc-kr', [0x81, 0x41], '갂'], ['windows-1251', [0xc4, 0xe8, 0xf1, 0xea], 'Диск'],
] as const) test(`ZIP ${encoding}: both mount paths honor original byte names and Unicode declarations`, async () => {
  const archive = packed(legacyZip([
    { name: Buffer.from([...raw, 46, 107, 115]), bytes: 'scene' },
    { name: '雪.ks', utf8: true, unicode: 'ignored.ks', bytes: 'UTF-8 bit' },
    { name: Buffer.from([0xff]), unicode: '章.ks', bytes: 'Unicode extra' },
    { name: Buffer.from([...raw, 46, 50]), unicode: 'ignored.ks', unicodeCrc: 0, bytes: 'old CRC' },
    { name: Buffer.from(raw), bytes: 'extensionless' }, { name: 'directory/', bytes: '' },
  ]))
  const reader = createSessionArchiveReader(undefined, encoding)
  try {
    const index = await reader.open(archive, checkpoint)
    assert(index); assert.equal(index.kind, 'zip')
    const eager = await importSources([{ path: archive.name, source: archive.source }], checkpoint, { zipEncoding: encoding })
    for (const resources of [index.entries, eager.filter((entry) => entry.aliasOf)]) {
      assert.deepEqual(resources.map((entry) => entry.name), [decoded + '.ks', '雪.ks', '章.ks', decoded + '.2', decoded])
      assert.deepEqual(await Promise.all(resources.map(async (entry) => Buffer.from(await entry.read()).toString())),
        ['scene', 'UTF-8 bit', 'Unicode extra', 'old CRC', 'extensionless'])
    }
  } finally { reader.dispose() }
})

test('a native save ZIP decodes every path before publishing files and exports portable UTF-8 names', async () => {
  const name = Buffer.from([0x95, 0x5c, 47, 0x83, 0x5c, 46, 107, 100, 116])
  const entries = await readNativeSaves([file(legacyZip([{ name, bytes: Buffer.from([255, 254, 42, 0]) }]))], false, undefined, 'shift_jis')
  assert.deepEqual(entries.map((entry) => entry.path), ['表/ソ.kdt'])
  assert.deepEqual([...entries[0]!.bytes], [255, 254, 42, 0])
  const exported = await writeNativeSaves(entries)
  assert.deepEqual(await readNativeSaves([new File([exported], 'savedata.zip')], false, undefined, 'big5'), entries)
  const invalid = file(legacyZip([{ name: 'prior.kdt', bytes: 'ok' }, { name: Buffer.of(0x82), bytes: 'invalid' }]))
  await assert.rejects(readNativeSaves([invalid], false, undefined, 'shift_jis'), /shift_jis/)
  const collision = file(legacyZip([{ name, bytes: 'one' }, { name: '表/ソ.kdt', utf8: true, bytes: 'two' }]))
  await assert.rejects(readNativeSaves([collision], false, undefined, 'shift_jis'), /duplicate|重复|冲突/i)
})

test('encoding is validated on import and library reopen; legacy selections and records keep their shape', () => {
  const game = { id: 'entry-12345678-1234-4123-8123-123456789abc', gameId: 'game-' + '0'.repeat(64),
    title: 'Scene', entry: 'startup.tjs', backend: 'auto' as const, createdAt: 1, size: 1, fileCount: 1 }
  assert.deepEqual(validateSummary(game), game)
  assert.deepEqual(summary({ ...game, zipEncoding: 'shift_jis' }), { ...game, zipEncoding: 'shift_jis' })
  assert.deepEqual(copyProjectSelection({ mode: 'collection', zipEncoding: 'cp437' }), { mode: 'collection' })
  assert.equal(copyProjectSelection({ mode: 'collection', zipEncoding: 'gbk' }).zipEncoding, 'gbk')
  assert.throws(() => copyProjectSelection({ mode: 'auto', zipEncoding: 'bad' as ZipNameEncoding }), /ZIP/)
  assert.throws(() => validateSummary({ ...game, zipEncoding: 'bad' }), /ZIP/)
})

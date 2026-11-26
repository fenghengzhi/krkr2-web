import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { headless } from '../helpers/headless.ts'
import { oemGameDiscInput } from '../helpers/oem-game-disc.ts'

test('a Japanese primary ISO keeps its project, chapter and volume names when the game changes script encoding or reinserts the disc', async (t) => {
  const { files } = oemGameDiscInput(), { name, buffer } = files[0]!
  const image = { name, size: buffer.length,
    source: { size: buffer.length, async read(at: number, length: number) {
      assert(length <= 65536); return buffer.subarray(at, at + length)
    } },
    async read(): Promise<Uint8Array> { throw new Error('Unexpected whole-disc read') },
  }
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const selection = { mode: 'auto', executable: name, discNameEncoding: 'shift_jis' } as const
  const mounted = await prepareProject([image], selection, reader, async () => {})
  assert(mounted.project)
  assert.equal(mounted.project.bootDisc, name)
  assert.equal(mounted.project.executableDirectory, 'file://./d/表game/')
  const { session } = await headless({}, { project: mounted.project, discNameEncoding: 'shift_jis' })
  session.mount(mounted.resources)
  const chapter = '[Storages.searchCD("KRKR_表"),[].load("D:/表/表.ks")[0]].join("|")'
  try {
    assert.equal(await session.evaluate(chapter), 'D|*arrival|Disc chapter')
    await session.evaluate('Scripts.textEncoding="UTF-8"')
    assert.equal(await session.evaluate(chapter), 'D|*arrival|Disc chapter')
    await session.changeDisc({ kind: 'eject', drive: 'D' })
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_表")'), '')
    await session.changeDisc({ kind: 'insert', drive: 'D', cue: name }, async () => [image])
    assert.equal(await session.evaluate(chapter), 'D|*arrival|Disc chapter')
    assert.equal(session.snapshot().discNameEncoding, 'shift_jis')
  } finally { await session.stop() }
})

// Optional reference preparation: preserve member bytes while changing only the container.
// Python's independent ZIP writer is a probe dependency, never a runtime dependency.
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { BlobSource, inflate } from '../../src/backends/files/blob-source.ts'
import { readXp3 } from '../../src/formats/xp3/archive.ts'

const [input, output, python = 'python3'] = process.argv.slice(2)
if (!input || !output || !output.endsWith('.zip'))
  throw new Error(
    'Usage: node --import tsx tests/probes/repack-xp3.ts input.xp3 output.zip [python3]',
  )
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const original = new Uint8Array(await readFile(resolve(input)))
const resources = await readXp3(new BlobSource(new Blob([original.buffer])), inflate)
const entries: { name: string; base64: string; size: number; sha256: string }[] = []
let total = 0
for (const resource of resources) {
  total += resource.size
  if (total > 64 * 1024 * 1024) throw new Error('Reference repack exceeds 64 MiB member budget')
  const bytes = await resource.read()
  entries.push({
    name: resource.name,
    base64: Buffer.from(bytes).toString('base64'),
    size: bytes.length,
    sha256: hash(bytes),
  })
}
await mkdir(dirname(resolve(output)), { recursive: true })
const temporary = await mkdtemp(resolve(tmpdir(), 'krkr2-repack-'))
try {
  const payload = resolve(temporary, 'members.json')
  await writeFile(payload, JSON.stringify(entries))
  const result = spawnSync(
    python,
    [
      '-c',
      `
import base64, json, sys, zipfile
with open(sys.argv[1], encoding='utf-8') as stream:
    entries = json.load(stream)
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for entry in entries:
        info = zipfile.ZipInfo(entry['name'], date_time=(2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, base64.b64decode(entry['base64']))
with zipfile.ZipFile(sys.argv[2]) as archive:
    actual = archive.infolist()
    assert len(actual) == len(entries)
    for info, entry in zip(actual, entries):
        assert info.filename == entry['name']
        assert archive.read(info) == base64.b64decode(entry['base64'])
`,
      payload,
      resolve(output),
    ],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(result.stderr || 'Python reference ZIP verification failed')
  const metadata = {
    source: resolve(input),
    sourceSha256: hash(original),
    zip: resolve(output),
    zipSha256: hash(await readFile(resolve(output))),
    decodedBytes: total,
    entries: entries.map(({ base64: _base64, ...entry }) => entry),
  }
  await writeFile(resolve(output) + '.json', JSON.stringify(metadata, null, 2) + '\n')
  console.log(
    `Repacked and independently checked ${entries.length} members (${total} decoded bytes)`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}

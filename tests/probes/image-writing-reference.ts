// Optional: node --import tsx tests/probes/image-writing-reference.ts [reference-root] [python]
// Python needs Pillow. Encoded TLGs go through the original C++ loaders; PNGs through Pillow.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { ImageWriter } from '../../src/engine/storage/image-writer.ts'
import { deflateImage } from '../../src/backends/files/blob-source.ts'
import { encodePng } from '../../src/formats/image/png-encoder.ts'
import { writingCases, writingTags } from '../helpers/image-writing-vectors.ts'
const visual = resolve(process.argv[2] ?? '../kirikiroid2-web', 'cpp/core/visual'),
  directory = mkdtempSync(join(tmpdir(), 'krkr-image-writing-')),
  hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
try {
  const source = readFileSync(join(visual, 'LoadTLG.cpp'), 'utf8'),
    start = source.indexOf('void TVPLoadTLG5('),
    end = source.indexOf('static void TVPInternalLoadTLG(')
  if (start < 0 || end < start) throw new Error('Native loader extraction anchors changed')
  const extracted = source.slice(start, end)
  writeFileSync(join(directory, 'load-tlg.inc'), extracted)
  const binary = join(directory, 'decoder')
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O2',
      '-I',
      'third_party/tjs2',
      '-I',
      visual,
      '-I',
      join(visual, 'gl'),
      '-I',
      directory,
      'tests/probes/tlg-decoder.cpp',
      join(visual, 'tvpgl.cpp'),
      join(visual, 'gl/blend_function.cpp'),
      '-o',
      binary,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const writer = new ImageWriter(deflateImage, async (work) => finish(work)),
    entries = [],
    requests: Buffer[] = [],
    nativeExpected: Uint8Array[] = [],
    pngExpected: Uint8Array[] = [],
    pngFiles: string[] = []
  for (const c of writingCases()) {
    const encoded = await writer.encode(c.image, c.type, writingTags),
      expected = c.image.data.slice()
    if (c.type.endsWith('24')) for (let i = 3; i < expected.length; i += 4) expected[i] = 255
    const entry: {
      id: string
      encodedSha256?: string
      filteredSha256?: string
      decodedSha256: string
      encodedBytes: number
    } = { id: c.id, decodedSha256: hash(expected), encodedBytes: encoded.length }
    if (c.type.startsWith('png')) {
      const path = join(directory, `image-${entries.length}.png`)
      writeFileSync(path, encoded)
      pngFiles.push(path)
      pngExpected.push(expected)
      entry.filteredSha256 = hash(
        finish(encodePng(c.image, c.type !== 'png24', writingTags)).filtered,
      )
    } else {
      entry.encodedSha256 = hash(encoded)
      const raw = encoded.subarray(
          15,
          15 +
            new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(
              11,
              true,
            ),
        ),
        size = Buffer.alloc(4)
      size.writeUInt32LE(raw.length)
      requests.push(size, Buffer.from(raw))
      nativeExpected.push(expected)
    }
    entries.push(entry)
  }
  const output = execFileSync(binary, {
    input: Buffer.concat(requests),
    maxBuffer: 16 * 1024 * 1024,
  })
  let at = 0
  for (const expected of nativeExpected) {
    const size = output.readUInt32LE(at)
    at += 4
    if (!output.subarray(at, at + size).equals(Buffer.from(expected)))
      throw new Error(`Native pixel mismatch at output ${at}`)
    at += size
  }
  if (at !== output.length) throw new Error('Extra native output')
  const python = process.argv[3] ?? 'python3',
    pythonCode =
      'import sys,struct\nfrom PIL import Image\nfor path in sys.argv[1:]:\n image=Image.open(path)\n data=image.convert("RGBA").tobytes()\n sys.stdout.buffer.write(struct.pack("<I",len(data))+data)\n',
    pngOutput = execFileSync(python, ['-c', pythonCode, ...pngFiles], {
      maxBuffer: 16 * 1024 * 1024,
    })
  at = 0
  for (const expected of pngExpected) {
    const size = pngOutput.readUInt32LE(at)
    at += 4
    if (!pngOutput.subarray(at, at + size).equals(Buffer.from(expected)))
      throw new Error(`Pillow pixel mismatch at output ${at}`)
    at += size
  }
  if (at !== pngOutput.length) throw new Error('Extra Pillow output')
  writeFileSync(
    'tests/fixtures/image-writing-reference.json',
    JSON.stringify(
      {
        description:
          'Current TS encoders validated by unmodified native LoadTLG5/6 + TVP kernels and independent Pillow PNG decoding. TLG hashes bind exact encoded bytes; PNG filtered-row hashes avoid depending on a browser zlib version.',
        cases: entries.length,
        nativeTlgCases: nativeExpected.length,
        pngCases: pngExpected.length,
        referenceNotes: [
          'The native test allocator zero-initializes the extra fetch padding; decoder arithmetic is unmodified',
        ],
        sources: Object.fromEntries(
          ['LoadTLG.cpp', 'tvpgl.cpp', 'tvpgl.h', 'gl/blend_function.cpp'].map((file) => [
            file,
            hash(readFileSync(join(visual, file))),
          ]),
        ),
        extractedSha256: hash(extracted),
        adapterSha256: hash(readFileSync('tests/probes/tlg-decoder.cpp')),
        entries,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    `Verified ${nativeExpected.length} native TLG and ${pngExpected.length} Pillow PNG outputs`,
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}

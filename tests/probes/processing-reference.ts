// Optional: node --import tsx tests/probes/processing-reference.ts [reference-root]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { processingCases } from '../helpers/processing-vectors.ts'

const visual = resolve(process.argv[2] ?? '../kirikiroid2-web', 'cpp/core/visual'),
  directory = mkdtempSync(join(tmpdir(), 'krkr-processing-reference-'))
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
try {
  const original = readFileSync(join(visual, 'LayerBitmapIntf.cpp'), 'utf8'),
    start = original.indexOf('// some blur operation template functions'),
    end = original.indexOf('\n#endif', start)
  if (
    start < 0 ||
    end < start ||
    !original.slice(start, end).includes('void tTVPBaseBitmap::DoBoxBlurLoop')
  )
    throw new Error('Original CPU box loop not found')
  // The retained loop flushes an unfilled ring when clip height <= ry. Bound
  // the ring by the written height; all sampling/averaging arithmetic stays
  // original. C++17 also needs typename in its old dependent typedef.
  const ring = 'tjs_int dest_buf_size = area.top <= 0 ? (1-area.top) : 0;'
  if (!original.slice(start, end).includes(ring))
    throw new Error('Reference ring declaration changed')
  const extracted = original
    .slice(start, end)
    .replace(
      'typedef tARGB::base_int_type base_type;',
      'typedef typename tARGB::base_int_type base_type;',
    )
    .replace(
      ring,
      'tjs_int dest_buf_size = std::min(area.top <= 0 ? (1-area.top) : 0, rect.bottom - rect.top);',
    )
  writeFileSync(join(directory, 'box-loop.inc'), extracted)
  const binary = join(directory, 'oracle')
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
      'tests/probes/processing-oracle.cpp',
      join(visual, 'argb.cpp'),
      join(visual, 'tvpgl.cpp'),
      join(visual, 'gl/blend_function.cpp'),
      '-o',
      binary,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cases = [...processingCases()]
  const input =
    cases
      .map((c) => {
        const words = []
        for (let at = 0; at < c.source.data.length; at += 4)
          words.push(
            (c.source.data[at]! |
              (c.source.data[at + 1]! << 8) |
              (c.source.data[at + 2]! << 16) |
              (c.source.data[at + 3]! << 24)) >>>
              0,
          )
        return [
          c.operation,
          c.source.width,
          c.source.height,
          c.clip.x,
          c.clip.y,
          c.clip.width,
          c.clip.height,
          c.rx,
          c.ry,
          ...words,
        ].join(' ')
      })
      .join('\n') + '\n'
  const output = execFileSync(binary, { input, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
      .trim()
      .split('\n'),
    pixels = cases.reduce((sum, c) => sum + c.source.width * c.source.height, 0)
  if (output.length !== pixels) throw new Error('Reference pixel count mismatch')
  const bytes = Buffer.alloc(pixels * 4)
  output.forEach((value, index) => bytes.writeUInt32LE(Number(value), index * 4))
  writeFileSync('tests/fixtures/processing-reference.bin', bytes)
  const sources = [
    'LayerBitmapIntf.cpp',
    'LayerIntf.cpp',
    'argb.h',
    'argb.cpp',
    'tvpgl.cpp',
    'tvpgl.h',
    'gl/blend_function.cpp',
    'gl/blend_functor_c.h',
  ]
  writeFileSync(
    'tests/fixtures/processing-reference.json',
    JSON.stringify(
      {
        description:
          'TVP scalar conversions/grayscale and original CPU DoBoxBlurLoop (retained under #if 0 in the local reference), with its short-clip ring capped to clip height to remove uninitialized reads. Excludes the modern OpenCV/no-op and OGL approximations.',
        referenceRepairs: [
          'Added C++17 dependent typename',
          'Bound destination ring size to clip height; original averaging and source sampling unchanged',
          'Zero-initialized the spare vertical-sum sentinel used after the final output pixel',
        ],
        cases: cases.length,
        pixels,
        sha256: hash(bytes),
        inputSha256: hash(input),
        sources: Object.fromEntries(
          sources.map((file) => [file, hash(readFileSync(join(visual, file)))]),
        ),
        extractedSha256: hash(extracted),
        adapterSha256: hash(readFileSync('tests/probes/processing-oracle.cpp')),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Recorded ${cases.length} processing cases (${pixels} pixels)`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

// Optional: node --import tsx tests/probes/tlg-reference.ts [reference-root]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { tlgCases } from '../helpers/tlg-vectors.ts'

const visual = resolve(process.argv[2] ?? '../kirikiroid2-web', 'cpp/core/visual'),
  directory = mkdtempSync(join(tmpdir(), 'krkr-tlg-reference-')),
  hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
try {
  const five = readFileSync(join(visual, 'SaveTLG5.cpp'), 'utf8'),
    six = readFileSync(join(visual, 'SaveTLG6.cpp'), 'utf8'),
    start5 = five.indexOf('SlideCompressor::SlideCompressor()'),
    start6 = six.indexOf("// Table for 'k'"),
    end6 = six.indexOf('extern void SaveTLG5'),
    selection = '// Apply most efficient color filter / prediction',
    apply = 'ApplyColorFilter(block_buf[0] + gwp, block_buf[1] + gwp,'
  if (
    start5 < 0 ||
    start6 < 0 ||
    end6 <= start6 ||
    !six.includes(selection) ||
    !six.includes(apply)
  )
    throw new Error('Reference encoder extraction anchors changed')
  const extracted5 = five.slice(start5).replace('i < SLIDE_N + SLIDE_M;', 'i < sizeof(Text);'),
    extracted6 = six
      .slice(start6, end6)
      .replace('tjs_uint reordertick;', 'tjs_uint reordertick = 0;')
      .replace(
        selection,
        `if (TLGProbeFilter >= 0) ft = TLGProbeFilter;\nif (TLGProbePrediction >= 0) minp = TLGProbePrediction;\n${selection}`,
      )
      .replace(apply, `if (colors >= 3) ${apply}`)
  writeFileSync(join(directory, 'five.cpp'), '#include "tlg-encoder.hpp"\n' + extracted5)
  writeFileSync(join(directory, 'six.cpp'), '#include "tlg-encoder.hpp"\n' + extracted6)
  const binary = join(directory, 'encoder')
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O2',
      '-fsigned-char',
      '-I',
      'tests/probes',
      '-I',
      'third_party/tjs2',
      '-I',
      visual,
      '-I',
      join(visual, 'gl'),
      'tests/probes/tlg-encoder.cpp',
      join(directory, 'five.cpp'),
      join(directory, 'six.cpp'),
      join(visual, 'tvpgl.cpp'),
      join(visual, 'gl/blend_function.cpp'),
      '-o',
      binary,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cases = [...tlgCases()],
    input =
      cases
        .map((c) => {
          const pixels = []
          for (let at = 0; at < c.data.length; at += 4)
            pixels.push(
              (c.data[at]! |
                (c.data[at + 1]! << 8) |
                (c.data[at + 2]! << 16) |
                (c.data[at + 3]! << 24)) >>>
                0,
            )
          return [c.version, c.colors, c.width, c.height, c.filter, c.predictor, ...pixels].join(
            ' ',
          )
        })
        .join('\n') + '\n'
  const bytes = execFileSync(binary, { input, maxBuffer: 16 * 1024 * 1024 }),
    entries = []
  let position = 0
  for (const c of cases) {
    const size = bytes.readUInt32LE(position)
    position += 4
    if (position + size > bytes.length) throw new Error('Truncated encoder output')
    entries.push({
      id: c.id,
      offset: position,
      size,
      sha256: hash(bytes.subarray(position, position + size)),
    })
    position += size
  }
  if (position !== bytes.length) throw new Error('Extra encoder output')
  writeFileSync('tests/fixtures/tlg-reference.bin', bytes)
  writeFileSync(
    'tests/fixtures/tlg-reference.json',
    JSON.stringify(
      {
        description:
          'Original TLG5/TLG6 encoders applied to independently generated RGBA patterns; BGRA bitmap adapter. Forced filter/predictor selection covers all 32 TLG6 combinations without replacing codec arithmetic.',
        referenceRepairs: [
          'Bound SlideCompressor initial zero fill to its declared Text array (original wrote one byte past it)',
          'Initialize unused timing accumulator',
          'Skip no-op color filter for grayscale to avoid null-pointer arithmetic',
        ],
        cases: cases.length,
        pixels: cases.reduce((sum, c) => sum + c.width * c.height, 0),
        sha256: hash(bytes),
        inputSha256: hash(input),
        sources: Object.fromEntries(
          [
            'SaveTLG5.cpp',
            'SaveTLG6.cpp',
            'SaveTLG.h',
            'tvpgl.cpp',
            'tvpgl.h',
            'gl/blend_function.cpp',
          ].map((file) => [file, hash(readFileSync(join(visual, file)))]),
        ),
        extracted: { five: hash(extracted5), six: hash(extracted6) },
        adapters: Object.fromEntries(
          ['tlg-encoder.hpp', 'tlg-encoder.cpp'].map((file) => [
            file,
            hash(readFileSync(join('tests/probes', file))),
          ]),
        ),
        entries,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Recorded ${cases.length} TLG cases (${bytes.length} encoded bytes)`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

// Opt-in fixture regeneration: node --import tsx tests/probes/blend-reference.ts [reference-root]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { blendCases } from '../helpers/blend-vectors.ts'

const root = resolve(process.argv[2] ?? '../kirikiroid2-web')
const visual = join(root, 'cpp/core/visual')
const directory = mkdtempSync(join(tmpdir(), 'krkr-blend-reference-'))
const files = [
  'tvpgl.cpp',
  'tvpgl.h',
  'gl/blend_function.cpp',
  'gl/blend_functor_c.h',
  'gl/blend_variation.h',
  'gl/blend_util_func.h',
]
try {
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
      'tests/probes/blend-oracle.cpp',
      join(visual, 'tvpgl.cpp'),
      join(visual, 'gl/blend_function.cpp'),
      '-o',
      binary,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cases = [...blendCases()]
  const input =
    cases
      .map((c) => [c.destination, c.source, c.mode, c.face, c.opacity, Number(c.hold)].join(' '))
      .join('\n') + '\n'
  const outputs = execFileSync(binary, { input, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
    .trim()
    .split('\n')
  if (outputs.length !== cases.length) throw new Error('Reference output count mismatch')
  const bytes = Buffer.alloc(outputs.length * 4)
  outputs.forEach((value, index) => bytes.writeUInt32LE(Number(value), index * 4))
  writeFileSync('tests/fixtures/blend-reference.bin', bytes)
  writeFileSync(
    'tests/fixtures/blend-reference.json',
    JSON.stringify(
      {
        description:
          'TVPInitTVPGL dispatch, one pixel per call; scalar tail semantics, not SIMD block/alignment shortcuts. Excludes unavailable bmAddAlphaOnAlpha. Generated from the local kirikiroid2-web reference.',
        cases: cases.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sources: Object.fromEntries(
          files.map((file) => [
            file,
            createHash('sha256')
              .update(readFileSync(join(visual, file)))
              .digest('hex'),
          ]),
        ),
        adapterSha256: createHash('sha256')
          .update(readFileSync('tests/probes/blend-oracle.cpp'))
          .digest('hex'),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Recorded ${cases.length} independent reference pixels`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

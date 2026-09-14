// Optional: node --import tsx tests/probes/loading-reference.ts [reference-root]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const visual = resolve(process.argv[2] ?? '../kirikiroid2-web', 'cpp/core/visual'),
  directory = mkdtempSync(join(tmpdir(), 'krkr-loading-reference-')),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
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
      'tests/probes/loading-reference.cpp',
      join(visual, 'tvpgl.cpp'),
      join(visual, 'gl/blend_function.cpp'),
      '-o',
      binary,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const lines = execFileSync(binary, { encoding: 'utf8' }).trim().split('\n'),
    bytes = Buffer.alloc(lines.length * 16)
  lines.forEach((line, index) =>
    line
      .split(' ')
      .forEach((value, field) => bytes.writeUInt32LE(Number(value), index * 16 + field * 4)),
  )
  writeFileSync('tests/fixtures/loading-reference.bin', bytes)
  writeFileSync(
    'tests/fixtures/loading-reference.json',
    JSON.stringify(
      {
        description:
          'Unmodified TVP scalar AlphaColorMat, MakeAlphaFromKey and BindMaskToMain; one pixel per call; all 256 alpha/mask values and positive/negative channel deltas.',
        cases: lines.length,
        sha256: hash(bytes),
        sources: Object.fromEntries(
          ['tvpgl.cpp', 'tvpgl.h', 'gl/blend_function.cpp'].map((file) => [
            file,
            hash(readFileSync(join(visual, file))),
          ]),
        ),
        adapterSha256: hash(readFileSync('tests/probes/loading-reference.cpp')),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Recorded ${lines.length} image loading reference pixels`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

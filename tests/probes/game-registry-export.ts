import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readRegistryExport } from '../../src/engine/system/registry.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const dir = 'out/verification/native-eri/game-registry/'
const report = JSON.parse(readFileSync(dir + 'comparison.json', 'utf8').replace(/^\ufeff/, ''))
assert.equal(report.commit, process.env.GITHUB_SHA)
assert.equal(report.matched, true)
assert.equal(report.cleaned, true)
const bytes = readFileSync(dir + 'export.reg')
assert.equal(createHash('sha256').update(bytes).digest('hex'), report.exportSha256)
const registry = await readRegistryExport({ name: 'export.reg', size: bytes.length, read: async () => bytes },
  (data) => readText(data, '', undefined, 'plain'), async () => {})
const root = 'HKEY_CURRENT_USER\\' + report.key + '\\'
const values = ['', 'Caption', 'Score', 'Target', 'Big'].map((name) => registry.read(root + name))
assert.deepEqual(values, ['Default', '月の章', 4294967295n, '%GAME%', 2147483649n])
assert.equal(registry.read(report.key + '\\score'), 4294967295n)
for (const name of ['Missing', 'List', 'Binary']) assert.equal(registry.read(root + name), undefined)

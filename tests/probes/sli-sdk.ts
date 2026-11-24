import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sliInvalidNames, sliNativeFiles, sliNativeSource } from '../helpers/sli-native-fixtures.ts'
import { wavePrecisionFiles } from '../helpers/extensible-wave.ts'
import { wavePositionExpected, wavePositionFiles, wavePositionSource } from '../helpers/wave-position.ts'

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/sli'), game = resolve(output, 'game')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const expected: Record<string, string> = { open: 'open', names: '0|10|40|41|400|800',
  ...Object.fromEntries(sliInvalidNames.map((name) => [name, 'sli:<' + name + '.sli>'])),
  changed: 'changed:<bad-smooth.wav.sli>', reopen: 'open',
  '12-in-16.wav': 'open|48000', '20-in-24.wav': 'open|48000', '24-in-32.wav': 'open|48000',
  'foreign-guid.wav': 'wave:<foreign-guid.wav>', ...wavePositionExpected }
const precision = wavePrecisionFiles(), files = { ...sliNativeFiles(), ...precision, ...wavePositionFiles() }
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')
if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(resolve(game, name), bytes)
  const startup = Buffer.from('\ufeff' + [
    'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;',
    'var rows=[];function record(s){rows.add(s);rows.save("native-events.txt");}',
    'record("start");System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    sliNativeSource,
    wavePositionSource,
    ...Object.keys(wavePositionExpected).map((name) =>
      `try{record("${name}|"+wavePositionObserve("${name}"));}catch(e){record("${name}|unexpected-error:"+e.message);}`),
    'System.assignMessage("TVPInvalidLoopInformation","sli:<%1>");record("open|"+sliTryOpen("native.wav"));',
    String.raw`try{var n=["start",'"quoted"',"path\\tone","日本語","selected","later"],positions=[];
      for(var i=0;i<n.count;i++){positions.add(sliSound.labels[n[i]].samplePosition);}
      record("names|"+positions.join("|"));}catch(e){record("names|"+e.message);}`,
    ...sliInvalidNames.map((name) => `record("${name}|"+sliTryOpen("${name}"));`),
    'System.assignMessage("TVPInvalidLoopInformation","changed:<%1>");',
    'record("changed|"+sliTryOpen("bad-smooth.wav"));record("reopen|"+sliTryOpen("native.wav"));',
    'System.assignMessage("TVPUnknownWaveFormat","wave:<%1>");var opened;',
    ...Object.keys(precision).map((name) =>
      `opened=sliTryOpen("${name}");record("${name}|"+opened+(opened=="open"?"|"+sliSound.frequency:""));`),
    'record("done");System.exit();',
  ].join('\n'), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, startupSha256: digest(startup),
    files: Object.entries(files).map(([name, bytes]) => ({ name, sha256: digest(bytes) })) })
} else if (process.argv[2] === 'compare') {
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.equal(digest(readFileSync(resolve(game, 'startup.tjs'))), manifest.startupSha256)
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(new Uint8Array(readFileSync(resolve(game, name))), bytes)
  const sdk = JSON.parse(readFileSync(resolve(output, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
  const path = resolve(game, 'native-events.txt'), raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const results = Object.entries(expected).map(([id, value]) => {
    const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    return { id, expected: value, observed, matched: observed.length === 1 && observed[0] === value }
  })
  const complete = sdk.commit === manifest.commit && sdk.state === 'observed' && sdk.exitCode === 0 &&
    lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' && results.every((r) => r.matched)
  save('comparison.json', { commit: manifest.commit, complete, observationSha256: digest(raw), results,
    wavePositionScope: 'Default ordinary sound mode: float coordinates, pan capability lifecycle and script errors. Device-dependent open/play failures remain failed observations, not spatial-rendering evidence or passing skips.' })
  assert(complete, 'SLI file or label dictionary observations differed')
} else throw new Error('Expected prepare or compare')

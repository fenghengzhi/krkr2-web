import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { startupScriptModesSource } from '../helpers/startup-script-modes.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const root = resolve('out/verification/native-player-config'),
  sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex'),
  utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')

// Independently authored ASCII .cf/.cfu bytes. TStringList's ANSI decoding is
// deliberately not confused with TJS UTF16 script/text-stream decoding.
const defaults = [
  '; ignored configuration comment', 'flag', 'route=default', 'route=duplicate',
  'datapath=$(exepath)/Profiles', 'quoted="hello world"', "single='one two'",
  'escaped="line\\nend"', 'quote="A\\"B"', 'empty=', 'first=one', 'first=two',
  'Case=upper', 'case=lower',
  'holdalpha=yes', 'evalcontext=global', 'unaryaster=compat', 'gclim=1',
].join('\r\n') + '\r\n'
const user = ['route=user', 'route=user-duplicate', 'flag=user-flag',
  'datapath=$(exepath)/Ignored', 'quoted="user value"', 'useronly=present',
  'holdalpha=true', 'evalcontext=instance', 'unaryaster=normal', 'gclim=2'].join('\r\n') + '\r\n'
const cliUser = ['route=cli-directory-user', 'route=ignored-duplicate', 'flag=cli-directory-flag',
  'datapath=$(exepath)/IgnoredAgain', 'useronly=cli-directory',
  'holdalpha=disabled', 'evalcontext=other', 'unaryaster=other', 'gclim=1'].join('\r\n') + '\r\n'
const trap = 'route=wrong-directory\r\nflag=wrong-directory\r\n'
const common: Record<string, string | null> = {
  flag: 'yes', route: 'default', datapath: '$(exepath)/Profiles', quoted: 'hello world', single: 'one two',
  escaped: 'line\nend', quote: 'A"B', empty: '', first: 'one', Case: 'upper', case: 'lower', useronly: null,
  holdalpha: 'yes', evalcontext: 'global', unaryaster: 'compat', gclim: '1',
}
interface ConfigCase {
  id: string
  args: string[]
  directory: string
  configs: Record<string, string>
  expected: Record<string, string | null>
  modes: string
  cacheLimit: number | 'auto'
}
const cases: ConfigCase[] = [
  { id: 'embedded-empty', args: [], directory: 'savedata', configs: {},
    expected: Object.fromEntries(Object.keys(common).map((key) => [key, null])), modes: 'instance:1:0|amp|0|255', cacheLimit: 'auto' },
  { id: 'defaults', args: [], directory: 'Profiles', configs: { 'krkr.cf': defaults }, expected: { ...common },
    modes: 'global:0:1|star|1|73', cacheLimit: 1048576 },
  { id: 'user', args: [], directory: 'Profiles', configs: {
    'krkr.cf': defaults, 'Profiles/krkr.cfu': user, 'Ignored/krkr.cfu': trap,
  }, expected: { ...common, flag: 'user-flag', route: 'user', datapath: '$(exepath)/Ignored', quoted: 'user value', useronly: 'present',
    holdalpha: 'true', evalcontext: 'instance', unaryaster: 'normal', gclim: '2' }, modes: 'instance:1:0|amp|1|73', cacheLimit: 2097152 },
  { id: 'command-line', args: ['-route=command', '-route=late-duplicate', '-flag=command-flag',
    '-holdalpha=no', '-evalcontext=global', '-unaryaster=compat', '-gclim=0'], directory: 'Profiles', configs: {
    'krkr.cf': defaults, 'Profiles/krkr.cfu': user, 'Ignored/krkr.cfu': trap,
  }, expected: { ...common, flag: 'command-flag', route: 'command', datapath: '$(exepath)/Ignored', quoted: 'user value', useronly: 'present',
    holdalpha: 'no', gclim: '0' }, modes: 'global:0:1|star|0|255', cacheLimit: 0 },
  { id: 'command-data-directory', args: ['-datapath=$(exepath)/CliProfiles'], directory: 'CliProfiles', configs: {
    'krkr.cf': defaults.replace('gclim=1', 'gclim=2'), 'Profiles/krkr.cfu': user, 'CliProfiles/krkr.cfu': cliUser, 'IgnoredAgain/krkr.cfu': trap,
  }, expected: { ...common, flag: 'cli-directory-flag', route: 'cli-directory-user', datapath: '$(exepath)/CliProfiles', useronly: 'cli-directory',
    holdalpha: 'disabled', evalcontext: 'other', unaryaster: 'other' }, modes: 'instance:1:0|amp|0|255', cacheLimit: 1048576 },
]
const script = (id: string) => String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var records=[];
function record(value){records.add(value);records.save("native-events.txt");}
function argument(name){var value=System.getArgument(name);return value===void?"<void>":string(value).escape();}
record("start");
System.exceptionHandler=function(e){record("fatal|"+e.message.escape());System.exit();return true;};
try{
 record("exe|"+System.exePath);record("data|"+System.dataPath);
 ${Object.keys(common).map((key) => `record(${JSON.stringify('argument|' + key + '|')}+argument(${JSON.stringify('-' + key)}));`).join('\n')}
 record("cache|initial|"+System.graphicCacheLimit);
 System.graphicCacheLimit=gcsAuto;record("cache|auto|"+System.graphicCacheLimit);
 System.graphicCacheLimit=3145728;record("cache|above|"+System.graphicCacheLimit);
 System.graphicCacheLimit=4096;record("cache|small|"+System.graphicCacheLimit);
 System.graphicCacheLimit=4294967297;record("cache|wide|"+System.graphicCacheLimit);
 System.graphicCacheLimit=-2;record("cache|negative|"+System.graphicCacheLimit);
 System.graphicCacheLimit=0;record("cache|zero|"+System.graphicCacheLimit);
 System.graphicCacheLimit=gcsAuto;record("cache|restored|"+System.graphicCacheLimit);
 Scripts.execStorage("modes.tjs");record("modes|"+startupScriptModes());
 var proof=${JSON.stringify('config-proof:' + id + '|')}+argument("-route")+"|"+argument("-datapath");
 [proof].save(System.dataPath+"config-proof.txt");
 record("saved|"+[].load(System.dataPath+"config-proof.txt")[0]);record("done");
}catch(e){record("fatal|"+e.message.escape());}
System.exit();
`
const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\r', '\\r')
  .replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('"', '\\"').replaceAll("'", "\\'")
// Independent literal requests and native uint32/clamp contracts. The unconfigured
// process records its host-dependent automatic maximum; it is not assumed to be
// the Web player's default or a fixed value for all Windows runners.
const cacheRows = (limit: number) => [
  'cache|initial|0', `cache|auto|${limit}`, `cache|above|${Math.min(3145728, limit)}`,
  `cache|small|${Math.min(4096, limit)}`, `cache|wide|${Math.min(1, limit)}`,
  `cache|negative|${limit}`, 'cache|zero|0', `cache|restored|${limit}`,
]

if (process.argv[2] === 'inspect-stock') {
  const path = process.argv[3]; assert(path)
  const pin = JSON.parse(readFileSync('tests/fixtures/native-reference/sdk.json', 'utf8')),
    bytes = readFileSync(path), marker = Buffer.from('XOPT_EMBED_AREA_', 'ascii'),
    end = Math.min(bytes.length, 5 * 1024 * 1024), matches: number[] = []
  assert.equal(bytes.length, pin.engineBytes); assert.equal(sha(bytes), pin.engineSha256)
  for (let at = 512 * 1024; at + 16 <= end; at += 16)
    if (bytes.subarray(at, at + 16).equals(marker)) matches.push(at)
  const offset = matches[0], start = offset === undefined ? undefined : offset + 20,
    nul = start === undefined ? -1 : bytes.indexOf(0, start),
    payload = start === undefined || nul < start || nul >= end ? undefined : bytes.subarray(start, nul)
  const record = { commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID,
    engineBytes: bytes.length, engineSha256: sha(bytes), markerOffsets: matches, offset,
    sizeField: offset === undefined ? undefined : bytes.readUInt32LE(offset + 16), payloadOffset: start,
    nulOffset: nul, payloadBytes: payload?.length, payloadSha256: payload === undefined ? undefined : sha(payload),
    empty: payload?.length === 0, nonEmptyStockDefaultsObserved: false,
    scope: 'Unmodified fixed stock executable read as bytes. Its native bounded/aligned ordinary option marker exists but text is empty; non-empty embedded precedence requires independently authored Web bytes and is not claimed as native binary evidence.' }
  writeFileSync(resolve(root, 'embedded-options.json'), JSON.stringify(record, null, 2))
  if (payload !== undefined) writeFileSync(resolve(root, 'embedded-options.bin'), payload)
  if (offset !== undefined && nul >= offset && nul < end)
    writeFileSync(resolve(root, 'embedded-options-marker.bin'), bytes.subarray(offset, nul + 1))
  assert.deepEqual(matches, [3494400]); assert.equal(record.sizeField, 4076)
  assert.equal(record.payloadOffset, 3494420); assert.equal(record.nulOffset, 3494420)
  assert.equal(record.empty, true)
} else if (process.argv[2] === 'prepare') {
  mkdirSync(root, { recursive: true })
  const manifest = []
  for (const item of cases) {
    const directory = resolve(root, 'cases', item.id, 'input'), files = []
    for (const [name, text] of Object.entries(item.configs)) {
      const bytes = Buffer.from(text, 'ascii'), path = resolve(directory, name)
      assert(bytes.toString('ascii') === text)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
      files.push({ name, bytes: bytes.length, sha256: sha(bytes) })
    }
    const bytes = utf16(script(item.id)), path = resolve(directory, 'game/startup.tjs')
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    files.push({ name: 'game/startup.tjs', bytes: bytes.length, sha256: sha(bytes) })
    const modes = utf16(startupScriptModesSource)
    writeFileSync(resolve(directory, 'game/modes.tjs'), modes)
    files.push({ name: 'game/modes.tjs', bytes: modes.length, sha256: sha(modes) })
    manifest.push({ id: item.id, args: item.args, expectedDataDirectory: item.directory,
      expectedArguments: item.expected, expectedModes: item.modes, expectedCacheLimit: item.cacheLimit, files })
  }
  writeFileSync(resolve(root, 'inputs.json'), JSON.stringify({ commit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID, cases: manifest,
    reference: 'Stock SysInitImpl.cpp 1443–1470,1529–1607,1634–1667; ConfMainFrameUnit.cpp1534–1574. Binary identity follows tests/fixtures/native-reference/sdk.json, not a claim of an exact matching source build.' }, null, 2))
} else if (process.argv[2] === 'compare') {
  const input = JSON.parse(readFileSync(resolve(root, 'inputs.json'), 'utf8'))
  assert.equal(input.commit, process.env.GITHUB_SHA); assert.equal(input.run, process.env.GITHUB_RUN_ID)
  const embeddedErrors: string[] = []
  let embeddedOptions: Record<string, unknown> | undefined
  try {
    embeddedOptions = JSON.parse(readFileSync(resolve(root, 'embedded-options.json'), 'utf8'))
    assert.equal(embeddedOptions!.commit, process.env.GITHUB_SHA); assert.equal(embeddedOptions!.run, process.env.GITHUB_RUN_ID)
    assert.equal(embeddedOptions!.engineSha256, 'b1e9b84905f29489d2a9caba0c45e125c971b19f71156b0cf3f506835c18e19d')
    assert.deepEqual(embeddedOptions!.markerOffsets, [3494400]); assert.equal(embeddedOptions!.sizeField, 4076)
    assert.equal(embeddedOptions!.payloadOffset, 3494420); assert.equal(embeddedOptions!.nulOffset, 3494420)
    assert.equal(embeddedOptions!.empty, true); assert.equal(readFileSync(resolve(root, 'embedded-options.bin')).length, 0)
  } catch (error) { embeddedErrors.push(String(error)) }
  const results = []
  for (const item of cases) {
    const directory = resolve(root, 'cases', item.id), errors: string[] = [], expectedProof =
      `config-proof:${item.id}|${item.expected.route ?? '<void>'}|${item.expected.datapath ?? '<void>'}`
    let processState: Record<string, unknown> | undefined, actual: string[] = [], normalized: string[] = [],
      observedAutoLimit: number | undefined,
      journalSha256: string | undefined, proofSha256: string | undefined
    const prefix = ['start', 'exe|<exe>/', `data|<exe>/${item.directory.toLowerCase()}/`,
      ...Object.entries(item.expected).map(([key, value]) => `argument|${key}|${value === null ? '<void>' : escape(value)}`),
    ], suffix = [`modes|${item.modes}`, `saved|${expectedProof}`, 'done']
    let expected = [...prefix, ...(item.cacheLimit === 'auto' ? ['<host automatic cache observations>'] : cacheRows(item.cacheLimit)), ...suffix]
    try {
      processState = JSON.parse(readFileSync(resolve(directory, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
      const bytes = readFileSync(resolve(directory, 'native-events.txt'))
      journalSha256 = sha(bytes); assert.equal(bytes.readUInt16LE(0), 0xfeff)
      actual = bytes.toString('utf16le').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
      const autoLines = actual.filter((line) => line.startsWith('cache|auto|'))
      assert.equal(autoLines.length, 1)
      assert.match(autoLines[0]!, /^cache\|auto\|\d+$/)
      observedAutoLimit = Number(autoLines[0]!.slice('cache|auto|'.length))
      if (item.cacheLimit === 'auto') {
        // SysInitImpl's memory tiers are independently constrained, while the
        // exact native host tier remains an observation rather than an oracle.
        assert([0, 4, 8, 12, 20, 40, 64].map((mb) => mb * 1048576).includes(observedAutoLimit))
        expected = [...prefix, ...cacheRows(observedAutoLimit), ...suffix]
      } else assert.equal(observedAutoLimit, item.cacheLimit)
      assert.equal(processState!.commit, process.env.GITHUB_SHA)
      assert.equal(processState!.state, 'observed'); assert.equal(processState!.timedOut, false)
      assert.equal(processState!.exitCode, 0)
      normalized = [...actual]
      assert(actual[1]?.startsWith('exe|')); assert(actual[2]?.startsWith('data|'))
      const exe = actual[1]!.slice(4).replaceAll('\\', '/').toLowerCase(),
        data = actual[2]!.slice(5).replaceAll('\\', '/').toLowerCase()
      assert(exe.endsWith('/') && data.startsWith(exe), 'Data directory must stay inside this owned executable directory')
      normalized[1] = 'exe|<exe>/'
      normalized[2] = 'data|<exe>/' + data.slice(exe.length)
      assert.deepEqual(normalized, expected)
      const proof = readFileSync(resolve(directory, 'config-proof.txt'))
      proofSha256 = sha(proof); assert(proof.equals(utf16(expectedProof + '\r\n')))
      assert.equal(processState!.proofRelativePath, item.directory + '/config-proof.txt')
      assert.deepEqual(processState!.otherProofFiles, [])
      const declaration = input.cases.find((entry: { id: string }) => entry.id === item.id)
      assert(declaration)
      for (const file of declaration.files) {
        const bytes = readFileSync(resolve(directory, 'input', file.name))
        assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256)
      }
    } catch (error) { errors.push(String(error)) }
    results.push({ id: item.id, matched: errors.length === 0, expected, actual, normalized, errors,
      configuredCacheLimit: item.cacheLimit, observedAutoLimit,
      cacheScope: item.cacheLimit === 'auto' ? 'Automatic host tier observed; legal native tiers and subsequent setter relations checked, not a fixed host-memory prediction.' : 'Exact authored MiB ceiling and script uint32/clamp observations.',
      journalSha256, proofSha256, processState })
  }
  const complete = embeddedErrors.length === 0 && results.length === cases.length && results.every((row) => row.matched)
  writeFileSync(resolve(root, 'comparison.json'), JSON.stringify({ commit: process.env.GITHUB_SHA,
    planned: cases.length, reported: results.filter((row) => row.actual.length > 0).length, complete, results, embeddedOptions, embeddedErrors,
    scope: 'Five isolated original Windows processes: empty embedded stock baseline plus four external configuration controls, real startup script operators/Layer masks, graphic cache limits and saved data files. The automatic cache host tier is observed; authored 0/1/2 MiB limits, initial disabled state, uint32 setters and clamps are checked exactly. Empty stock text is not evidence of non-empty embedded options. Missing/timeouts are failures; Web behavior is verified separately.' }, null, 2))
  assert(complete, 'Original external configuration precedence or data-directory observations differ')
} else throw new Error('Expected inspect-stock, prepare or compare')

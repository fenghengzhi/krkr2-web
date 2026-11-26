import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
].join('\r\n') + '\r\n'
const user = ['route=user', 'route=user-duplicate', 'flag=user-flag',
  'datapath=$(exepath)/Ignored', 'quoted="user value"', 'useronly=present'].join('\r\n') + '\r\n'
const cliUser = ['route=cli-directory-user', 'route=ignored-duplicate', 'flag=cli-directory-flag',
  'datapath=$(exepath)/IgnoredAgain', 'useronly=cli-directory'].join('\r\n') + '\r\n'
const trap = 'route=wrong-directory\r\nflag=wrong-directory\r\n'
const common: Record<string, string | null> = {
  flag: 'yes', route: 'default', datapath: '$(exepath)/Profiles', quoted: 'hello world', single: 'one two',
  escaped: 'line\nend', quote: 'A"B', empty: '', first: 'one', Case: 'upper', case: 'lower', useronly: null,
}
interface ConfigCase {
  id: string
  args: string[]
  directory: string
  configs: Record<string, string>
  expected: Record<string, string | null>
}
const cases: ConfigCase[] = [
  { id: 'defaults', args: [], directory: 'Profiles', configs: { 'krkr.cf': defaults }, expected: { ...common } },
  { id: 'user', args: [], directory: 'Profiles', configs: {
    'krkr.cf': defaults, 'Profiles/krkr.cfu': user, 'Ignored/krkr.cfu': trap,
  }, expected: { ...common, flag: 'user-flag', route: 'user', datapath: '$(exepath)/Ignored', quoted: 'user value', useronly: 'present' } },
  { id: 'command-line', args: ['-route=command', '-route=late-duplicate', '-flag=command-flag'], directory: 'Profiles', configs: {
    'krkr.cf': defaults, 'Profiles/krkr.cfu': user, 'Ignored/krkr.cfu': trap,
  }, expected: { ...common, flag: 'command-flag', route: 'command', datapath: '$(exepath)/Ignored', quoted: 'user value', useronly: 'present' } },
  { id: 'command-data-directory', args: ['-datapath=$(exepath)/CliProfiles'], directory: 'CliProfiles', configs: {
    'krkr.cf': defaults, 'Profiles/krkr.cfu': user, 'CliProfiles/krkr.cfu': cliUser, 'IgnoredAgain/krkr.cfu': trap,
  }, expected: { ...common, flag: 'cli-directory-flag', route: 'cli-directory-user', datapath: '$(exepath)/CliProfiles', useronly: 'cli-directory' } },
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
 var proof=${JSON.stringify('config-proof:' + id + '|')}+System.getArgument("-route")+"|"+System.getArgument("-datapath");
 [proof].save(System.dataPath+"config-proof.txt");
 record("saved|"+[].load(System.dataPath+"config-proof.txt")[0]);record("done");
}catch(e){record("fatal|"+e.message.escape());}
System.exit();
`
const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\r', '\\r')
  .replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('"', '\\"').replaceAll("'", "\\'")

if (process.argv[2] === 'prepare') {
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
    manifest.push({ id: item.id, args: item.args, expectedDataDirectory: item.directory,
      expectedArguments: item.expected, files })
  }
  writeFileSync(resolve(root, 'inputs.json'), JSON.stringify({ commit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID, cases: manifest,
    reference: 'Stock SysInitImpl.cpp 1443–1470,1529–1607,1634–1667; ConfMainFrameUnit.cpp1534–1574. Binary identity follows tests/fixtures/native-reference/sdk.json, not a claim of an exact matching source build.' }, null, 2))
} else if (process.argv[2] === 'compare') {
  const input = JSON.parse(readFileSync(resolve(root, 'inputs.json'), 'utf8'))
  assert.equal(input.commit, process.env.GITHUB_SHA); assert.equal(input.run, process.env.GITHUB_RUN_ID)
  const results = []
  for (const item of cases) {
    const directory = resolve(root, 'cases', item.id), errors: string[] = [], expectedProof =
      `config-proof:${item.id}|${item.expected.route}|${item.expected.datapath}`
    let processState: Record<string, unknown> | undefined, actual: string[] = [], normalized: string[] = [],
      journalSha256: string | undefined, proofSha256: string | undefined
    const expected = ['start', 'exe|<exe>/', `data|<exe>/${item.directory.toLowerCase()}/`,
      ...Object.entries(item.expected).map(([key, value]) => `argument|${key}|${value === null ? '<void>' : escape(value)}`),
      `saved|${expectedProof}`, 'done']
    try {
      processState = JSON.parse(readFileSync(resolve(directory, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, ''))
      const bytes = readFileSync(resolve(directory, 'native-events.txt'))
      journalSha256 = sha(bytes); assert.equal(bytes.readUInt16LE(0), 0xfeff)
      actual = bytes.toString('utf16le').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
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
      journalSha256, proofSha256, processState })
  }
  const complete = results.length === cases.length && results.every((row) => row.matched)
  writeFileSync(resolve(root, 'comparison.json'), JSON.stringify({ commit: process.env.GITHUB_SHA,
    planned: cases.length, reported: results.filter((row) => row.actual.length > 0).length, complete, results,
    scope: 'Four isolated original Windows processes read independently authored external .cf/.cfu files and public arguments, then write real data files. Missing/timeouts are failures; this does not prove the Web implementation or embedded executable options.' }, null, 2))
  assert(complete, 'Original external configuration precedence or data-directory observations differ')
} else throw new Error('Expected prepare or compare')

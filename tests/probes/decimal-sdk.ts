import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decimalBoundaryTokens, decimalCases, decimalPaths, decimalPoolExpected, decimalSource, doubleBits, savedRealBits } from '../helpers/decimal-reals.ts'

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const root = resolve('out/verification/native-eri/decimal'), game = resolve(root, 'game')
const sourceBytes = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const save = (name: string, value: unknown) => writeFileSync(resolve(root, name), JSON.stringify(value, null, 2) + '\n')
const decode = (bytes: Uint8Array) => new TextDecoder(bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-8').decode(bytes)
const script = sourceBytes(decimalSource)
const startup = sourceBytes(`
System.exitOnNoWindowStartup=false;
var rows=[];function record(value){rows.add(value);rows.save("native-events.txt");}
record("start");
try{
 Scripts.execStorage("numbers.tjs");
 var n=decimalObserve("");
 record("cases|"+n);record("pool|"+decimalPoolControl());
 record("boundary|"+decimalBoundaryObserve(""));record("done");
}catch(e){record("error|"+e.message);}
System.exit();
`)
const baseline = decimalCases.map((item) => 'stockBits' in item ? item.stockBits : doubleBits(item.value))
// The 2.32r2 process wrote these same values for literals, converted strings
// and reloaded saves in run 45755797755 (decimal/native.json).
const boundaryBits = ['7feffffffffffffb', '7feffffffffffffd', '7feffffffffffffd',
  '7feffffffffffffe', '7feffffffffffffe', '7fefffffffffffff', '7fefffffffffffff',
  'ffeffffffffffffe', '7feffffffffffffe', '7feffffffffffffe', '7fb9999999999999', '3ffcc359e067a348']
const savedPaths = [...decimalPaths, ...decimalPaths.map((name) => 'boundary-' + name)]

if (process.argv[2] === 'prepare') {
  assert.equal(process.env.RUNNER_OS, 'Windows')
  mkdirSync(game, { recursive: true })
  writeFileSync(resolve(game, 'numbers.tjs'), script)
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, sourceSha256: hash(script), startupSha256: hash(startup),
    cases: decimalCases.map((r, i) => ({ id: r.id, token: r.token, string: 'text' in r ? r.text : r.token,
      bits: baseline[i], nearestBinary64: doubleBits(r.value) })), boundaryTokens: decimalBoundaryTokens })
} else {
  const read = (name: string) => readFileSync(resolve(game, name))
  const manifest = JSON.parse(readFileSync(resolve(root, 'inputs.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.equal(manifest.sourceSha256, hash(read('numbers.tjs'))); assert.equal(manifest.sourceSha256, hash(script))
  assert.equal(manifest.startupSha256, hash(read('startup.tjs'))); assert.equal(manifest.startupSha256, hash(startup))
  if (process.argv[2] === 'native') {
    const processState = JSON.parse(decode(readFileSync(resolve(root, 'sdk-process.json'))))
    const lines = existsSync(resolve(game, 'native-events.txt')) ? decode(read('native-events.txt')).trimEnd().split(/\r?\n/) : []
    const results = savedPaths.map((name) => {
      try {
        const bytes = read(name + '.tjs'), bits = savedRealBits(decode(bytes))
        const expected = name.startsWith('boundary-') ? boundaryBits : baseline
        return { name, sha256: hash(bytes), bits, matched: bits.length === expected.length && bits.every((v, i) => v === expected[i]) }
      } catch (error) { return { name, matched: false, error: String(error) } }
    })
    const complete = processState.state === 'observed' && processState.commit === manifest.commit && processState.exitCode === 0 &&
      lines.join('\n') === ['start', 'cases|' + decimalCases.length, 'pool|' + decimalPoolExpected,
        'boundary|' + decimalBoundaryTokens.length, 'done'].join('\n') && results.every((r) => r.matched)
    save('native.json', { commit: manifest.commit, complete, results, lines, process: processState })
    assert(complete, 'Incomplete original decimal or structured save observations')
  } else if (process.argv[2] === 'web') {
    const { headless } = await import('../helpers/headless.ts')
    const native = JSON.parse(readFileSync(resolve(root, 'native.json'), 'utf8'))
    assert.equal(native.commit, manifest.commit)
    const reference = new Map<string, string[]>()
    for (const name of savedPaths) {
      const bytes = read(name + '.tjs'), bits = savedRealBits(decode(bytes))
      const record = native.results.find((r: {name: string}) => r.name === name)
      assert.equal(hash(bytes), record?.sha256); assert.deepEqual(bits, record.bits)
      reference.set(name, bits)
    }
    const results: { binary: boolean; name: string; bits?: string[]; observed?: string; matched?: boolean; error?: string;
      differences?: { token: string; stockBits: string; webBits?: string }[] }[] = []
    const outputs = [...savedPaths, 'from-sdk', 'boundary-from-sdk']
    for (const binary of [false, true]) {
      const { session } = await headless({
        'numbers.tjs': decimalSource, 'stock-save.tjs': read('literal.tjs'), 'stock-boundary.tjs': read('boundary-literal.tjs'),
        'startup.tjs': (binary ? 'Scripts.compileStorage("numbers.tjs",System.dataPath+"numbers.cjs",false,true,false);Scripts.execStorage(System.dataPath+"numbers.cjs");'
          : 'Scripts.execStorage("numbers.tjs");') +
          'decimalObserve(System.dataPath);decimalBoundaryObserve(System.dataPath);' +
          'Scripts.evalStorage("stock-save.tjs").saveStruct(System.dataPath+"from-sdk.tjs");' +
          'Scripts.evalStorage("stock-boundary.tjs").saveStruct(System.dataPath+"boundary-from-sdk.tjs");',
      })
      try {
        await session.start()
        const saves = new Map(session.exportSaves().map((file) => [file.path, file.bytes]))
        for (const name of outputs) {
          const bits = savedRealBits(decode(saves.get('savedata/' + name + '.tjs')!))
          const original = reference.get(name.replace('from-sdk', 'restored'))!
          const tokens = name.startsWith('boundary-') ? decimalBoundaryTokens : decimalCases.map((r) => r.token)
          const differences = original.flatMap((stockBits, i) => stockBits === bits[i] ? []
            : [{ token: tokens[i]!, stockBits, webBits: bits[i] }])
          results.push({ binary, name, bits, differences, matched: bits.length === original.length && !differences.length })
        }
        const observed = await session.evaluate('decimalPoolControl()')
        results.push({ binary, name: 'constant-pool', observed, matched: observed === decimalPoolExpected })
      } catch (error) { results.push({ binary, name: 'session', error: String(error) }) }
      finally { await session.stop() }
    }
    const complete = !!native.complete && results.length === 2 * (outputs.length + 1) && results.every((r) => r.matched)
    save('web.json', { commit: manifest.commit, complete, results })
    assert(complete, 'Original and Web decimal observations differ')
  } else throw new Error('Expected prepare, native or web')
}

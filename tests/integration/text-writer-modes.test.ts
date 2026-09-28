import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { headless } from '../helpers/headless.ts'
import { binaryValue } from '../helpers/binary-scripts.ts'
import { writeText } from '../../src/backends/files/text-codecs.ts'
import { MemorySaveStore, type SaveFile, type SaveStore } from '../../src/engine/ports/saves.ts'

const codePath = 'savedata/text-writer-modes.cjs'
const quote = JSON.stringify
const output = (files: SaveFile[], path: string) => {
  const file = files.find((entry) => entry.path === path)
  assert(file, `Missing saved file ${path}`)
  return Buffer.from(file.bytes)
}

async function fixture(
  binary: boolean,
  source: string,
  initial: SaveFile[] = [],
  resources: Record<string, string | Uint8Array> = {},
) {
  const memory = new MemorySaveStore()
  await memory.commit(initial)
  const commits: SaveFile[][] = []
  const encoded: { text: string; mode: string }[] = []
  const store: SaveStore = {
    load: () => memory.load(),
    async commit(files) {
      commits.push(files.map((file) => ({ path: file.path, bytes: file.bytes.slice() })))
      await memory.commit(files)
    },
    close() {},
  }
  const harness = await headless(
    { 'startup.tjs': '', 'text-writer-modes.tjs': source, ...resources },
    {
      saveStore: store,
      async writeText(text, mode = '') {
        encoded.push({ text, mode })
        return writeText(text, mode)
      },
    },
  )
  try {
    await harness.session.start()
    if (binary) {
      await harness.session.evaluate(
        `Scripts.compileStorage("text-writer-modes.tjs",${quote(codePath)},false,true,false)`,
      )
      await harness.session.evaluate(`Scripts.execStorage(${quote(codePath)})`)
    } else await harness.session.evaluate('Scripts.execStorage("text-writer-modes.tjs")')
    commits.length = 0
    encoded.length = 0
    return {
      ...harness,
      memory,
      commits,
      encoded,
      files: () => harness.session.exportSaves().filter((file) => file.path !== codePath),
    }
  } catch (error) {
    await harness.session.stop()
    throw error
  }
}

const entryPoints = [
  { name: 'Array.save', define: 'var value=["new"];', invoke: 'value.save' },
  { name: 'Array.saveStruct', define: 'var value=["new"];', invoke: 'value.saveStruct' },
  {
    name: 'Dictionary.saveStruct',
    define: 'var value=%[text:"new"];',
    invoke: '(Dictionary.saveStruct incontextof value)',
  },
] as const

// These expected offsets are fixed source-contract examples, not values obtained
// by calling the production parser. Every file and actual write stays small.
const offsets = [
  { mode: 'o0', offset: 0 },
  { mode: 'o', offset: 0 },
  { mode: 'oo6', offset: 0 },
  { mode: 'o-6', offset: 0 },
  { mode: 'o+6', offset: 0 },
  { mode: 'o10o2', offset: 10 },
  { mode: 'o010', offset: 8 },
  { mode: 'o018', offset: 1 },
  { mode: 'o08', offset: 0 },
  { mode: 'o0x10', offset: 0 },
] as const

for (const binary of [false, true]) {
  const execution = binary ? 'bytecode' : 'source'

  for (const entry of entryPoints)
    test(`${execution}: ${entry.name} rejects text modes at the save call without enqueuing writes`, async () => {
      const old = Buffer.from('previous file bytes must survive')
      const cases = [
        { path: 'savedata/old.txt', mode: 'c0' },
        { path: 'savedata/missing.txt', mode: 'c3' },
        { path: 'savedata/missing.txt', mode: 'c9' },
        { path: 'savedata/missing.txt', mode: 'c01' },
        { path: '../escape.txt', mode: 'c9' },
        { path: '../escape.txt', mode: 'c9o67108865' },
      ]
      const source = `
${entry.define}
var caught=[],pureSentinel=0;
function exercise(){
${cases
  .map(
    ({ path, mode }, index) => `
  var atCall${index}=false;
  try { ${entry.invoke}(${quote(path)},${quote(mode)}); }
  catch(error) { atCall${index}=true;caught.add(error.message); }
  // No host call is inside the try or between its catch and this sentinel.
  if(!atCall${index})throw "save did not throw at its own call";
  pureSentinel=pureSentinel*2+1;
`,
  )
  .join('')}
  ["after"].save("savedata/after.txt","utf-8");
  return pureSentinel;
}`
      const f = await fixture(binary, source, [{ path: 'savedata/old.txt', bytes: old }])
      try {
        assert.equal(await f.session.evaluate('exercise()'), '63')
        assert.equal(await f.session.evaluate('caught.count'), '6')
        for (let index = 0; index < cases.length; index++)
          assert.match(
            await f.session.evaluate(`caught[${index}]`),
            /Unsupported text writer encoding/,
          )
        // The invalid path and invalid offset cannot replace the cipher error.
        assert.equal(
          await f.session.evaluate('caught[2]===caught[4] && caught[4]===caught[5]'),
          '1',
        )
        assert.deepEqual(f.encoded, [{ text: 'after\r\n', mode: 'utf-8' }])
        assert.deepEqual(
          f.commits.flat().map((file) => file.path),
          ['savedata/after.txt'],
        )
        assert.deepEqual(
          f
            .files()
            .map((file) => file.path)
            .sort(),
          ['savedata/after.txt', 'savedata/old.txt'],
        )
        assert.deepEqual(output(f.files(), 'savedata/old.txt'), old)
        assert.deepEqual(output(await f.memory.load(), 'savedata/old.txt'), old)
        assert.deepEqual(output(f.files(), 'savedata/after.txt'), Buffer.from('after\r\n'))
        assert.equal(f.session.snapshot().pendingSaves, 0)
        assert.equal(await f.session.evaluate('6*7'), '42')
      } finally {
        await f.session.stop()
      }
    })

  test(`${execution}: text and binary explicit offsets preserve both sides while ordinary WRITE replaces`, async () => {
    const original = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!?')
    const text = Buffer.from([0xff, 0xfe, 0x51, 0, 0x0d, 0, 0x0a, 0])
    const structured = Buffer.from(binaryValue(['Q']))
    const initial: SaveFile[] = []
    const commands: string[] = []
    for (const [index, { mode }] of offsets.entries()) {
      initial.push(
        { path: `savedata/text-${index}`, bytes: original },
        { path: `savedata/binary-${index}`, bytes: original },
      )
      commands.push(
        `["Q"].save("savedata/text-${index}",${quote(mode)});`,
        `["Q"].saveStruct("savedata/binary-${index}",${quote('b' + mode)});`,
      )
    }
    initial.push(
      { path: 'savedata/text-write', bytes: original },
      { path: 'savedata/binary-write', bytes: original },
    )
    const f = await fixture(
      binary,
      `function exercise(){${commands.join('\n')}
["Q"].save("savedata/text-write");
["Q"].saveStruct("savedata/binary-write","b");return 1;}`,
      initial,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '1')
      for (const [index, { offset }] of offsets.entries()) {
        const expectedText = Buffer.from(original)
        const expectedBinary = Buffer.from(original)
        text.copy(expectedText, offset)
        structured.copy(expectedBinary, offset)
        assert.deepEqual(output(f.files(), `savedata/text-${index}`), expectedText)
        assert.deepEqual(output(f.files(), `savedata/binary-${index}`), expectedBinary)
      }
      assert.deepEqual(output(f.files(), 'savedata/text-write'), text)
      assert.deepEqual(output(f.files(), 'savedata/binary-write'), structured)
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: native text, binary and script readers share first-o and small octal offsets`, async () => {
    const resources: Record<string, Uint8Array> = {}
    const commands: string[] = []
    for (const [index, { mode, offset }] of offsets.entries()) {
      const prefix = Buffer.alloc(offset, 0x7e)
      resources[`text-${index}.txt`] = Buffer.concat([prefix, Buffer.from('line\r\n')])
      resources[`script-${index}.tjs`] = Buffer.concat([prefix, Buffer.from('40+2')])
      resources[`binary-${index}.bin`] = Buffer.concat([
        prefix,
        binaryValue(new Map([['answer', 42n]])),
      ])
      commands.push(`
if([].load("text-${index}.txt",${quote(mode)})[0]!="line")throw "text offset ${index}";
if(Scripts.evalStorage("script-${index}.tjs",${quote(mode)})!=42)throw "script offset ${index}";
if(Dictionary.loadStruct("binary-${index}.bin",${quote(mode)}).answer!=42)throw "binary offset ${index}";
if(Scripts.evalStorage("binary-${index}.bin",${quote(mode)}).answer!=42)throw "binary script offset ${index}";
reads+=4;`)
    }
    const f = await fixture(
      binary,
      `var reads=0;function exercise(){${commands.join('\n')}return reads;}`,
      [],
      resources,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), String(offsets.length * 4))
      assert.deepEqual(f.files(), [])
      assert.deepEqual(f.commits, [])
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: append chooses EOF after validating text and binary offsets`, async () => {
    const original = Buffer.from('old-prefix')
    const f = await fixture(
      binary,
      `var caught=[],pureSentinel=0;
function exercise(){
  try{["bad"].save("savedata/text","utf-8c0ao67108865");}
  catch(error){caught.add(error.message);pureSentinel++;}
  if(pureSentinel!=1)throw "text append skipped offset validation";
  try{["bad"].saveStruct("savedata/binary","bc9ao67108865");}
  catch(error){caught.add(error.message);pureSentinel++;}
  if(pureSentinel!=2)throw "binary append skipped offset validation";
  ["Q"].save("savedata/text","utf-8ao010");
  ["Q"].saveStruct("savedata/binary","bao010");
  return pureSentinel;
}`,
      [
        { path: 'savedata/text', bytes: original },
        { path: 'savedata/binary', bytes: original },
      ],
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '2')
      assert.match(await f.session.evaluate('caught[0]'), /Invalid text stream offset/)
      assert.match(await f.session.evaluate('caught[1]'), /Invalid text stream offset/)
      assert.deepEqual(
        output(f.files(), 'savedata/text'),
        Buffer.concat([original, Buffer.from('Q\r\n')]),
      )
      assert.deepEqual(
        output(f.files(), 'savedata/binary'),
        Buffer.concat([original, binaryValue(['Q'])]),
      )
      assert.deepEqual(f.encoded, [{ text: 'Q\r\n', mode: 'utf-8ao010' }])
      assert.deepEqual(
        f.commits
          .flat()
          .map((file) => file.path)
          .sort(),
        ['savedata/binary', 'savedata/text'],
      )
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: binary saveStruct ignores text c/z classification while Array.save stays text`, async () => {
    const modes = ['b', 'bc0', 'bc9', 'bc2', 'bz', 'bzc0']
    const commands = modes
      .map(
        (mode, index) => `
["Q"].saveStruct("savedata/array-${index}",${quote(mode)});
(Dictionary.saveStruct incontextof dict)("savedata/dict-${index}",${quote(mode)});`,
      )
      .join('\n')
    const f = await fixture(
      binary,
      `var dict=%[answer:42],caught=0,caughtMessage="";
function exercise(){
${commands}
  try{["bad"].save("savedata/absent","bc0");}catch(error){caught++;caughtMessage=error.message;}
  if(caught!=1)throw "Array.save b was mistaken for a binary stream";
  ["Q"].save("savedata/text-b","b");return caught;
}`,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '1')
      assert.match(await f.session.evaluate('caughtMessage'), /Unsupported text writer encoding 0/)
      for (const [index] of modes.entries()) {
        assert.deepEqual(
          output(f.files(), `savedata/array-${index}`),
          Buffer.from(binaryValue(['Q'])),
        )
        assert.deepEqual(
          output(f.files(), `savedata/dict-${index}`),
          Buffer.from(binaryValue(new Map([['answer', 42n]]))),
        )
      }
      assert.deepEqual(output(f.files(), 'savedata/text-b'), Buffer.from('fffe51000d000a00', 'hex'))
      assert(!f.files().some((file) => file.path === 'savedata/absent'))
      assert.deepEqual(f.encoded, [{ text: 'Q\r\n', mode: 'b' }])
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: Web UTF-8 encoding retains priority over text c/z modes`, async () => {
    const modes = ['utf-8c0', 'utf8c9', 'utf-8z', 'UTF8c2']
    const f = await fixture(
      binary,
      `function exercise(){${modes
        .map((mode, index) => `["雪😀"].save("savedata/utf8-${index}",${quote(mode)});`)
        .join('\n')}return 1;}`,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '1')
      for (const [index] of modes.entries())
        assert.deepEqual(output(f.files(), `savedata/utf8-${index}`), Buffer.from('雪😀\r\n'))
      assert.deepEqual(
        f.encoded.map((entry) => entry.mode),
        modes,
      )
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: c2 and z saves have independently inflated envelopes and remain executable scripts`, async () => {
    const modes = ['c2', 'c20', 'c0z', 'zc0', 'c9z1', 'z', 'z0', 'z9', 'z10', 'z-1']
    const f = await fixture(
      binary,
      `var readBack=0;function exercise(){${modes
        .map(
          (mode, index) => `
["6*7"].save("savedata/compressed-${index}",${quote(mode)});
if([].load("savedata/compressed-${index}")[0]!="6*7")throw "compressed array load";
readBack+=Scripts.evalStorage("savedata/compressed-${index}");`,
        )
        .join('\n')}return readBack;}`,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), String(42 * modes.length))
      for (const [index] of modes.entries()) {
        const saved = output(f.files(), `savedata/compressed-${index}`)
        assert.deepEqual(saved.subarray(0, 5), Buffer.from([0xfe, 0xfe, 2, 0xff, 0xfe]))
        assert.equal(saved.readBigUInt64LE(5), BigInt(saved.length - 21))
        const expected = Buffer.from('6*7\r\n', 'utf16le')
        assert.equal(saved.readBigUInt64LE(13), BigInt(expected.length))
        // node:zlib is independent of the production CompressionStream/readText path.
        assert.deepEqual(inflateSync(saved.subarray(21)), expected)
      }
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: text c modes read one digit while uppercase C/Z stay ordinary UTF-16`, async () => {
    const simple = ['c', 'c1', 'c10', 'c-1']
    const ordinary = ['C0', 'Z']
    const modes = [...simple, ...ordinary]
    const f = await fixture(
      binary,
      `function exercise(){${modes
        .map((mode, index) => `["Q"].save("savedata/classified-${index}",${quote(mode)});`)
        .join('\n')}return 1;}`,
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '1')
      for (const [index] of modes.entries()) {
        // Fixed bytes for Q CR LF: c1 swaps adjacent bits in each UTF-16 unit.
        const hex = index < simple.length ? 'fefe01fffea2000e000500' : 'fffe51000d000a00'
        assert.deepEqual(output(f.files(), `savedata/classified-${index}`), Buffer.from(hex, 'hex'))
      }
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: fixed legacy c0 input remains readable without invoking a c0 writer`, async () => {
    const f = await fixture(
      binary,
      `function exercise(){
  if([].load("legacy-c0.tjs")[0]!="6*7")throw "legacy c0 text";
  return Scripts.evalStorage("legacy-c0.tjs");
}`,
      [],
      // Fixed FE FE 0 FF FE envelope for 6*7, never emitted by production writeText.
      { 'legacy-c0.tjs': Buffer.from('fefe00fffe37362b2a3636', 'hex') },
    )
    try {
      assert.equal(await f.session.evaluate('exercise()'), '42')
      assert.deepEqual(f.encoded, [])
      assert.deepEqual(f.commits, [])
      assert.deepEqual(f.files(), [])
    } finally {
      await f.session.stop()
    }
  })
}

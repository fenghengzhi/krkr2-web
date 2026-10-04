import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { binaryValue } from '../helpers/binary-scripts.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'

const quote = JSON.stringify
const codePath = 'savedata/write-targets.cjs'
const original = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
const filesWithoutCode = (files: SaveFile[]) => files.filter(({ path }) => path !== codePath)
function bytes(files: SaveFile[], path: string) {
  const file = files.find((file) => file.path === path)
  assert(file, `Missing ${path}`)
  return Buffer.from(file.bytes)
}
function overwritten(value: Uint8Array, offset = 0) {
  const expected = Buffer.from(original)
  expected.set(value, offset)
  return expected
}
async function fixture(binary: boolean, initial: SaveFile[], resources: Record<string, Uint8Array> = {}) {
  const store = new MemorySaveStore()
  await store.commit(initial)
  const mounted = { 'startup.tjs': '', ...resources }
  const f = await headless(mounted, { saveStore: store })
  return {
    ...f,
    store,
    files: () => filesWithoutCode(f.session.exportSaves()),
    async run(source: string) {
      const program = Buffer.from(source)
      f.session.mount([{ name: 'write-targets.tjs', size: program.length, read: async () => program }])
      await f.session.start()
      if (!binary) return f.session.evaluate('Scripts.execStorage("write-targets.tjs")')
      // Compile the same program through the production storage path, then
      // execute the emitted bytecode in this Session.
      await f.session.evaluate(
        `Scripts.compileStorage("write-targets.tjs",${quote(codePath)},false,true,false)`,
      )
      return f.session.evaluate(`Scripts.execStorage(${quote(codePath)})`)
    },
    async reload() {
      await f.session.stop()
      const next = await headless(mounted, { saveStore: store })
      await next.session.start()
      return next.session
    },
  }
}

for (const binary of [false, true]) {
  const execution = binary ? 'bytecode' : 'source'
  test(`${execution}: missing UPDATE fails at stream construction and does not create shadow saves`, async () => {
    const f = await fixture(binary, [])
    try {
      await f.run(`var caught=0;
function attempt(path,mode,isBinary){
  var returned=false,failed=false;
  try{if(isBinary)["Q"].saveStruct(path,mode);else ["Q"].save(path,mode);returned=true;}
  catch(e){failed=e.message.indexOf("Update target not found:")>=0;}
  if(returned || !failed)throw "UPDATE was not rejected at its save call";
  caught++;
}
attempt("missing-zero","o0",false);attempt("missing-empty","o",false);
attempt("missing-binary","bo0",true);attempt("missing-append-offset","utf-8ao0",false);
["after"].save("savedata/After.txt","utf-8");`)
      assert.equal(await f.session.evaluate('caught'), '4')
      assert.deepEqual(f.files().map(({ path }) => path), ['savedata/After.txt'])
      assert.deepEqual(bytes(f.files(), 'savedata/After.txt'), Buffer.from('after\r\n'))
      assert.equal(f.session.snapshot().pendingSaves, 0)
    } finally {
      await f.session.stop()
    }
  })

  for (const mounted of [false, true])
    test(`${execution}: UPDATE binds ${mounted ? 'mounted' : 'saved'} auto-path and case spelling through persistence`, async () => {
      const paths = ['Data/Text.dat', 'Data/Binary.dat'],
        f = await fixture(
          binary,
          mounted ? [] : paths.map((path) => ({ path, bytes: original })),
          mounted ? Object.fromEntries(paths.map((path) => [path, original])) : {},
        )
      try {
        await f.run(`Storages.addAutoPath("Data/");
["Q"].save("text.DAT","utf-8o010");
["Q"].saveStruct("game://./BINARY.dat","bo0");`)
        assert.deepEqual(f.files().map(({ path }) => path).sort(), paths.slice().sort())
        assert.deepEqual(bytes(f.files(), paths[0]!), overwritten(Buffer.from('Q\r\n'), 8))
        assert.deepEqual(bytes(f.files(), paths[1]!), overwritten(binaryValue(['Q'])))
        assert.equal(await f.session.evaluate('Storages.getPlacedPath("text.dat")'), 'game://./Data/Text.dat')
        const reloaded = await f.reload()
        try {
          assert.deepEqual(filesWithoutCode(reloaded.exportSaves()).map(({ path }) => path).sort(), paths.slice().sort())
          assert.equal(await reloaded.evaluate('[].load("game://./data/TEXT.DAT","o010")[0]'), 'Q')
          assert.equal(await reloaded.evaluate('Dictionary.loadStruct("data/binary.DAT")[0]'), 'Q')
        } finally {
          await reloaded.stop()
        }
      } finally {
        await f.session.stop()
      }
    })

  test(`${execution}: WRITE ignores auto paths and preserves direct existing case for saves and mounted files`, async () => {
    const f = await fixture(binary, [{ path: 'Saved.dat', bytes: original }], {
      'Mounted.dat': original,
      'Data/New.dat': original,
    })
    try {
      await f.run(`Storages.addAutoPath("Data/");
["S"].save("sAVED.DAT","utf-8");["M"].save("mounted.DAT","utf-8");
["N"].save("new.dat","utf-8");`)
      assert.deepEqual(f.files().map(({ path }) => path).sort(), ['Mounted.dat', 'Saved.dat', 'new.dat'])
      assert.deepEqual(bytes(f.files(), 'Saved.dat'), Buffer.from('S\r\n'))
      assert.deepEqual(bytes(f.files(), 'Mounted.dat'), Buffer.from('M\r\n'))
      assert.deepEqual(bytes(f.files(), 'new.dat'), Buffer.from('N\r\n'))
      assert.equal(await f.session.evaluate('Storages.getPlacedPath("new.dat")'), 'game://./new.dat')
      assert.equal(await f.session.evaluate('[].load("Data/New.dat")[0]'), original.toString())
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: UPDATE respects direct-before-auto and latest auto path while rejecting archive members`, async () => {
    const f = await fixture(binary, [
      { path: 'Direct.dat', bytes: original },
      { path: 'First/Target.dat', bytes: original },
      { path: 'Last/Target.dat', bytes: original },
      { path: 'Last/Direct.dat', bytes: original },
    ], { 'pack.xp3>Member.dat': original })
    try {
      await f.run(`Storages.addAutoPath("First/");Storages.addAutoPath("Last/");
["D"].save("direct.DAT","utf-8o0");["L"].save("target.DAT","utf-8o0");
Storages.addAutoPath("pack.xp3>");var blocked=0;
try{["bad"].save("member.dat","o0");}catch(e){if(e.message.indexOf("Archive storage is read-only")>=0)blocked++;}
if(blocked!=1)throw "archive UPDATE must fail before queueing";`)
      assert.equal(await f.session.evaluate('blocked'), '1')
      assert.deepEqual(f.files().map(({ path }) => path).sort(), ['Direct.dat', 'First/Target.dat', 'Last/Direct.dat', 'Last/Target.dat'])
      assert.deepEqual(bytes(f.files(), 'Direct.dat'), overwritten(Buffer.from('D\r\n')))
      assert.deepEqual(bytes(f.files(), 'Last/Target.dat'), overwritten(Buffer.from('L\r\n')))
      assert.deepEqual(bytes(f.files(), 'First/Target.dat'), original)
      assert.deepEqual(bytes(f.files(), 'Last/Direct.dat'), original)
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: ambiguous case lookup rejects UPDATE and append-only creates or binds an existing path`, async () => {
    const f = await fixture(binary, [
      { path: 'Clash.dat', bytes: original }, { path: 'clash.dat', bytes: original },
      { path: 'Data/Append.dat', bytes: original },
    ])
    try {
      await f.run(`var blocked=0;
try{["bad"].save("CLASH.DAT","o0");}catch(e){if(e.message.indexOf("Ambiguous save path")>=0)blocked++;}
if(blocked!=1)throw "ambiguous UPDATE must fail before queueing";
Storages.addAutoPath("Data/");["A"].save("append.DAT","utf-8a");
["N"].save("created.dat","utf-8a");`)
      assert.equal(await f.session.evaluate('blocked'), '1')
      assert.deepEqual(f.files().map(({ path }) => path).sort(), ['Clash.dat', 'Data/Append.dat', 'clash.dat', 'created.dat'])
      assert.deepEqual(bytes(f.files(), 'Clash.dat'), original)
      assert.deepEqual(bytes(f.files(), 'clash.dat'), original)
      assert.deepEqual(bytes(f.files(), 'Data/Append.dat'), Buffer.concat([original, Buffer.from('A\r\n')]))
      assert.deepEqual(bytes(f.files(), 'created.dat'), Buffer.from('N\r\n'))
    } finally {
      await f.session.stop()
    }
  })

  test(`${execution}: exact case collisions remain separate and binary WRITE binds an unambiguous direct name`, async () => {
    const f = await fixture(binary, [
      { path: 'Clash.dat', bytes: original }, { path: 'clash.dat', bytes: original },
      { path: 'Binary.dat', bytes: original },
    ])
    try {
      await f.run(`var blocked=0;
try{["bad"].save("CLASH.DAT","utf-8");}catch(e){if(e.message.indexOf("Ambiguous save path")>=0)blocked++;}
if(blocked!=1)throw "ambiguous WRITE must fail before queueing";
["U"].save("Clash.dat","utf-8o0");["L"].save("clash.dat","utf-8o0");
["B"].saveStruct("BINARY.DAT","b");`)
      assert.deepEqual(f.files().map(({ path }) => path).sort(), ['Binary.dat', 'Clash.dat', 'clash.dat'])
      assert.deepEqual(bytes(f.files(), 'Clash.dat'), overwritten(Buffer.from('U\r\n')))
      assert.deepEqual(bytes(f.files(), 'clash.dat'), overwritten(Buffer.from('L\r\n')))
      assert.deepEqual(bytes(f.files(), 'Binary.dat'), Buffer.from(binaryValue(['B'])))
    } finally {
      await f.session.stop()
    }
  })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { writeText } from '../../src/backends/files/text-codecs.ts'
import { encodeTextStream, type TextCodecs } from '../../src/formats/text/stream.ts'
import { CompressionError } from '../../src/formats/binary/compression-error.ts'

function compressed(text: string, delta = 0): Uint8Array {
  const data = Buffer.from(text, 'utf16le'), packed = deflateSync(data), output = new Uint8Array(21 + packed.length),
    view = new DataView(output.buffer)
  output.set([0xfe, 0xfe, 2, 0xff, 0xfe])
  view.setBigUint64(5, BigInt(packed.length), true); view.setBigUint64(13, BigInt(data.length + delta), true)
  output.set(packed, 21)
  return output
}
function simple(text: string): Uint8Array {
  const output = new Uint8Array(5 + text.length * 2), view = new DataView(output.buffer)
  output.set([0xfe, 0xfe, 1, 0xff, 0xfe])
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    view.setUint16(5 + index * 2, ((unit & 0xaaaa) >>> 1) | ((unit & 0x5555) << 1), true)
  }
  return output
}
const source = String.raw`
var loaded=["preserved"],decodedCount=0,queuedMessage="";
function readFailure(which,name,mode=""){
  global.loaded=["preserved"];
  try{
    if(which==0)global.loaded.load(name,mode);
    else if(which==1)Scripts.execStorage(name,mode);
    else if(which==2)Scripts.evalStorage(name,mode);
    else Scripts.compileStorage(name,"savedata/invalid-output.cjs",false,true,false);
  }catch(error){return error.message;}
  return "NO_ERROR";
}
function rejectWriter(which,path,mode){
  try{
    if(which==0)["replacement"].save(path,mode);
    else if(which==1)["replacement"].saveStruct(path,mode);
    else{var value=%[text:"replacement"];(Dictionary.saveStruct incontextof value)(path,mode);}
  }catch(error){return error.message;}
  return "NO_ERROR";
}
function queueCompression(){
  ["persist after retry"].save("savedata/queued.txt","z");
  // assignMessage is native, so this changes the holder without flushing the
  // writer first. The next genuine storage call performs its queued write.
  System.assignMessage("TVPCompressionFailed","late-compression:%%:%1");
  try{Storages.isExistentStorage("savedata/queued.txt");}catch(error){global.queuedMessage=error.message;}
  return global.queuedMessage;
}
`
async function using(
  binary: boolean,
  resources: Record<string, string | Uint8Array>,
  overrides: Partial<SessionDependencies>,
  run: (f: Awaited<ReturnType<typeof headless>>) => Promise<void>,
) {
  const f = await headless({ 'stream-errors.tjs': source, 'startup.tjs': binary
    ? 'Scripts.compileStorage("stream-errors.tjs","savedata/stream-errors.cjs",false,true,false);Scripts.execStorage("savedata/stream-errors.cjs");'
    : 'Scripts.execStorage("stream-errors.tjs");', ...resources }, overrides), failures: unknown[] = []
  try {
    await f.session.start(); await f.session.idle()
    if (binary) {
      const compiled = f.session.exportSaves().find((file) => file.path === 'savedata/stream-errors.cjs')
      assert(compiled); assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
    }
    await run(f)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().state, 'stopped')
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Text stream scenario or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: actual encrypted and compressed file failures use the caller name and current cipher holder before modifying Arrays or compilation output`, { timeout: 60000 }, async () => {
    const checksum = compressed('global.decodedCount++;')
    checksum[checksum.length - 1]! ^= 1
    const resources = {
      'assets/unknown.txt': Uint8Array.from([0xfe, 0xfe, 9, 0xff, 0xfe]),
      'assets/bom.txt': Uint8Array.from([0xfe, 0xfe, 1, 0, 0]),
      'assets/checksum.txt': checksum,
      'assets/short-output.txt': compressed('global.decodedCount++;', -2),
      'assets/long-output.txt': compressed('global.decodedCount++;', 2),
    }
    await using(binary, resources, {}, async (f) => {
      await f.session.evaluate('Storages.addAutoPath("assets/")')
      assert.equal(await f.session.evaluate('readFailure(0,"unknown.txt")'), 'unknown.txt は未対応の暗号化形式か、データが破損しています')
      assert.equal(await f.session.evaluate('loaded.join("|")'), 'preserved')
      assert.equal(await f.session.evaluate('System.assignMessage("TVPUnsupportedCipherMode","cipher[%1]|%1|%%|%2")'), '1')
      for (const path of Object.keys(resources)) {
        const requested = path.slice('assets/'.length)
        for (let operation = 0; operation < 4; operation++) {
          // Native ScriptMgnIntf locates a script before constructing its text
          // reader. Array.load and the compileStorage extension pass the
          // original requested name directly to that reader instead.
          const streamName = operation === 1 || operation === 2 ? `game://./assets/${requested}` : requested
          assert.equal(await f.session.evaluate(`readFailure(${operation},${JSON.stringify(requested)})`), `cipher[${streamName}]|${streamName}|%|%2`)
          assert.equal(await f.session.evaluate('loaded.join("|")+","+decodedCount'), 'preserved,0')
        }
      }
      assert.equal(await f.session.evaluate('Storages.isExistentStorage("savedata/invalid-output.cjs")'), '0')
      assert.equal(f.session.snapshot().pendingSaves, 0)
      assert.equal(f.session.snapshot().state, 'running')
    })
  })

  test(`${mode}: native text writers reject cipher modes at construction, before target validation or queueing`, { timeout: 60000 }, async () => {
    const calls: string[] = [], old = Uint8Array.from([0xff, 0xfe, 0x41, 0])
    await using(binary, { 'keep.txt': old }, { async writeText(text, mode = '') { calls.push(mode); return writeText(text, mode) } }, async (f) => {
      assert.equal(await f.session.evaluate('rejectWriter(0,"keep.txt","c0")'), '認識できないモード文字列の指定です(unsupported cipher mode)')
      assert.equal(await f.session.evaluate('System.assignMessage("TVPUnsupportedModeString","mode:%1:%%:%2")'), '1')
      for (let operation = 0; operation < 3; operation++) for (const [path, writerMode] of [
        ['keep.txt', 'c0'], ['absent.txt', 'c9'], ['../invalid.txt', 'c3o67108865'],
      ] as const)
        assert.equal(await f.session.evaluate(`rejectWriter(${operation},${JSON.stringify(path)},${JSON.stringify(writerMode)})`), 'mode:unsupported cipher mode:%:%2')
      assert.deepEqual(calls, [], 'No encoder or destructor write exists after failed preflight')
      assert.equal(await f.session.evaluate('[].load("keep.txt")[0]'), 'A')
      assert.equal(await f.session.evaluate('Storages.isExistentStorage("absent.txt")'), '0')
      assert.equal(f.session.exportSaves().some((file) => file.path === 'keep.txt' || file.path === 'absent.txt'), false)
      assert.equal(f.session.snapshot().pendingSaves, 0)
    })
  })

  test(`${mode}: independent c0/c1/zlib bytes remain readable as Arrays and Scripts and actual compressed writes decode independently`, { timeout: 60000 }, async () => {
    const statement = 'global.decodedCount++;', expression = '40+2', lines = 'A日\r\nsecond\r\n'
    await using(binary, {
      'legacy-c0.txt': Uint8Array.from([0xfe, 0xfe, 0, 0xff, 0xfe, 0x40, 0x40, 0xe4, 0x81, 0x0d, 0, 0x0a, 0]),
      'simple-lines.txt': simple(lines), 'compressed-lines.txt': compressed(lines),
      'simple-script.tjs': simple(statement), 'compressed-script.tjs': compressed(statement),
      'expression.tjs': compressed(expression),
    }, {}, async (f) => {
      assert.equal(await f.session.evaluate('[].load("legacy-c0.txt")[0]'), 'A日')
      for (const path of ['simple-lines.txt', 'compressed-lines.txt'])
        assert.equal(await f.session.evaluate(`[].load(${JSON.stringify(path)}).join("|")`), 'A日|second')
      for (const path of ['simple-script.tjs', 'compressed-script.tjs']) await f.session.evaluate(`Scripts.execStorage(${JSON.stringify(path)})`)
      assert.equal(await f.session.evaluate('decodedCount'), '2')
      assert.equal(await f.session.evaluate('Scripts.evalStorage("expression.tjs")'), '42')
      await f.session.evaluate('Scripts.compileStorage("compressed-script.tjs","savedata/decoded.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/decoded.cjs")')
      assert.equal(await f.session.evaluate('decodedCount'), '3')
      await f.session.evaluate('["A日","second"].save("savedata/actual-z.txt","z")')
      const saved = f.session.exportSaves().find((file) => file.path === 'savedata/actual-z.txt')
      assert(saved)
      const view = new DataView(saved.bytes.buffer, saved.bytes.byteOffset, saved.bytes.byteLength)
      assert.deepEqual(saved.bytes.subarray(0, 5), Uint8Array.from([0xfe, 0xfe, 2, 0xff, 0xfe]))
      assert.equal(view.getBigUint64(5, true), BigInt(saved.bytes.length - 21))
      assert.equal(view.getBigUint64(13, true), BigInt(Buffer.byteLength(lines, 'utf16le')))
      assert.deepEqual(inflateSync(saved.bytes.subarray(21)), Buffer.from(lines, 'utf16le'))
    })
  })

  test(`${mode}: a codec failure during a real queued writer reads the latest holder and retries the identical payload without publishing a failed save`, { timeout: 60000 }, async () => {
    const attempts: { text: string; mode: string }[] = []
    // Deflate cannot be made to fail naturally on a tiny valid input. Inject
    // its explicit processing failure at the codec dependency, while using
    // the actual Array writer, format encoder, queue, Session and next-host
    // flush. No test host constructs a TVP descriptor or throws into TJS.
    const failingCodec: TextCodecs = {
      narrow: () => { throw new Error('Unexpected narrow read') },
      utf8: () => { throw new Error('Unexpected UTF-8 write') },
      inflate: async () => { throw new Error('Unexpected inflate') },
      deflate: async () => { throw new CompressionError('deflate', 'controlled compression processing failure') },
    }
    let readFailedSave: (() => boolean) | undefined, exposedFailedSave = false
    await using(binary, {}, { async writeText(text, mode = '') {
      attempts.push({ text, mode })
      if (attempts.length === 1) {
        exposedFailedSave = readFailedSave?.() ?? true
        return encodeTextStream(text, failingCodec, mode)
      }
      return writeText(text, mode)
    } }, async (f) => {
      readFailedSave = () => f.session.exportSaves().some((file) => file.path === 'savedata/queued.txt')
      assert.equal(await f.session.evaluate('queueCompression()'), 'late-compression:%%:%1')
      assert.equal(exposedFailedSave, false)
      assert.deepEqual(attempts, [
        { text: 'persist after retry\r\n', mode: 'z' },
        { text: 'persist after retry\r\n', mode: 'z' },
      ])
      const saved = f.session.exportSaves().find((file) => file.path === 'savedata/queued.txt')
      assert(saved)
      assert.deepEqual(inflateSync(saved.bytes.subarray(21)), Buffer.from('persist after retry\r\n', 'utf16le'))
      assert.equal(f.session.snapshot().pendingSaves, 0)
      assert.equal(f.session.snapshot().state, 'running')
    })
  })
}

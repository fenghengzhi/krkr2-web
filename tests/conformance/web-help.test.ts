import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { getWebLocalName, openHelpDocument } from '../../src/engine/system/help.ts'
import { helpByteLimit, helpTextLimit, type HelpDocument } from '../../src/engine/ports/help.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'

const test = (name: string, run: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 60000 }, run)
const content = '帮助 雪 😀\r\n<script>window.helpExecuted=true</script>\nlast line'

test('Web local names are lexical VFS addresses including the existing empty exePath root', () => {
  for (const [input, expected] of [
    ['', 'game://./'], ['.', 'game://./'], ['Docs/../ReadMe.TXT', 'game://./ReadMe.TXT'],
    ['GAME://./Docs\\Help.txt', 'game://./Docs/Help.txt'],
    ['Docs/', 'game://./Docs/'], ['missing.txt', 'game://./missing.txt'],
  ]) assert.equal(getWebLocalName(input!), expected)
  for (const input of ['../outside', 'C:/help.txt', 'https://example.com/a.txt', 'pack.xp3>help.txt', 'bad\0.txt'])
    assert.throws(() => getWebLocalName(input))
})

test('Web shell rejects unsupported or oversized documents without performing their I/O', async () => {
  let reads = 0, shows = 0
  const control = new ExecutionControl(),
    options = {
      control,
      find: (name: string) => name === 'missing.txt' ? undefined : ({
        name, size: helpByteLimit + 1,
        read: async () => { reads++; return new Uint8Array() },
      }),
      decode: async () => '',
      host: { show: async () => { shows++; return true }, close() {} },
    }
  for (const [name, params] of [
    ['missing.txt', ''], ['large.txt', ''], ['help.txt', '--execute'],
    ['help.html', ''], ['https://example.com/help.txt', ''], ['../help.txt', ''],
    ['pack.xp3>help.txt', ''], ['', ''],
  ]) assert.equal(await openHelpDocument(name!, params!, options), false)
  assert.equal(reads, 0)
  assert.equal(shows, 0)
})

test('Web shell rechecks actual byte size and decoded text before presentation', async () => {
  let decodes = 0, shows = 0
  const options = {
    control: new ExecutionControl(),
    find: () => ({ name: 'help.txt', size: 0, read: async () => new Uint8Array(helpByteLimit + 1) }),
    decode: async () => { decodes++; return 'x'.repeat(helpTextLimit + 1) },
    host: { show: async () => { shows++; return true }, close() {} },
  }
  assert.equal(await openHelpDocument('help.txt', '', options), false)
  assert.equal(decodes, 0)
  options.find = () => ({ name: 'help.txt', size: 0, read: async () => new Uint8Array() })
  assert.equal(await openHelpDocument('help.txt', '', options), false)
  assert.equal(decodes, 1)
  assert.equal(shows, 0)
})

test('cancelled resource loading cannot present a late help document', async () => {
  let release!: (bytes: Uint8Array) => void, shows = 0
  const control = new ExecutionControl(),
    read = new Promise<Uint8Array>((resolve) => { release = resolve }),
    pending = openHelpDocument('help.txt', '', {
      control,
      find: () => ({ name: 'help.txt', size: 1, read: () => read }),
      decode: async () => content,
      host: { show: async () => { shows++; return true }, close() {} },
    })
  const result = assert.rejects(pending, /Execution cancelled/)
  control.cancel()
  await result
  release(new Uint8Array([1]))
  await Promise.resolve()
  assert.equal(shows, 0)
})

for (const late of ['resolve', 'reject'] as const) {
  test(`cancelled help decoding cannot present text or escape a late ${late}`, async () => {
    let entered!: () => void, release!: (text: string) => void, reject!: (error: Error) => void, shows = 0
    const control = new ExecutionControl(),
      started = new Promise<void>((resolve) => { entered = resolve }),
      decoded = new Promise<string>((resolve, fail) => { release = resolve; reject = fail }),
      pending = openHelpDocument('help.txt', '', {
        control,
        find: () => ({ name: 'help.txt', size: 1, read: async () => new Uint8Array([1]) }),
        decode: () => { entered(); return decoded },
        host: { show: async () => { shows++; return true }, close() {} },
      }),
      outcome = assert.rejects(pending, /Execution cancelled/)
    try {
      await started
      control.cancel()
      await outcome
      if (late === 'resolve') release(content)
      else reject(new Error('late help decode failure'))
      await Promise.resolve()
      assert.equal(shows, 0)
    } finally {
      control.cancel()
      release('')
      await Promise.allSettled([pending, outcome])
    }
  })
}

test('Web shell preserves a refused presentation and rejects an invalid port result', async () => {
  let calls = 0
  const options = {
    control: new ExecutionControl(),
    find: () => ({ name: 'help.txt', size: 0, read: async () => new Uint8Array() }),
    decode: async () => '',
    host: { show: async () => { calls++; return false }, close() {} },
  }
  assert.equal(await openHelpDocument('help.txt', '', options), false)
  // Exercise an untyped host boundary; truthy values must not report success.
  options.host.show = async () => { calls++; return 1 as unknown as boolean }
  await assert.rejects(openHelpDocument('help.txt', '', options), /Invalid help presentation result/)
  assert.equal(calls, 2)
})

test('Web shell preserves actual read and decoder errors without presenting partial text', async () => {
  let reads = 0, decodes = 0, shows = 0
  const readFailure = new Error('help read failed'), decodeFailure = new Error('help decode failed')
  const options = {
    control: new ExecutionControl(),
    find: () => ({ name: 'help.txt', size: 1, read: async () => {
      if (!reads++) throw readFailure
      return new Uint8Array([1])
    } }),
    decode: async () => { decodes++; throw decodeFailure },
    host: { show: async () => { shows++; return true }, close() {} },
  }
  await assert.rejects(openHelpDocument('help.txt', '', options), (error) => error === readFailure)
  assert.equal(decodes, 0)
  await assert.rejects(openHelpDocument('help.txt', '', options), (error) => error === decodeFailure)
  assert.equal(decodes, 1)
  assert.equal(shows, 0)
})

async function fixture(
  binary: boolean,
  source: string,
  overrides: Partial<SessionDependencies> = {},
  resources: Record<string, string | Uint8Array> = {},
) {
  const f = await headless({
    ...resources,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("help.tjs","savedata/help.cjs",false,true,false);Scripts.execStorage("savedata/help.cjs");'
      : 'Scripts.execStorage("help.tjs");',
    'help.tjs': source,
    'ReadMe.TXT': content,
    'Docs/Other.md': 'second document',
  }, overrides)
  try { await f.session.start(); return f }
  catch (error) {
    try { await f.session.stop() }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Help fixture startup and cleanup both failed', { cause: error })
    }
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`actual native help opens overlay text with canonical names and permits script continuation (${mode})`, async () => {
    const documents: HelpDocument[] = [], store = new MemorySaveStore()
    await store.commit([{ path: 'ReadMe.TXT', bytes: Buffer.from('persisted override 雪') }])
    let closed = 0
    const { session } = await fixture(binary, `
var root=Storages.getLocalName(System.exePath),after=0;
var opened=System.shellExecute(root+"readme.txt");after=1;
Storages.addAutoPath("Docs/");var second=System.shellExecute("other.MD");
`, {
      saveStore: store,
      help: { show: async (document) => { documents.push(document); return true }, close() { closed++ } },
    })
    try {
      assert.equal(await session.evaluate('[root,opened,after,second].join("|")'), 'game://./|1|1|1')
      assert.deepEqual(documents, [
        { path: 'game://./ReadMe.TXT', title: 'ReadMe.TXT', text: 'persisted override 雪' },
        { path: 'game://./Docs/Other.md', title: 'Other.md', text: 'second document' },
      ])
      assert.equal(closed, 0)
    } finally { await session.stop() }
    assert.equal(closed, 1)
  })

  test(`native help reports unsupported targets and missing host without false success (${mode})`, async () => {
    const { session } = await fixture(binary, `var outcomes=[
System.shellExecute("ReadMe.TXT"),System.shellExecute("missing.txt"),
System.shellExecute("ReadMe.TXT","--args"),System.shellExecute("https://example.com/help.txt"),
System.shellExecute("help.html")].join("|");`)
    try { assert.equal(await session.evaluate('outcomes'), '0|0|0|0|0') }
    finally { await session.stop() }
  })

  test(`native help preserves exact case, rejects ambiguity and cannot open archive autopath targets (${mode})`, async () => {
    const documents: HelpDocument[] = []
    const { session } = await fixture(binary, `
var exactUpper=System.shellExecute("Help.txt"),exactLower=System.shellExecute("help.txt"),ambiguous="";
try{System.shellExecute("HELP.TXT");}catch(e){ambiguous=e.message;}
Storages.addAutoPath("pack.xp3>");
var lexical=Storages.getLocalName("archived.txt");
var fromArchive=System.shellExecute("archived.txt"),explicitArchive=System.shellExecute("pack.xp3>archived.txt");
var localArchiveRejected=0;
try{var local=Storages.getLocalName("pack.xp3>archived.txt");}catch(e){localArchiveRejected++;}
var unicode=System.shellExecute("Docs/雪.txt");
`, {
      help: { show: async (document) => { documents.push(document); return true }, close() {} },
    }, {
      'Help.txt': 'upper', 'help.txt': 'lower',
      'pack.xp3>archived.txt': 'archive content', 'Docs/雪.txt': 'Unicode text',
    })
    try {
      assert.equal(await session.evaluate('[exactUpper,exactLower,fromArchive,explicitArchive,localArchiveRejected,unicode].join("|")'), '1|1|0|0|1|1')
      assert.equal(await session.evaluate('lexical'), 'game://./archived.txt')
      assert.match(await session.evaluate('ambiguous'), /Ambiguous resource name/)
      assert.deepEqual(documents.map(({ path, text }) => ({ path, text })), [
        { path: 'game://./Help.txt', text: 'upper' },
        { path: 'game://./help.txt', text: 'lower' },
        { path: 'game://./Docs/雪.txt', text: 'Unicode text' },
      ])
    } finally { await session.stop() }
  })

  test(`native help preserves failed presentation and can immediately retry (${mode})`, async () => {
    let calls = 0
    const { session } = await fixture(binary, `var caught="",after=0;
try{System.shellExecute("ReadMe.TXT");}catch(e){caught=e.message;}
var recovered=System.shellExecute("ReadMe.TXT");after=1;`, {
      help: { show: async () => { if (!calls++) throw new Error('presentation-failed'); return true }, close() {} },
    })
    try {
      assert.equal(await session.evaluate('caught'), 'presentation-failed')
      assert.equal(await session.evaluate('[recovered,after].join("|")'), '1|1')
      assert.equal(calls, 2)
    } finally { await session.stop() }
  })

  test(`Stop cancels a pending native help presentation and ignores its late result (${mode})`, async () => {
    let entered!: () => void, release!: (shown: boolean) => void, closed = 0
    const started = new Promise<void>((resolve) => { entered = resolve }),
      completion = new Promise<boolean>((resolve) => { release = resolve }),
      { session, logs } = await fixture(binary, `function openHelp(){
Debug.message("help-entered");var result=System.shellExecute("ReadMe.TXT");
Debug.message("help-after");return result;}`, {
        help: { show: () => { entered(); return completion }, close() { closed++ } },
      })
    const pending = session.evaluate('openHelp()'), outcome = assert.rejects(pending, /Execution cancelled/)
    try {
      await started
      await session.stop()
      await outcome
      release(true)
      await Promise.resolve()
      assert.equal(closed, 1)
      assert.deepEqual(logs, ['help-entered'])
      assert.equal(session.snapshot().handles, 0)
    } finally {
      release(false)
      await session.stop()
      await Promise.allSettled([pending])
    }
  })

  test(`Stop preserves a help close failure while releasing pending native execution and other resources (${mode})`, async () => {
    let entered!: () => void, release!: (shown: boolean) => void,
      closed = 0, rendererDisposed = 0, savesClosed = 0
    const closeFailure = new Error('help close failed'), store = new MemorySaveStore(),
      started = new Promise<void>((resolve) => { entered = resolve }),
      completion = new Promise<boolean>((resolve) => { release = resolve })
    store.close = () => { savesClosed++ }
    const { session, logs } = await fixture(binary, `function openHelp(){
Debug.message("help-entered");var result=System.shellExecute("ReadMe.TXT");
Debug.message("help-after");return result;}`, {
      saveStore: store,
      renderer: { present() {}, dispose() { rendererDisposed++ } },
      help: {
        show: () => { entered(); return completion },
        close() { closed++; throw closeFailure },
      },
    })
    const pending = session.evaluate('openHelp()'), outcome = assert.rejects(pending, /Execution cancelled/)
    try {
      await started
      await assert.rejects(session.stop(), (error) => error === closeFailure)
      await outcome
      assert.deepEqual([closed, rendererDisposed, savesClosed], [1, 1, 1])
      assert.equal(session.snapshot().state, 'failed')
      assert.equal(session.snapshot().handles, 0)
      assert.deepEqual(logs, ['help-entered'])
      release(true)
      await Promise.resolve()
      await assert.rejects(session.stop(), (error) => error === closeFailure)
      assert.deepEqual([closed, rendererDisposed, savesClosed], [1, 1, 1])
      assert.equal(session.snapshot().handles, 0)
      assert.deepEqual(logs, ['help-entered'])
    } finally {
      release(false)
      await Promise.allSettled([session.stop(), pending, outcome])
    }
  })
}

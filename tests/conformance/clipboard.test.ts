import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import {
  clipboardTextLimit,
  type ClipboardPort,
  type ClipboardText,
} from '../../src/engine/ports/clipboard.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function port(overrides: Partial<ClipboardPort> = {}) {
  const calls: string[] = [],
    writes: string[] = []
  let closed = 0
  const clipboard: ClipboardPort = {
    async hasText() {
      calls.push('has')
      return true
    },
    async readText() {
      calls.push('read')
      return { hasText: true, text: '宿主文本 🌸' }
    },
    async writeText(text) {
      calls.push('write')
      writes.push(text)
    },
    close() {
      closed++
    },
    ...overrides,
  }
  return { clipboard, calls, writes, closed: () => closed }
}

async function fixture(binary: boolean, source: string, clipboard?: ClipboardPort) {
  const harness = await headless(
    {
      'startup.tjs': binary
        ? 'Scripts.compileStorage("clipboard.tjs","savedata/clipboard.cjs",false,true,false);Scripts.execStorage("savedata/clipboard.cjs");'
        : 'Scripts.execStorage("clipboard.tjs");',
      'clipboard.tjs': source,
    },
    clipboard ? { clipboard } : {},
  )
  try {
    await harness.session.start()
  } catch (error) {
    await harness.session.stop()
    throw error
  }
  return harness
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`Clipboard has native Class, Function and Property identity with a static-free empty instance (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
var shell=new Clipboard("ignored",void),propertyAddress=&Clipboard.asText;
var identity=[Clipboard instanceof "Class",Clipboard instanceof "Clipboard",
  Clipboard.hasFormat instanceof "Function",(&global.propertyAddress) instanceof "Property",
  shell instanceof "Clipboard",shell instanceof "Class",typeof shell.hasFormat,
  typeof shell.asText,shell.finalize instanceof "Function",cbfText].join("|");
shell.finalize();invalidate shell;
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('identity'), '1|1|1|1|1|0|undefined|undefined|1|1')
      assert.deepEqual(p.calls, [], 'Reflection and construction must not access the clipboard')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Clipboard native members accept another nonempty receiver and preserve property references (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
var receiver=%[],method=Clipboard.hasFormat incontextof receiver;
var textProperty=(&Clipboard.asText) incontextof receiver;
var found=method(cbfText),first=*(&global.textProperty);
*(&global.textProperty)="borrowed 🌸";
var second=Clipboard.asText;
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('found'), '1')
      assert.equal(await session.evaluate('first'), '宿主文本 🌸')
      assert.equal(await session.evaluate('second'), '宿主文本 🌸')
      assert.deepEqual(p.calls, ['has', 'read', 'write', 'read'])
      assert.deepEqual(p.writes, ['borrowed 🌸'])
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard.hasFormat converts in TJS before narrowing to signed 32 bits (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
var formats=[1,1.9,"1",4294967297,-4294967295,9007199254740993],results=[];
for(var i=0;i<formats.count;i++)results.add(Clipboard.hasFormat(formats[i],"ignored"));
var unsupported=[0,2,-1,void,4294967296,9007199254740992,-4294967296];
for(var i=0;i<unsupported.count;i++)results.add(Clipboard.hasFormat(unsupported[i]));
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('results.join(",")'), '1,1,1,1,1,1,0,0,0,0,0,0,0')
      assert.deepEqual(p.calls, Array<string>(6).fill('has'))
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard.hasFormat still queries the host when the script discards its return value (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
Clipboard.hasFormat(cbfText);
Clipboard.hasFormat(2);
var continued=true;
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('continued'), '1')
      assert.deepEqual(p.calls, ['has'])
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard.hasFormat rejects absent, object and octet arguments before calling its port (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
var rejected=0;
try{Clipboard.hasFormat();}catch(e){rejected++;}
try{Clipboard.hasFormat(%[]);}catch(e){rejected++;}
try{Clipboard.hasFormat(null);}catch(e){rejected++;}
try{Clipboard.hasFormat(<% 01 %>);}catch(e){rejected++;}
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('rejected'), '4')
      assert.deepEqual(p.calls, [])
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard reads distinguish absent text, empty text and fresh independent snapshots (${mode})`, async () => {
    const reads: ClipboardText[] = [
      { hasText: false },
      { hasText: true, text: '' },
      { hasText: true, text: '外部改变\r\n次の行 🌸' },
    ]
    let hasCalls = 0,
      readCalls = 0
    const p = port({
      async hasText() {
        return ++hasCalls === 1
      },
      async readText() {
        assert.ok(readCalls < reads.length, 'Unexpected extra clipboard read')
        return reads[readCalls++]!
      },
    })
    const { session } = await fixture(
      binary,
      `
var firstHas=Clipboard.hasFormat(cbfText),missing=Clipboard.asText;
var secondHas=Clipboard.hasFormat(cbfText),empty=Clipboard.asText,next=Clipboard.asText;
var result=[firstHas,missing===void,secondHas,empty==="",empty!==void].join("|");
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('result'), '1|1|0|1|1')
      assert.equal(await session.evaluate('next'), '外部改变\r\n次の行 🌸')
      assert.equal(hasCalls, 2)
      assert.equal(readCalls, 3)
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard.asText uses native ttstr coercion and rejects octets before a write (${mode})`, async () => {
    const p = port()
    const { session } = await fixture(
      binary,
      `
Clipboard.asText=void;Clipboard.asText="";Clipboard.asText=42;
Clipboard.asText=-7;Clipboard.asText=9007199254740993;
Clipboard.asText="漢字 🌸\\nsecond";
var object=%[toString:function(){throw new Exception("must not run JavaScript-style toString");}];
var expectedObject=string(object);Clipboard.asText=object;
var rejected=0;try{Clipboard.asText=<% 01 02 %>;}catch(e){rejected++;}
`,
      p.clipboard,
    )
    try {
      assert.deepEqual(p.writes.slice(0, 6), [
        '',
        '',
        '42',
        '-7',
        '9007199254740993',
        '漢字 🌸\nsecond',
      ])
      assert.equal(p.writes[6], await session.evaluate('expectedObject'))
      assert.equal(p.writes.length, 7)
      assert.equal(await session.evaluate('rejected'), '1')
      assert.deepEqual(p.calls, Array<string>(7).fill('write'))
    } finally {
      await session.stop()
    }
  })

  test(`Clipboard accepts the exact UTF-16 text limit for a host read and native write (${mode})`, async () => {
    const maximum = '🌸'.repeat(clipboardTextLimit / 2),
      lengths: number[] = []
    let reads = 0
    const p = port({
      async readText() {
        reads++
        return { hasText: true, text: maximum }
      },
      async writeText(text) {
        lengths.push(text.length)
      },
    })
    const { session } = await fixture(
      binary,
      `
var maximum=Clipboard.asText;
var observedLength=maximum.length;
Clipboard.asText=maximum;
var continued=true;
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('observedLength'), String(clipboardTextLimit))
      assert.equal(await session.evaluate('continued'), '1')
      assert.equal(reads, 1)
      assert.deepEqual(lengths, [clipboardTextLimit])
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Clipboard rejects oversized writes before the port and oversized reads before script assignment (${mode})`, async () => {
    let writes = 0,
      reads = 0
    const oversized = '🌸'.repeat(clipboardTextLimit / 2) + 'X'
    const p = port({
      async readText() {
        return { hasText: true, text: ++reads === 1 ? oversized : 'valid next read' }
      },
      async writeText() {
        writes++
      },
    })
    const { session } = await fixture(
      binary,
      `
var oversized="🌸";
while(oversized.length<${clipboardTextLimit})oversized+=oversized;
oversized+="X";
var suppliedLength=oversized.length,writeError="",readError="",received="untouched";
try{Clipboard.asText=oversized;}catch(error){writeError=error.message;}
try{received=Clipboard.asText;}catch(error){readError=error.message;}
var next=Clipboard.asText;
`,
      p.clipboard,
    )
    try {
      assert.equal(await session.evaluate('suppliedLength'), String(clipboardTextLimit + 1))
      assert.match(await session.evaluate('writeError'), /^QuotaExceededError:/)
      assert.match(await session.evaluate('readError'), /^QuotaExceededError:/)
      assert.equal(await session.evaluate('received'), 'untouched')
      assert.equal(await session.evaluate('next'), 'valid next read')
      assert.equal(writes, 0)
      assert.equal(reads, 2)
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Clipboard waits for a host write before continuing and reads from the port after writing (${mode})`, async () => {
    const entered = deferred<void>(),
      completion = deferred<void>(),
      reads: string[] = []
    const p = port({
      writeText(text) {
        reads.push(`write:${text}`)
        entered.resolve()
        return completion.promise
      },
      async readText() {
        reads.push('read')
        return { hasText: true, text: '外部の内容' }
      },
    })
    const { session, logs } = await fixture(
      binary,
      `
function run(){
  Debug.message("before-write");Clipboard.asText="copy me";
  Debug.message("after-write");return Clipboard.asText;
}
`,
      p.clipboard,
    )
    let pending: Promise<string> | undefined
    try {
      const baseline = session.snapshot().handles
      pending = session.evaluate('run()')
      const result = pending.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      )
      await bounded(entered.promise, 'clipboard write entered')
      assert.deepEqual(logs, ['before-write'])
      assert.deepEqual(reads, ['write:copy me'])
      completion.resolve()
      const finished = await bounded(result, 'clipboard write completed')
      if (!finished.ok) throw finished.error
      assert.equal(finished.value, '外部の内容')
      assert.deepEqual(logs, ['before-write', 'after-write'])
      assert.deepEqual(reads, ['write:copy me', 'read'])
      assert.equal(session.snapshot().handles, baseline)
    } finally {
      completion.resolve()
      await session.stop()
      await Promise.allSettled(pending ? [pending] : [])
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Clipboard port failures reach TJS catch with their original operation error names (${mode})`, async () => {
    const p = port({
      async hasText() {
        throw new DOMException('format permission denied', 'NotAllowedError')
      },
      async readText() {
        throw new DOMException('text item disappeared', 'NotFoundError')
      },
      async writeText() {
        throw new DOMException('copy cancelled', 'AbortError')
      },
    })
    const { session } = await fixture(
      binary,
      `
var failures=[];
try{Clipboard.hasFormat(cbfText);}catch(e){failures.add(e.message);}
try{var ignored=Clipboard.asText;}catch(e){failures.add(e.message);}
try{Clipboard.asText="synthetic";}catch(e){failures.add(e.message);}
`,
      p.clipboard,
    )
    try {
      assert.equal(
        await session.evaluate('failures.join("|")'),
        'NotAllowedError: format permission denied|NotFoundError: text item disappeared|AbortError: copy cancelled',
      )
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Clipboard without an installed port rejects supported operations instead of emulating memory (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var errors=[],unsupported=Clipboard.hasFormat(2);
try{Clipboard.hasFormat(cbfText);}catch(e){errors.add(e.message);}
try{var ignored=Clipboard.asText;}catch(e){errors.add(e.message);}
try{Clipboard.asText="synthetic";}catch(e){errors.add(e.message);}
`,
    )
    try {
      assert.equal(await session.evaluate('unsupported'), '0')
      assert.equal(await session.evaluate('errors.count'), '3')
      for (const message of (await session.evaluate('errors.join("|")')).split('|'))
        assert.match(message, /^NotSupportedError:/)
    } finally {
      await session.stop()
    }
  })

  for (const operation of ['has', 'read', 'write'] as const) {
    test(`Stopping pending Clipboard ${operation} releases its native stack and observes late port rejection (${mode})`, async () => {
      const entered = deferred<void>(),
        completion = deferred<never>()
      const wait = () => {
        entered.resolve()
        return completion.promise
      }
      const p = port({ hasText: wait, readText: wait, writeText: wait })
      const expression =
        operation === 'has'
          ? 'Clipboard.hasFormat(cbfText)'
          : operation === 'read'
            ? 'Clipboard.asText'
            : '(Clipboard.asText="pending synthetic")'
      const { session, logs } = await fixture(
        binary,
        `
function run(){Debug.message("entered-script");var value=${expression};Debug.message("after-clipboard");return value;}
`,
        p.clipboard,
      )
      let pending: Promise<string> | undefined
      try {
        pending = session.evaluate('run()')
        const outcome = pending.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        await bounded(entered.promise, `clipboard ${operation} entered`)
        await bounded(session.stop(), `stop pending clipboard ${operation}`)
        const stopped = await bounded(outcome, `cancelled clipboard ${operation} result`)
        assert.equal(stopped.ok, false, 'Stopped clipboard evaluation must reject')
        if (stopped.ok) assert.fail(`Clipboard continued after Stop: ${stopped.value}`)
        assert.ok(stopped.error instanceof Error)
        assert.match(stopped.error.message, /Execution cancelled/)
        assert.equal(p.closed(), 1)
        assert.equal(session.snapshot().handles, 0)
        assert.deepEqual(logs, ['entered-script'])
        // Real Clipboard promises have no AbortSignal. A failure after Stop
        // must be observed without reviving the old VM or continuing script.
        completion.reject(new DOMException('late clipboard failure', 'NotAllowedError'))
        await Promise.resolve()
        assert.equal(session.snapshot().handles, 0)
        assert.deepEqual(logs, ['entered-script'])
      } finally {
        completion.reject(new Error('clipboard fixture closed'))
        await session.stop()
        await Promise.allSettled(pending ? [pending] : [])
      }
    })
  }
}

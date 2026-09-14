import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { headless } from '../helpers/headless.ts'
import { scriptsFixture } from '../helpers/scripts-fixture.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'

const debug = { arguments: new Map([['-debug', 'yes']]) }
const bytes = (files: SaveFile[], name: string) => {
  const file = files.find((file) => file.path === name)
  assert(file, 'Missing output ' + name)
  return file.bytes
}
const text = (hex: string, prefix = '', suffix = '') =>
  Buffer.concat([Buffer.from(prefix), Buffer.from(hex, 'hex'), Buffer.from(suffix)])

test('Scripts has native class/method, coercion, reflection and missing-member behavior', async () => {
  const { session, logs } = await headless(scriptsFixture, debug)
  try {
    await session.start()
    assert(logs.includes('native-scripts-ready'))
    assert.equal(
      Buffer.from(bytes(session.exportSaves(), 'savedata/native.cjs').subarray(0, 4)).toString(),
      'TJS2',
    )
  } finally {
    await session.stop()
  }
})

test('native exec/eval and storage calls preserve exact caller frames without bootstrap wrappers', async () => {
  const { session } = await headless(
    {
      'startup.tjs': [
        'function caller(){',
        '  Scripts.exec("global.direct=Scripts.getTraceString();","inline.tjs","40");',
        '  global.loaded=Scripts.evalStorage("folder/trace.tjs");',
        '}',
        'caller();',
        'var unnamed=Scripts.eval("Scripts.getTraceString()",void,void);',
      ].join('\n'),
      'folder/trace.tjs': 'Scripts.getTraceString()',
    },
    debug,
  )
  try {
    await session.start()
    assert.equal(
      await session.evaluate('direct'),
      'inline.tjs(41)[(top level script) global] <-- startup.tjs(2)[(function) caller] <-- startup.tjs(5)[(top level script) global]',
    )
    assert.equal(
      await session.evaluate('loaded'),
      'trace.tjs(1)[(top level script) global] <-- startup.tjs(3)[(function) caller] <-- startup.tjs(5)[(top level script) global]',
    )
    assert.match(
      await session.evaluate('unnamed'),
      /^\(1\)\[\(top level script\) global\] <-- startup.tjs\(6\)/,
    )
  } finally {
    await session.stop()
  }
})

test('compileStorage honors result, debug and expression flags and does not execute while compiling', async () => {
  const { session } = await headless(
    {
      'startup.tjs': 'var executed=0;',
      'expression.tjs': '(global.executed+=1,42)',
      'program.tjs': 'global.executed+=1;',
      'trace.tjs': '\n\nScripts.getTraceString()',
    },
    debug,
  )
  try {
    await session.start()
    let executed = 0
    for (const expression of [false, true])
      for (const result of [false, true])
        for (const outputDebug of [false, true]) {
          const output = `savedata/flags-${Number(expression)}${Number(result)}${Number(outputDebug)}.cjs`
          await session.evaluate(
            `Scripts.compileStorage("${expression ? 'expression' : 'program'}.tjs","${output}",${result},${outputDebug},${expression})`,
          )
          assert.equal(await session.evaluate('executed'), String(executed))
          const value = await session.evaluate(`Scripts.evalStorage("${output}")`)
          if (expression) assert.equal(value, result ? '42' : '')
          assert.equal(await session.evaluate('executed'), String(++executed))
          assert.equal(
            Buffer.from(bytes(session.exportSaves(), output).subarray(0, 4)).toString(),
            'TJS2',
          )
        }
    for (const outputDebug of [false, true]) {
      await session.evaluate(
        `Scripts.compileStorage("trace.tjs","savedata/trace.cjs",true,${outputDebug},true)`,
      )
      assert.match(
        await session.evaluate('Scripts.evalStorage("savedata/trace.cjs")'),
        new RegExp(`^trace.cjs\\(${outputDebug ? 3 : 1}\\)`),
      )
    }
  } finally {
    await session.stop()
  }
})

test('compileStorage preserves unread inputs and truncates an opened output on compilation failure', async () => {
  const store = new MemorySaveStore()
  await store.commit([{ path: 'savedata/output.cjs', bytes: Buffer.from('old-output') }])
  const { session } = await headless(
    { 'startup.tjs': 'var caught=0;', 'bad.tjs': 'function {' },
    { saveStore: store },
  )
  try {
    await session.start()
    await session.evaluate(
      'try{Scripts.compileStorage("absent.tjs","savedata/output.cjs");}catch(e){caught++;}',
    )
    assert.equal(
      Buffer.from(bytes(session.exportSaves(), 'savedata/output.cjs')).toString(),
      'old-output',
    )
    await session.evaluate(
      'try{Scripts.compileStorage("bad.tjs","savedata/output.cjs");}catch(e){caught++;}',
    )
    assert.equal(bytes(session.exportSaves(), 'savedata/output.cjs').length, 0)
    assert.equal(bytes(await store.load(), 'savedata/output.cjs').length, 0)
    await session.evaluate(
      'try{Scripts.compileStorage("bad.tjs","data.xp3>out.cjs");}catch(e){caught++;}',
    )
    assert.equal(await session.evaluate('caught'), '3')
    assert(!session.exportSaves().some((file) => file.path.includes('>')))
  } finally {
    await session.stop()
  }
})

test('textEncoding controls script, native text, KAG and compile reads while BOM and explicit modes win', async () => {
  const { session } = await headless({
    'startup.tjs': 'var initialEncoding=Scripts.textEncoding;',
    'sjis.tjs': text('93fa967b8cea', 'var japanese="', '";'),
    'gbk.txt': text('d6d0cec4'),
    'gbk.ks': text('d6d0cec4'),
    'gbk-expression.tjs': text('d6d0cec4', '"', '"'),
    'bom.tjs': Buffer.from('\ufeff"😀"'),
    'utf8.tjs': '"日本語😀"',
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('initialEncoding'), 'UTF-8')
    for (const alias of ['SJIS', 'shiftjis', 'shift_jis', 'shift-jis']) {
      await session.evaluate(`Scripts.textEncoding="${alias}";Scripts.execStorage("sjis.tjs");`)
      assert.equal(await session.evaluate('japanese'), '日本語')
      assert.equal(await session.evaluate('Scripts.textEncoding'), alias)
    }
    await session.evaluate('Scripts.textEncoding="GBK";var lines=[].load("gbk.txt");')
    assert.equal(await session.evaluate('lines[0]'), '中文')
    await session.evaluate(
      'var parser=new KAGParser();parser.debugLevel=tkdlNone;parser.loadScenario("gbk.ks");',
    )
    assert.equal(
      await session.evaluate('parser.getNextTag().text+parser.getNextTag().text'),
      '中文',
    )
    await session.evaluate(
      'Scripts.compileStorage("gbk-expression.tjs","savedata/chinese.cjs",true,false,true)',
    )
    assert.equal(await session.evaluate('Scripts.evalStorage("savedata/chinese.cjs")'), '中文')
    assert.equal(await session.evaluate('Scripts.evalStorage("bom.tjs")'), '😀')
    assert.equal(await session.evaluate('Scripts.evalStorage("utf8.tjs","utf-8")'), '日本語😀')
    await session.evaluate(
      'var rejected=false;try{Scripts.textEncoding="unsupported";}catch(e){rejected=true;}',
    )
    assert.equal(await session.evaluate('rejected'), '1')
    assert.equal(await session.evaluate('Scripts.textEncoding'), 'unsupported')
    assert.equal(await session.evaluate('[].load("gbk.txt")[0]'), '中文')
    await session.evaluate('Scripts.textEncoding="UTF8";')
    assert.equal(await session.evaluate('Scripts.evalStorage("utf8.tjs")'), '日本語😀')
  } finally {
    await session.stop()
  }
})

for (const cancelled of [false, true])
  test(`compileStorage ${cancelled ? 'cancels' : 'resumes'} a suspended warning without executing source`, async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session } = await headless({
      'startup.tjs':
        'var observerVisits=0,finished=0;Debug.addLoggingHandler(function(line){if(line.indexOf("warning-source.tjs")>=0)Scripts.execStorage("gate.tjs");});',
      'warning-source.tjs': 'var compiledValue=0;if(compiledValue=1){}',
    })
    const source = Buffer.from('observerVisits++;')
    session.mount([
      {
        name: 'gate.tjs',
        size: source.length,
        read: async () => {
          entered()
          await gate
          return source
        },
      },
    ])
    let settled = false
    try {
      await session.start()
      const pending = session
        .evaluate('Scripts.compileStorage("warning-source.tjs","savedata/warning.cjs");finished=1;')
        .then(
          (value) => {
            settled = true
            return value
          },
          (error: unknown) => {
            settled = true
            return error
          },
        )
      await started
      session.pause()
      release()
      await delay(20)
      assert.equal(settled, false)
      if (cancelled) {
        await session.stop()
        assert.match(String(await pending), /cancelled/)
        assert.equal(bytes(session.exportSaves(), 'savedata/warning.cjs').length, 0)
      } else {
        session.resume()
        await pending
        assert.equal(await session.evaluate('finished+observerVisits'), '2')
        assert.equal(await session.evaluate('typeof global.compiledValue'), 'undefined')
        assert.equal(
          Buffer.from(
            bytes(session.exportSaves(), 'savedata/warning.cjs').subarray(0, 4),
          ).toString(),
          'TJS2',
        )
      }
    } finally {
      release()
      await session.stop()
    }
  })

test('compiled files are critical game writes and remain exportable after a persistence failure', async () => {
  class Store extends MemorySaveStore {
    override async commit(): Promise<void> {
      throw new Error('compiler-store-quota')
    }
  }
  const { session } = await headless(
    {
      'startup.tjs': 'Scripts.compileStorage("source.tjs","savedata/file.cjs",true,false,true);',
      'source.tjs': '6*7',
    },
    { saveStore: new Store() },
  )
  try {
    await assert.rejects(session.start(), /compiler-store-quota/)
    assert.equal(
      Buffer.from(bytes(session.exportSaves(), 'savedata/file.cjs').subarray(0, 4)).toString(),
      'TJS2',
    )
    assert(session.snapshot().pendingSaves > 0)
  } finally {
    await session.stop().catch(() => {})
  }
})

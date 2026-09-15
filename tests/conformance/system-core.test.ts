import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

test('System conformance uses a kernel advertising native System and preserved Clipboard support', async () => {
  const manifest: WasmManifest = JSON.parse(
    readFileSync(resolve('.generated/wasm/manifest.json'), 'utf8'),
  )
  assert.equal(manifest.capabilities?.nativeSystem, 1)
  assert.equal(manifest.capabilities?.nativeClipboard, 1)
})

async function fixture(
  binary: boolean,
  source: string,
  overrides: Partial<SessionDependencies> = {},
  resources: Record<string, string | Uint8Array> = {},
) {
  const harness = await headless(
    {
      ...resources,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("system-core.tjs","savedata/system-core.cjs",false,true,false);Scripts.execStorage("savedata/system-core.cjs");'
        : 'Scripts.execStorage("system-core.tjs");',
      'system-core.tjs': source,
    },
    overrides,
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

  test(`System is a native nonconstructible class and rejected construction leaves it usable (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var identity=[System instanceof "Class",System instanceof "System",System instanceof "Object",
  System instanceof "Dictionary",System instanceof "Function"].join("|");
var rejected=0,derivedConstructorCalls=0;
try{var direct=new System("ignored");}catch(error){rejected++;}
class DerivedSystem extends System {
  function DerivedSystem(){derivedConstructorCalls++;super.System();}
}
try{var derived=new DerivedSystem();}catch(error){rejected++;}
var emptyConstructor=System.System("ignored",<% 01 %>,void);
var emptyFinalizer=System.finalize("ignored",<% 02 %>,void);
var after=[emptyConstructor===void,emptyFinalizer===void,
  System.System instanceof "Function",System.finalize instanceof "Function",
  System.getArgument instanceof "Function",System.createUUID instanceof "Function"].join("|");
`,
    )
    try {
      assert.equal(await session.evaluate('identity'), '1|1|1|0|0')
      assert.equal(await session.evaluate('rejected'), '2')
      assert.equal(await session.evaluate('derivedConstructorCalls'), '0')
      assert.equal(await session.evaluate('after'), '1|1|1|1|1|1')
      assert.equal(await session.evaluate('System.platformName'), 'Web')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System readonly properties preserve native property references, forced replacement and deletion (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var saved=&System.exePath,original=*(&global.saved);
&System.exePath="replacement/";
var replacement=System.exePath,stillOriginal=*(&global.saved);
&System.exePath=&global.saved;
var restored=System.exePath,writeRejected=0;
try{System.exePath="ordinary write";}catch(error){writeRejected++;}
delete System.exePath;
var absentType=typeof System.exePath,readRejected=0;
try{var absent=System.exePath;}catch(error){readRejected++;}
&System.exePath=&global.saved;
var finalValue=System.exePath;
`,
    )
    try {
      assert.equal(await session.evaluate('original'), '')
      assert.equal(await session.evaluate('replacement'), 'replacement/')
      assert.equal(await session.evaluate('stillOriginal'), '')
      assert.equal(await session.evaluate('restored'), '')
      assert.equal(await session.evaluate('writeRejected'), '1')
      assert.equal(await session.evaluate('absentType'), 'undefined')
      assert.equal(await session.evaluate('readRejected'), '1')
      assert.equal(await session.evaluate('finalValue'), '')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System partial native class binding failure releases delegates and leaves the published class usable (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var originalSystem=System;
function badAssembly(){
  var delegate=function(){},message="";
  try{
    // Thirteen valid method delegates, followed by four functions where the
    // native bridge requires property delegates. None of these bodies runs.
    var unpublished=__host("System.class",
      delegate,delegate,delegate,delegate,delegate,delegate,delegate,
      delegate,delegate,delegate,delegate,delegate,delegate,
      delegate,delegate,delegate,delegate);
  }catch(error){message=error.message;}
  if(System!==originalSystem)throw new Exception("Published System was replaced");
  return message;
}
`,
    )
    try {
      const baseline = session.snapshot().handles
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.match(
          await session.evaluate('badAssembly()'),
          /Cannot bind System\.graphicCacheLimit/,
        )
        assert.equal(await session.evaluate('System===originalSystem'), '1')
        assert.equal(await session.evaluate('System.versionString'), '0.0.0.0')
        assert.equal(
          session.snapshot().handles,
          baseline,
          'Failed binding must release temporary handles',
        )
      }
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System callback slots start as null and stay writable independently of readonly properties (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var initial=[System.exceptionHandler===null,System.onActivate===null,
  System.onDeactivate===null,System.exceptionHandler!==void].join("|");
var callbackCalls=[];
System.exceptionHandler=function(){callbackCalls.add("exception");return true;};
System.onActivate=function(){callbackCalls.add("activate");};
System.onDeactivate=function(){callbackCalls.add("deactivate");};
var handled=System.exceptionHandler();System.onActivate();System.onDeactivate();
System.exceptionHandler=null;System.onActivate=null;System.onDeactivate=null;
System.title="脚本标题 🌸";
var restored=[System.exceptionHandler===null,System.onActivate===null,
  System.onDeactivate===null].join("|");
`,
    )
    try {
      assert.equal(await session.evaluate('initial'), '1|1|1|1')
      assert.equal(
        await session.evaluate('callbackCalls.join("|")'),
        'exception|activate|deactivate',
      )
      assert.equal(await session.evaluate('handled'), '1')
      assert.equal(await session.evaluate('restored'), '1|1|1')
      assert.equal(await session.evaluate('System.title'), '脚本标题 🌸')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System path and build metadata are native readonly properties with honest Web values (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var names=["exePath","exeName","personalPath","appDataPath","dataPath",
  "versionString","versionInformation","platformName","osName"];
var properties=0,rejected=0,unchanged=0,mutableProperties=0;
for(var i=0;i<names.count;i++){
  var before=System[names[i]];
  if((&System[names[i]]) instanceof "Property")properties++;
  try{System[names[i]]="changed";}catch(error){rejected++;}
  if(System[names[i]]===before)unchanged++;
}
var mutableNames=["title","eventDisabled","graphicCacheLimit","exitOnWindowClose"];
for(var i=0;i<mutableNames.count;i++)
  if((&System[mutableNames[i]]) instanceof "Property")mutableProperties++;
var identityPath=Storages.extractStoragePath(System.exeName)===System.exePath;
`,
    )
    try {
      assert.equal(await session.evaluate('[properties,rejected,unchanged].join("|")'), '9|9|9')
      assert.equal(await session.evaluate('mutableProperties'), '4')
      assert.equal(await session.evaluate('System.exePath'), '')
      assert.equal(await session.evaluate('System.exeName'), 'krkr2-web')
      assert.equal(await session.evaluate('identityPath'), '1')
      assert.equal(await session.evaluate('System.versionString'), '0.0.0.0')
      const information = await session.evaluate('System.versionInformation')
      assert.match(information, /krkr2-web\/0\.0\.0/)
      assert.match(information, /TJS2\/2\.4\.28/)
      assert.doesNotMatch(information, /2\.32\.2\.426|\/Users\/|[A-Z]:\\/)
      assert.equal(
        await session.evaluate('[System.osName,System.platformName].join("|")'),
        'Web|Web',
      )
    } finally {
      await session.stop()
    }
  })

  test(`System static members can be borrowed by a nonempty receiver without changing that receiver (${mode})`, async () => {
    const acquired: string[] = []
    const { session } = await fixture(
      binary,
      `
var receiver=%[sentinel:"untouched",__host:function(){throw "receiver host must not run";}];
var get=System.getArgument incontextof receiver;
var set=System.setArgument incontextof receiver;
var lock=System.createAppLock incontextof receiver;
var pathAddress=(&System.dataPath) incontextof receiver;
var titleAddress=(&System.title) incontextof receiver;
set("-borrowed","借用 🌸");
var borrowed=get("-borrowed"),locked=lock("borrowed-lock"),path=*(&global.pathAddress);
*(&global.titleAddress)="借用标题 🌸";
var title=*(&global.titleAddress);
var missing=0;
try{var absent=System.__missing_system_core_member__;}catch(error){missing++;}
`,
      {
        appLocks: {
          async acquire(key) {
            acquired.push(key)
            return true
          },
          async close() {},
        },
      },
    )
    try {
      assert.equal(await session.evaluate('borrowed'), '借用 🌸')
      assert.equal(await session.evaluate('locked'), '1')
      assert.equal(await session.evaluate('path'), 'savedata/')
      assert.equal(await session.evaluate('title'), '借用标题 🌸')
      assert.equal(await session.evaluate('System.title'), '借用标题 🌸')
      assert.equal(await session.evaluate('receiver.sentinel'), 'untouched')
      assert.equal(await session.evaluate('missing'), '1')
      assert.deepEqual(acquired, ['borrowed-lock'])
    } finally {
      await session.stop()
    }
  })

  test(`System native argument minimums apply even when callers discard results (${mode})`, async () => {
    const acquired: string[] = []
    const { session, events } = await fixture(
      binary,
      `
var failures=[];
try{System.getArgument();}catch(error){failures.add("get");}
try{System.setArgument("-absent");}catch(error){failures.add("set");}
try{System.createAppLock();}catch(error){failures.add("lock");}
try{System.getKeyState();}catch(error){failures.add("key");}
try{System.addContinuousHandler();}catch(error){failures.add("add");}
try{System.removeContinuousHandler();}catch(error){failures.add("remove");}
try{System.touchImages();}catch(error){failures.add("touch");}
try{System.inform();}catch(error){failures.add("inform");}
try{System.inputString("caption","prompt");}catch(error){failures.add("input");}
var absent=System.getArgument("-absent")===void;
`,
      {
        appLocks: {
          async acquire(key) {
            acquired.push(key)
            return true
          },
          async close() {},
        },
      },
    )
    try {
      assert.equal(
        await session.evaluate('failures.join("|")'),
        'get|set|lock|key|add|remove|touch|inform|input',
      )
      assert.equal(await session.evaluate('absent'), '1')
      assert.deepEqual(acquired, [])
      assert.equal(
        events.some((event) => event.type === 'system-dialog' && event.request),
        false,
      )
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System discarded argument and lock results evaluate parameters without converting or accessing locks (${mode})`, async () => {
    const acquired: string[] = []
    const { session } = await fixture(
      binary,
      `
var evaluations=0,converted=0;
property invalidArgument {getter(){evaluations++;return <% 01 02 %>;}}
System.getArgument(invalidArgument);
System.createAppLock(invalidArgument);
var discardedEvaluations=evaluations;
try{var got=System.getArgument(invalidArgument);}catch(error){converted++;}
try{var locked=System.createAppLock(invalidArgument);}catch(error){converted++;}
System.getArgument("-value","extra");System.createAppLock("discarded-lock","extra");
var value=System.getArgument("-value",void),lock=System.createAppLock("real-lock",void);
`,
      {
        arguments: new Map([['-value', 'present']]),
        appLocks: {
          async acquire(key) {
            acquired.push(key)
            return true
          },
          async close() {},
        },
      },
    )
    try {
      assert.equal(await session.evaluate('discardedEvaluations'), '2')
      assert.equal(await session.evaluate('evaluations'), '4')
      assert.equal(await session.evaluate('converted'), '2')
      assert.equal(await session.evaluate('value'), 'present')
      assert.equal(await session.evaluate('lock'), '1')
      assert.deepEqual(acquired, ['real-lock'])
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System argument writes preserve TJS conversion and do not call object toString hooks (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var hooks=0,object=%[toString:function(){hooks++;throw "unexpected toString";}];
var expected=string(object);
System.setArgument("-object",object);System.setArgument(42,9007199254740993);
System.setArgument("-empty",void,"ignored");
var rejected=0;
try{System.setArgument("-object",<% 01 %>);}catch(error){rejected++;}
var actual=System.getArgument("-object"),large=System.getArgument(42),empty=System.getArgument("-empty");
`,
    )
    try {
      assert.equal(await session.evaluate('hooks'), '0')
      assert.equal(await session.evaluate('actual'), await session.evaluate('expected'))
      assert.equal(await session.evaluate('large'), '9007199254740993')
      assert.equal(await session.evaluate('empty===""'), '1')
      assert.equal(await session.evaluate('rejected'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`System.createUUID formats injected bytes and requests fresh entropy for discarded calls (${mode})`, async () => {
    const buffers: Uint8Array[] = []
    const { session } = await fixture(
      binary,
      `
var uuid0=System.createUUID(),uuidFF=System.createUUID(),uuidSequence=System.createUUID();
var extraArguments=0;
property ignoredArgument {getter(){extraArguments++;return <% 01 %>;}}
System.createUUID(ignoredArgument,void,"ignored");
var continued=true;
`,
      {
        fillRandomBytes(bytes) {
          assert.equal(bytes.length, 16)
          buffers.push(bytes)
          if (buffers.length === 2) bytes.fill(255)
          else if (buffers.length === 3) for (let i = 0; i < bytes.length; i++) bytes[i] = i
          else bytes.fill(0)
        },
      },
    )
    try {
      const uuids = [
        await session.evaluate('uuid0'),
        await session.evaluate('uuidFF'),
        await session.evaluate('uuidSequence'),
      ]
      assert.deepEqual(uuids, [
        '00000000-0000-4000-8000-000000000000',
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
        '00010203-0405-4607-8809-0a0b0c0d0e0f',
      ])
      for (const uuid of uuids)
        assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(buffers.length, 4)
      assert.equal(await session.evaluate('extraArguments'), '1')
      assert.equal(await session.evaluate('continued'), '1')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System.createUUID reports unavailable entropy for valued and discarded calls (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var errors=[];
try{var uuid=System.createUUID();}catch(error){errors.add(error.message);}
try{System.createUUID();}catch(error){errors.add(error.message);}
var after=System.platformName;
`,
    )
    try {
      assert.equal(await session.evaluate('errors.count'), '2')
      for (const message of (await session.evaluate('errors.join("|")')).split('|'))
        assert.match(message, /unsupported|not supported|unavailable|NotSupported/i)
      assert.equal(await session.evaluate('after'), 'Web')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System.createUUID provider errors remain catchable and do not poison the next call (${mode})`, async () => {
    let calls = 0
    const { session } = await fixture(
      binary,
      `
var errorText="";
try{System.createUUID();}catch(error){errorText=error.message;}
var recovered=System.createUUID();
`,
      {
        fillRandomBytes(bytes) {
          if (++calls === 1) throw new Error('entropy-provider-test-failure')
          bytes.fill(0)
        },
      },
    )
    try {
      assert.match(await session.evaluate('errorText'), /entropy-provider-test-failure/)
      assert.equal(await session.evaluate('recovered'), '00000000-0000-4000-8000-000000000000')
      assert.equal(calls, 2)
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`System virtual paths read mounted Unicode files and persist text and binary across a fresh VM (${mode})`, async () => {
    const store = new MemorySaveStore()
    const first = await fixture(
      binary,
      `
var mounted=Scripts.evalStorage(System.exePath+"素材/雪 🌸.tjs");
var aliases=[System.personalPath,System.appDataPath,System.dataPath].join("|");
["personal","保存 🌸"].save(System.personalPath+"personal.txt");
["appdata","次の行"].save(System.appDataPath+"appdata.txt");
var state=%[large:9007199254740993,text:"保存 🌸",bytes:<% 00 7f ff %>];
(Dictionary.saveStruct incontextof state)(System.dataPath+"state.bin","b");
var same=Dictionary.loadStruct(System.dataPath+"state.bin");
var missingRunner=!Storages.isExistentStorage(System.exeName),runnerReadRejected=0;
try{Scripts.execStorage(System.exeName);}catch(error){runnerReadRejected++;}
System.exceptionHandler=function(){return true;};
System.onActivate=function(){};System.onDeactivate=function(){};System.title="old VM";
`,
      { saveStore: store },
      { '素材/雪 🌸.tjs': '"mounted 雪 🌸"' },
    )
    try {
      assert.equal(await first.session.evaluate('mounted'), 'mounted 雪 🌸')
      assert.equal(await first.session.evaluate('aliases'), 'savedata/|savedata/|savedata/')
      assert.equal(await first.session.evaluate('same.large'), '9007199254740993')
      assert.equal(await first.session.evaluate('same.bytes[2]'), '255')
      assert.equal(
        await first.session.evaluate('[missingRunner,runnerReadRejected].join("|")'),
        '1|1',
      )
      const saves = first.session.exportSaves()
      for (const path of ['savedata/personal.txt', 'savedata/appdata.txt', 'savedata/state.bin'])
        assert.ok(
          saves.some((file) => file.path === path),
          `Expected exported ${path}`,
        )
      assert.equal(
        await readText(saves.find((file) => file.path === 'savedata/personal.txt')!.bytes),
        'personal\r\n保存 🌸\r\n',
      )
    } finally {
      await first.session.stop()
    }
    assert.equal(first.session.snapshot().handles, 0)

    const second = await fixture(
      binary,
      `
var personal=[].load(System.personalPath+"personal.txt"),appdata=[].load(System.appDataPath+"appdata.txt");
var state=Dictionary.loadStruct(System.dataPath+"state.bin");
var fresh=[System.exceptionHandler===null,System.onActivate===null,System.onDeactivate===null].join("|");
`,
      { saveStore: store },
    )
    try {
      assert.equal(await second.session.evaluate('personal[1]'), '保存 🌸')
      assert.equal(await second.session.evaluate('appdata[1]'), '次の行')
      assert.equal(await second.session.evaluate('state.large'), '9007199254740993')
      assert.equal(await second.session.evaluate('state.text'), '保存 🌸')
      assert.equal(await second.session.evaluate('state.bytes[2]'), '255')
      assert.equal(await second.session.evaluate('fresh'), '1|1|1')
      assert.equal(await second.session.evaluate('System.title'), 'krkr2-web')
      assert.equal(await second.session.evaluate('System.versionString'), '0.0.0.0')
    } finally {
      await second.session.stop()
    }
    assert.equal(second.session.snapshot().handles, 0)

    // Browser tests cover gameId -> IndexedDB partitioning. Here an independent
    // injected store must not accidentally inherit the previous VM's overlay.
    const independent = await fixture(
      binary,
      'var exists=Storages.isExistentStorage(System.dataPath+"state.bin");',
      { saveStore: new MemorySaveStore() },
    )
    try {
      assert.equal(await independent.session.evaluate('exists'), '0')
    } finally {
      await independent.session.stop()
    }
    assert.equal(independent.session.snapshot().handles, 0)
  })

  const dataPaths = [
    ['relative', 'profile/../slots', 'slots/'],
    ['Windows separators', 'records\\chapter\\..\\日本語', 'records/日本語/'],
    ['exepath macro', '$(exepath)/slots', 'slots/'],
    ['personalpath macro', '$(personalpath)/personal', 'savedata/personal/'],
    ['appdatapath macro', '$(appdatapath)/application', 'savedata/application/'],
    ['vistapath macro', '$(vistapath)/vista', 'savedata/vista/'],
    ['virtual root', 'folder/..', ''],
    ['maximum normalized directory length', 'x'.repeat(4095), 'x'.repeat(4095) + '/'],
  ] as const

  for (const [description, configured, expected] of dataPaths)
    test(`System startup datapath ${description} directs persistent I/O and is not recomputed by setArgument (${mode})`, async () => {
      const store = new MemorySaveStore(),
        args = new Map([
          ['-datapath', configured],
          ['-forcelog', 'yes'],
        ])
      const first = await fixture(
        binary,
        `
var initial=System.dataPath,argument=System.getArgument("-datapath");
["configured path","保存 🌸"].save(System.dataPath+"configured.txt");
Debug.message("system-core-before-path-change 雪 🌸");
System.setArgument("-datapath","changed/elsewhere");
var after=System.dataPath,changed=System.getArgument("-datapath");
Debug.message("system-core-after-path-change 雪 🌸");
`,
        { saveStore: store, arguments: args },
      )
      try {
        assert.equal(await first.session.evaluate('initial'), expected)
        assert.equal(await first.session.evaluate('argument'), configured)
        assert.equal(await first.session.evaluate('after'), expected)
        assert.equal(await first.session.evaluate('changed'), 'changed/elsewhere')
        assert.equal(args.get('-datapath'), configured, 'Session owns its argument map')
        const files = first.session.exportSaves(),
          save = files.find((file) => file.path === `${expected}configured.txt`),
          log = files.find((file) => file.path === `${expected}krkr.console.log`)
        assert.ok(save)
        assert.equal(await readText(save.bytes), 'configured path\r\n保存 🌸\r\n')
        assert.ok(log, 'The forced log must use the initialized dataPath')
        assert.deepEqual([...log.bytes.subarray(0, 2)], [255, 254], 'Log output is UTF-16LE')
        const logText = await readText(log.bytes)
        assert.ok(logText.includes('system-core-before-path-change 雪 🌸'))
        assert.ok(logText.includes('system-core-after-path-change 雪 🌸'))
        assert.equal(
          files.some((file) => file.path === 'changed/elsewhere/krkr.console.log'),
          false,
        )
        assert.equal(first.session.snapshot().pendingSaves, 0)
      } finally {
        await first.session.stop()
      }
      assert.equal(first.session.snapshot().handles, 0)

      const second = await fixture(
        binary,
        `
var loaded=[].load(System.dataPath+"configured.txt");
var logLines=[].load(System.dataPath+"krkr.console.log");
var previousLog=logLines.join("\\n").indexOf("system-core-after-path-change 雪 🌸")>=0;
`,
        { saveStore: store, arguments: args },
      )
      try {
        assert.equal(await second.session.evaluate('System.dataPath'), expected)
        assert.equal(await second.session.evaluate('loaded[1]'), '保存 🌸')
        assert.equal(await second.session.evaluate('previousLog'), '1')
      } finally {
        await second.session.stop()
      }
      assert.equal(second.session.snapshot().handles, 0)
    })
}

for (const [description, path] of [
  ['absolute Unix path', '/outside'],
  ['absolute Windows path', 'C:\\outside'],
  ['Windows scheme exposed by dot normalization', './C:\\outside'],
  ['UNC path', '\\\\server\\share'],
  ['URL', 'https://example.test/save'],
  ['URL scheme with a digit', 'v1://save'],
  ['extended URL scheme exposed by parent normalization', 'inside/../web+file://host/save'],
  ['URL scheme exposed by parent normalization', 'inside/../https://example.test/save'],
  ['parent traversal', '../outside'],
  ['normalized parent traversal', 'inside/../../outside'],
  ['archive-qualified path', 'game.xp3>savedata'],
  ['NUL character', 'savedata/\u0000outside'],
  ['unknown macro', '$(unknown)/save'],
  ['unterminated macro', '$(exepath/save'],
  ['directory exceeding the normalized length limit', 'x'.repeat(4096)],
] as const)
  test(`System rejects startup datapath ${description} before constructing a VM`, async () => {
    let runtimeCalls = 0
    await assert.rejects(
      headless(
        {},
        {
          arguments: new Map([['-datapath', path]]),
          async createRuntime() {
            runtimeCalls++
            throw new Error('Invalid datapath must be rejected before createRuntime')
          },
        },
      ),
      (error: unknown) => error instanceof Error && !error.message.includes('before createRuntime'),
    )
    assert.equal(runtimeCalls, 0)
  })

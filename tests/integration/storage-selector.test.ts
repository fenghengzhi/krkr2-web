import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { headless } from '../helpers/headless.ts'
import { observeNative } from '../helpers/bytecode-lifetime.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import type { EngineEvent, EngineSession, SessionDependencies } from '../../src/engine/session.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
type DialogEvent = Extract<EngineEvent, { type: 'system-dialog' }>
type DialogRequest = NonNullable<DialogEvent['request']>
type SelectorRequest = Extract<DialogRequest, { kind: 'storage-selector' }>
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
interface Pending<T> {
  result: Promise<Outcome<T>>
  settled(): boolean
}

class Clock {
  time = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { run, at: this.time + delay }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number) {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
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

async function succeeded<T>(pending: Pending<T>, description = 'storage selector'): Promise<T> {
  const outcome = await bounded(pending.result, description)
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

const definitions = String.raw`
System.exitOnWindowClose=false;
var trace=[];
function mark(text){trace.add(text);Debug.message(text);}
class SelectorWindow extends Window {
  var label,keyHandler=null,queries=0;
  function SelectorWindow(label){super.Window();this.label=label;caption=label;
    setInnerSize(64,48);visible=true;}
  function onKeyDown(key,shift){mark(label+":key:"+key);if(keyHandler!==null)keyHandler(key);}
  function onCloseQuery(canClose){queries++;super.onCloseQuery(true);}
}
`

async function fixture(
  binary: boolean,
  body: string,
  options: { startup?: boolean; windows?: boolean; dataPath?: string; emptySaves?: boolean } = {},
  overrides: Partial<SessionDependencies> = {},
) {
  const clock = new Clock(),
    pending: Promise<unknown>[] = []
  const track = <T>(promise: Promise<T>): Pending<T> => {
    let settled = false
    const result = promise.then<Outcome<T>, Outcome<T>>(
      (value) => {
        settled = true
        return { ok: true, value }
      },
      (error: unknown) => {
        settled = true
        return { ok: false, error }
      },
    )
    // Stop can reject the original input or evaluation while a getter or a
    // nested modal still owns its native stack. Observe it immediately.
    pending.push(result)
    return { result, settled: () => settled }
  }
  const source =
    definitions +
    (options.windows
      ? '\nvar a=new SelectorWindow("selector-A"),b=new SelectorWindow("selector-B");\n'
      : '') +
    body
  let compiled: Uint8Array | undefined
  if (binary && options.emptySaves) {
    // Compile in a separate VM so the real target Session begins with no save
    // entries. Writing the fixture's bytecode into that target would otherwise
    // mask the first-save directory case this option is intended to exercise.
    const compiler = await headless({
      'startup.tjs':
        'Scripts.compileStorage("storage-selector.tjs","compiled/storage-selector.cjs",false,true,false);',
      'storage-selector.tjs': source,
    })
    try {
      await bounded(compiler.session.start(), 'prepare mounted selector bytecode')
      compiled = compiler.session
        .exportSaves()
        .find((file) => file.path === 'compiled/storage-selector.cjs')
        ?.bytes.slice()
      assert.ok(compiled && compiled.length > 0)
    } finally {
      await bounded(compiler.session.stop(), 'stop bytecode preparation Session')
    }
  }
  const harness = await headless(
    {
      'startup.tjs':
        (binary
          ? compiled
            ? 'Scripts.execStorage("storage-selector.cjs");'
            : 'Scripts.compileStorage("storage-selector.tjs","savedata/storage-selector.cjs",false,true,false);Scripts.execStorage("savedata/storage-selector.cjs");'
          : 'Scripts.execStorage("storage-selector.tjs");') +
        (options.startup ? 'run();mark("startup:after");' : ''),
      'storage-selector.tjs': source,
      ...(compiled ? { 'storage-selector.cjs': compiled } : {}),
      'scripts/chosen.tjs': 'global.selectedScript=42;',
      'scripts/expression.tjs': '6*7',
      'case/Foo.tjs': '"upper mounted"',
      'case/foo.tjs': '"lower mounted"',
      'Fold/a.tjs': '"unique mounted"',
      'fold/b.tjs': '"other mounted"',
      'scenario/member.tjs': '"mounted flat"',
      'pack.xp3>scenario/member.tjs': '"archive member"',
      'nested/folder/readme.txt': 'A real mounted file',
    },
    {
      now: clock.now,
      schedule: clock.schedule,
      ...(options.dataPath ? { arguments: new Map([['-datapath', options.dataPath]]) } : {}),
      ...overrides,
    },
  )
  const { session, logs, events } = harness
  const dialogState = (): DialogEvent | undefined =>
    [...events].reverse().find((event): event is DialogEvent => event.type === 'system-dialog')
  const dialog = () => dialogState()?.request ?? undefined
  const until = async (
    predicate: () => boolean,
    description: string,
    opening?: Pending<unknown>,
  ) => {
    const deadline = performance.now() + 10000
    while (!predicate()) {
      if (opening?.settled())
        assert.fail(
          `Storage selector ended before ${description}: ${JSON.stringify(await opening.result)}; ${logs.join('|')}`,
        )
      assert.ok(
        performance.now() < deadline,
        `Timed out waiting for ${description}: ${JSON.stringify(session.inspectOwnership())}; ${logs.join('|')}`,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  const waitDialog = async (
    caption: string,
    depth: number,
    opening: Pending<unknown>,
    previous?: number,
  ): Promise<DialogRequest> => {
    await until(
      () =>
        dialog()?.caption === caption &&
        dialog()?.id !== previous &&
        session.inspectOwnership().modalScopes === depth &&
        session.inspectOwnership().modalWaits === 1,
      `${caption} at modal depth ${depth}`,
      opening,
    )
    assert.equal(opening.settled(), false)
    return dialog()!
  }
  const waitSelector = async (
    caption: string,
    depth: number,
    opening: Pending<unknown>,
    previous?: number,
  ): Promise<SelectorRequest> => {
    const request = await waitDialog(caption, depth, opening, previous)
    assert.equal(request.kind, 'storage-selector')
    assert.ok(request.kind === 'storage-selector')
    return request
  }
  const settled = async <T>(opening: Pending<T>): Promise<T> => {
    const value = await succeeded(opening)
    await bounded(session.idle(), 'settle storage selector cleanup')
    for (const owner of ['modalScopes', 'modalWaits', 'eventReceipts', 'eventCheckpoints'] as const)
      assert.equal(session.inspectOwnership()[owner], 0, owner)
    assert.equal(dialog(), undefined)
    assert.deepEqual(dialogState()?.pendingIds ?? [], [])
    return value
  }
  const stop = async () => {
    await bounded(session.stop(), 'stop storage selector Session')
    await bounded(Promise.all(pending), 'settle cancelled storage selector operations')
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert.ok(
      Object.values(session.inspectOwnership()).every((count) => count === 0),
      JSON.stringify(session.inspectOwnership()),
    )
    assert.equal(clock.tasks.size, 0)
    assert.equal(dialog(), undefined)
    assert.deepEqual(dialogState()?.pendingIds ?? [], [])
  }
  const view = (caption: string) => {
    const window = session.snapshot().windows?.find((entry) => entry.view.caption === caption)
    assert.ok(window, `Missing Window ${caption}`)
    return window
  }
  try {
    const starting = track(session.start())
    if (options.startup)
      await until(
        () => !!dialog() && session.inspectOwnership().modalWaits === 1,
        'startup storage selector',
        starting,
      )
    else {
      await succeeded(starting, 'start storage selector fixture')
      await bounded(session.idle(), 'settle storage selector fixture startup')
    }
    return {
      ...harness,
      clock,
      track,
      dialogState,
      dialog,
      until,
      waitDialog,
      waitSelector,
      settled,
      stop,
      starting,
      view,
      open: (expression = 'run()') => track(session.evaluate(expression)),
      respond: (request: DialogRequest, value: string | null) =>
        session.selectSystemDialog(request.id, value),
      choose: (
        request: SelectorRequest,
        name: string,
        filterIndex = request.selector.filterIndex,
        overwrite = false,
      ) => session.selectSystemDialog(request.id, JSON.stringify({ name, filterIndex, overwrite })),
      key(caption: string, key: number) {
        const admission = session.acceptInput({
          type: 'keyDown',
          windowId: view(caption).id,
          key,
          shift: 0,
        })
        return { status: admission.status, ...track(admission.completion) }
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}

function before(logs: string[], first: string, second: string) {
  assert.ok(logs.includes(first), `Missing ${first}: ${logs.join('|')}`)
  assert.ok(logs.includes(second), `Missing ${second}: ${logs.join('|')}`)
  assert.ok(logs.indexOf(first) < logs.indexOf(second), `${first} must precede ${second}`)
}

/** Read-only observation of the existing native limit; no budget or allocator hooks. */
async function observeSelectorExecution() {
  const directory = resolve('.generated/wasm'),
    manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')),
    assets = manifest.variants.asyncify!
  const { default: factory } = (await import(
    pathToFileURL(resolve(directory, assets.mjs.file)).href
  )) as { default: ModuleFactory }
  const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file))),
    native = observeNative(factory),
    budget = () => ({
      depth: native.call('krkr_vm_execution_stat', 0),
      bytes: native.call('krkr_vm_execution_stat', 1),
      functions: native.call('krkr_vm_execution_stat', 8),
      tries: native.call('krkr_vm_execution_stat', 9),
      delegations: native.call('krkr_vm_execution_stat', 10),
      functionLimit: native.call('krkr_vm_execution_stat', 12),
      peakFunctions: native.call('krkr_vm_execution_stat', 14),
    })
  let session: EngineSession | undefined, dialog: (() => DialogRequest | undefined) | undefined
  const snapshot = () => ({
    budget: budget(),
    ownership: session?.inspectOwnership(),
    request: dialog?.(),
  })
  const opened: (ReturnType<typeof snapshot> & { kind: string; token?: number })[] = [],
    caught: ReturnType<typeof snapshot>[] = [],
    waits: number[] = [],
    sampledFunctions: number[] = []
  const createRuntime: SessionDependencies['createRuntime'] = (handler, control, options) =>
    TjsWasmRuntime.create(
      native.factory,
      async (operation, args, context) => {
        if (operation === 'SelectorBudget.functions') {
          const functions = native.call('krkr_vm_execution_stat', 8)
          sampledFunctions.push(functions)
          return { kind: 'value', value: BigInt(functions) }
        }
        if (operation === 'SelectorBudget.afterCatch') {
          caught.push(snapshot())
          return { kind: 'value', value: undefined }
        }
        if (operation === 'Modal.wait' && typeof args[0] === 'bigint') waits.push(Number(args[0]))
        // Every production operation, including opening, waiting, cancellation
        // and cleanup, retains the real EngineSession handler and reply.
        const reply = await handler(operation, args, context)
        if (operation === 'Storages.selectFile')
          opened.push({
            ...snapshot(),
            kind: reply.kind,
            token:
              reply.kind === 'invoke' && typeof reply.args[0] === 'bigint'
                ? Number(reply.args[0])
                : undefined,
          })
        return reply
      },
      { control, wasmBinary, ...options },
    )
  return {
    createRuntime,
    attach(owner: EngineSession, currentDialog: () => DialogRequest | undefined) {
      session = owner
      dialog = currentDialog
    },
    budget,
    opened,
    caught,
    waits,
    sampledFunctions,
    assertIdle() {
      const state = budget()
      for (const field of ['depth', 'bytes', 'functions', 'tries', 'delegations'] as const)
        assert.equal(state[field], 0, JSON.stringify(state))
      assert.equal(state.functionLimit, 128)
      assert.equal(state.peakFunctions, 128)
    },
  }
}

const selectorAtFunctionLimit = String.raw`
var depthOptions=%[title:"Rejected at function limit"];
function selectAtFunctionLimit(remaining){
  if(__host("SelectorBudget.functions")==128)return Storages.selectFile(depthOptions);
  if(remaining<=0)throw new Exception("Did not reach the observed function limit");
  return selectAtFunctionLimit(remaining-1);
}
`

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: Storages.selectFile returns an existing mounted public name usable by Scripts.execStorage`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var selectedScript=0;
var params=%[name:"scripts/../scripts/chosen.tjs",initialDir:"nested/folder/",title:"Open script",
  filter:["Scripts|*.tjs","All|*.*"],filterIndex:2];
function run(){var result=Storages.selectFile(params);Scripts.execStorage(params.name);
  return int(result===1)+"|"+params.name+"|"+params.filterIndex+"|"+selectedScript;}
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitSelector('Open script', 1, opening)
      assert.equal(request.selector.save, false)
      assert.equal(request.selector.name, 'game://./scripts/chosen.tjs')
      // A supplied filename's directory takes precedence over initialDir.
      assert.equal(request.selector.initialDirectory, 'game://./scripts/')
      assert.deepEqual(request.selector.filters, [
        { label: 'Scripts', pattern: '*.tjs' },
        { label: 'All', pattern: '*.*' },
      ])
      assert.equal(request.selector.filterIndex, 2)
      assert.ok(
        request.selector.entries.some((entry) => entry.name === 'game://./scripts/chosen.tjs'),
      )
      assert.equal(f.choose(request, 'game://./scripts/chosen.tjs', 1), true)
      assert.equal(await f.settled(opening), '1|game://./scripts/chosen.tjs|1|42')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: opening distinguishes an archive member from a writable flat overlay with the same suffix`, async () => {
    const f = await fixture(
      binary,
      String.raw`
['"saved flat"'].save("scenario/member.tjs");
function run(){var params=%[title:"Archive",initialDir:"pack.xp3>scenario/",filter:"All|*.*"];
  var first=Storages.selectFile(params),archive=Scripts.evalStorage(params.name);
  params.title="Overlay";var second=Storages.selectFile(params);
  return first+"|"+archive+"|"+second+"|"+Scripts.evalStorage(params.name);}
`,
    )
    try {
      const opening = f.open(),
        archive = await f.waitSelector('Archive', 1, opening)
      assert.equal(archive.selector.initialDirectory, 'game://./pack.xp3>scenario/')
      assert.ok(
        archive.selector.entries.some(
          (entry) => entry.name === 'game://./pack.xp3>scenario/member.tjs' && entry.archive,
        ),
      )
      for (const directory of [
        'game://./',
        'game://./nested/',
        'game://./nested/folder/',
        'game://./savedata/',
      ])
        assert.ok(archive.selector.directories.includes(directory), directory)
      assert.equal(f.choose(archive, 'game://./pack.xp3>scenario/member.tjs'), true)
      const overlay = await f.waitSelector('Overlay', 1, opening)
      assert.equal(f.choose(overlay, 'game://./scenario/member.tjs'), true)
      assert.equal(await f.settled(opening), '1|archive member|1|saved flat')
      assert.ok(f.session.exportSaves().every((file) => !file.path.includes('>')))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: the first save can select a custom System.dataPath before a real Dictionary stream creates any file`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var params=%[title:"Save state",save:true,name:System.dataPath+"state",defaultExt:"kdt",filter:"State|*.kdt"];
function run(){var result=Storages.selectFile(params);
  return int(result===1)+"|"+params.name+"|"+int(Storages.isExistentStorage(params.name));}
function writeSelected(){var state=%[text:"保存・雪😀",counter:37];
  (Dictionary.saveStruct incontextof state)(params.name,"b");
  var loaded=Dictionary.loadStruct(params.name);return loaded.text+"|"+loaded.counter;}
`,
      { dataPath: 'user/custom-slots/', emptySaves: true },
    )
    try {
      const beforeFiles = f.session.exportSaves(),
        opening = f.open(),
        request = await f.waitSelector('Save state', 1, opening)
      assert.deepEqual(beforeFiles, [])
      assert.equal(request.selector.save, true)
      assert.equal(request.selector.defaultExtension, 'kdt')
      assert.equal(request.selector.initialDirectory, 'game://./user/custom-slots/')
      for (const directory of ['game://./', 'game://./user/', 'game://./user/custom-slots/'])
        assert.ok(request.selector.directories.includes(directory), directory)
      assert.ok(!request.selector.entries.some((entry) => entry.name.startsWith('game://./user/')))
      assert.equal(f.choose(request, 'game://./user/custom-slots/state'), true)
      assert.equal(await f.settled(opening), '1|game://./user/custom-slots/state.kdt|0')
      assert.deepEqual(f.session.exportSaves(), beforeFiles)
      assert.equal(await f.session.evaluate('writeSelected()'), '保存・雪😀|37')
      const stored = f.session
        .exportSaves()
        .find((file) => file.path === 'user/custom-slots/state.kdt')
      assert.ok(stored && stored.bytes.length > 0)
      assert.ok(f.session.exportSaves().every((file) => !file.path.includes('://')))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: cancelling selectFile keeps caller spelling and filterIndex and never invokes writeback setters`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var writes=[];
class Options {
  var title="Cancel",filter="Scripts|*.tjs",rawName="scripts/./chosen.tjs",rawIndex=99;
  property name {getter(){return rawName;}setter(value){writes.add("name");rawName=value;}}
  property filterIndex {getter(){return rawIndex;}setter(value){writes.add("index");rawIndex=value;}}
}
var params=new Options();
function run(){var result=Storages.selectFile(params);
  return int(result===0)+"|"+params.rawName+"|"+params.rawIndex+"|"+writes.count;}
`,
    )
    try {
      const beforeFiles = f.session.exportSaves(),
        opening = f.open(),
        request = await f.waitSelector('Cancel', 1, opening)
      assert.equal(request.selector.name, 'game://./scripts/chosen.tjs')
      assert.equal(request.selector.filterIndex, 1)
      assert.equal(f.respond(request, null), true)
      assert.equal(f.respond(request, null), false)
      assert.equal(await f.settled(opening), '1|scripts/./chosen.tjs|99|0')
      assert.deepEqual(f.session.exportSaves(), beforeFiles)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: malformed or nonexistent open choices preserve the suspended request for a valid retry`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var params=%[title:"Retry",filter:"Scripts|*.tjs",name:"scripts/chosen.tjs"];
function run(){var result=Storages.selectFile(params);return result+"|"+params.name;}
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitSelector('Retry', 1, opening)
      const invalid = [
        '{',
        'null',
        JSON.stringify({ name: 42, filterIndex: 1, overwrite: false }),
        JSON.stringify({ name: 'game://./scripts/chosen.tjs', filterIndex: 0, overwrite: false }),
        JSON.stringify({ name: 'game://./scripts/chosen.tjs', filterIndex: 2, overwrite: false }),
        JSON.stringify({ name: 'game://./scripts/missing.tjs', filterIndex: 1, overwrite: false }),
        JSON.stringify({ name: 'game://./scripts/', filterIndex: 1, overwrite: false }),
        JSON.stringify({ name: 'game://./nested/folder', filterIndex: 1, overwrite: false }),
        JSON.stringify({ name: 'game://./NESTED/FOLDER', filterIndex: 1, overwrite: false }),
        JSON.stringify({ name: '../outside.tjs', filterIndex: 1, overwrite: false }),
        JSON.stringify({
          name: 'https://example.invalid/scene.tjs',
          filterIndex: 1,
          overwrite: false,
        }),
      ]
      for (const choice of invalid) {
        assert.throws(() => f.respond(request, choice), choice)
        assert.equal(f.dialog()?.id, request.id)
        assert.equal(opening.settled(), false)
        assert.deepEqual(f.dialogState()?.pendingIds, [request.id])
      }
      assert.equal(f.choose(request, 'game://./scripts/chosen.tjs'), true)
      assert.equal(await f.settled(opening), '1|game://./scripts/chosen.tjs')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: ambiguous folded mounted and save names require an exact existing spelling`, async () => {
    // Seed distinct persisted identities: a second case-only WRITE resolves
    // the existing target and therefore cannot create this ambiguous pair.
    const saveStore = new MemorySaveStore()
    await saveStore.commit([
      { path: 'savedata/Slot.txt', bytes: new TextEncoder().encode('upper save\n') },
      { path: 'savedata/slot.txt', bytes: new TextEncoder().encode('lower save\n') },
    ])
    const f = await fixture(
      binary,
      String.raw`
["unique save"].save("Saved/a.txt");["other save"].save("saved/b.txt");
function run(){var params=%[title:"Case mounted"];
  Storages.selectFile(params);var first=Scripts.evalStorage(params.name);
  params.title="Case save";Storages.selectFile(params);
  var second=params.name+"|"+[].load(params.name)[0];
  params.title="Unique mounted";params.name="game://./FOLD/a.tjs";Storages.selectFile(params);
  var third=params.name+"|"+Scripts.evalStorage(params.name);
  params.title="Unique save";params.name="game://./SAVED/a.txt";Storages.selectFile(params);
  return first+"|"+second+"|"+third+"|"+params.name+"|"+[].load(params.name)[0];}
`,
      {},
      { saveStore },
    )
    try {
      const opening = f.open(),
        mounted = await f.waitSelector('Case mounted', 1, opening)
      assert.throws(() => f.choose(mounted, 'game://./case/FOO.tjs'), /ambiguous/i)
      assert.equal(f.dialog()?.id, mounted.id)
      assert.equal(f.choose(mounted, 'game://./case/Foo.tjs'), true)
      const saved = await f.waitSelector('Case save', 1, opening)
      assert.throws(() => f.choose(saved, 'game://./savedata/SLOT.TXT'), /ambiguous/i)
      assert.equal(f.dialog()?.id, saved.id)
      assert.equal(f.choose(saved, 'game://./savedata/slot.txt'), true)
      // The complete name resolves uniquely even though its directory prefix
      // has two folded matches. Do not reject before resolving the file.
      const uniqueMounted = await f.waitSelector('Unique mounted', 1, opening)
      assert.equal(uniqueMounted.selector.initialDirectory, 'game://./Fold/')
      assert.equal(f.choose(uniqueMounted, 'game://./FOLD/a.tjs'), true)
      const uniqueSave = await f.waitSelector('Unique save', 1, opening)
      assert.equal(uniqueSave.selector.initialDirectory, 'game://./Saved/')
      assert.equal(f.choose(uniqueSave, 'game://./SAVED/a.txt'), true)
      assert.equal(
        await f.settled(opening),
        'upper mounted|game://./savedata/slot.txt|lower save|game://./Fold/a.tjs|unique mounted|game://./Saved/a.txt|unique save',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: save overwrite confirmation covers both mounted files and a file created while the selector waits`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var params=%[title:"Mounted overwrite",save:true,filter:"All|*.*"];
var timer=new Timer(function(){timer.enabled=false;["created while waiting"].save("savedata/late.txt");mark("late:created");},"");timer.interval=10;
function run(){var first=Storages.selectFile(params);params.title="Late overwrite";timer.enabled=true;
  var second=Storages.selectFile(params);return first+"|"+second+"|"+params.name;}
`,
    )
    try {
      const opening = f.open(),
        mounted = await f.waitSelector('Mounted overwrite', 1, opening)
      assert.throws(() => f.choose(mounted, 'game://./scripts/chosen.tjs'))
      assert.equal(f.dialog()?.id, mounted.id)
      assert.equal(f.choose(mounted, 'game://./scripts/chosen.tjs', 1, true), true)
      const late = await f.waitSelector('Late overwrite', 1, opening)
      assert.ok(!late.selector.entries.some((entry) => entry.name === 'game://./savedata/late.txt'))
      f.clock.advance(10)
      await f.until(
        () => f.logs.includes('late:created'),
        'Timer writes save during selector',
        opening,
      )
      assert.throws(() => f.choose(late, 'game://./savedata/late.txt'))
      assert.equal(f.dialog()?.id, late.id)
      assert.equal(f.choose(late, 'game://./savedata/late.txt', 1, true), true)
      assert.equal(await f.settled(opening), '1|1|game://./savedata/late.txt')
      assert.equal(
        await f.session.evaluate('[].load("savedata/late.txt")[0]'),
        'created while waiting',
      )
      assert.equal(await f.session.evaluate('Scripts.evalStorage("scripts/expression.tjs")'), '42')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: save choices reject archive writes and missing directories without creating either`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var params=%[title:"Writable destination",save:true,initialDir:"missing/directory/",defaultExt:"kdt"];
function run(){var result=Storages.selectFile(params);return result+"|"+params.name+"|"+params.filterIndex;}
`,
    )
    try {
      const beforeFiles = f.session.exportSaves(),
        opening = f.open(),
        request = await f.waitSelector('Writable destination', 1, opening)
      assert.equal(request.selector.initialDirectory, 'game://./')
      assert.equal(request.selector.filterIndex, 0)
      for (const name of [
        'game://./pack.xp3>scenario/member.tjs',
        'game://./missing/directory/state',
        'game://./nested/folder.',
        'game://./NESTED/FOLDER.',
      ]) {
        assert.throws(() => f.choose(request, name, 0, true), name)
        assert.equal(f.dialog()?.id, request.id)
        assert.equal(opening.settled(), false)
      }
      // An explicit trailing dot suppresses the default extension; selecting
      // the name itself must still leave the persistent overlay unchanged.
      assert.equal(f.choose(request, 'game://./savedata/plain.', 0), true)
      assert.equal(await f.settled(opening), '1|game://./savedata/plain|0')
      assert.deepEqual(f.session.exportSaves(), beforeFiles)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a successful selector writes filterIndex before name and propagates a native setter exception`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var writes=[];
class Options {
  var title="Writeback",filter=["Scripts|*.tjs","All|*.*"],storedName="scripts/chosen.tjs",storedIndex=1;
  property filterIndex {getter(){return storedIndex;}setter(value){writes.add("index:"+value);storedIndex=value;}}
  property name {getter(){return storedName;}setter(value){writes.add("name:"+value);throw new Exception("name setter refused");}}
}
var params=new Options();
function run(){var caught=false;try{Storages.selectFile(params);}catch(error){caught=true;}
  return int(caught)+"|"+writes.join(",")+"|"+params.storedIndex+"|"+params.storedName;}
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitSelector('Writeback', 1, opening)
      assert.equal(f.choose(request, 'game://./scripts/expression.tjs', 2), true)
      assert.equal(
        await f.settled(opening),
        '1|index:2,name:game://./scripts/expression.tjs|2|scripts/chosen.tjs',
      )
      assert.equal(f.respond(request, null), false)
      assert.equal(await f.session.evaluate('Scripts.evalStorage("scripts/expression.tjs")'), '42')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a getter and a writeback setter can each run another selector before the outer native call completes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
class Options {
  var title="Outer selector",filter=["Scripts|*.tjs","All|*.*"],storedIndex=1,storedName="unchanged";
  property filterIndex {
    getter(){return storedIndex;}
    setter(value){mark("index:before:"+value);var nested=%[title:"Index setter selector"];
      var result=Storages.selectFile(nested);mark("index:after:"+result+":"+nested.name);storedIndex=value;}
  }
  property name {
    getter(){mark("getter:before");var nested=%[title:"Name getter selector"];
      var result=Storages.selectFile(nested);mark("getter:after:"+result);return nested.name;}
    setter(value){mark("name:write:"+value);storedName=value;}
  }
}
function run(){var params=new Options(),result=Storages.selectFile(params);
  return result+"|"+params.storedIndex+"|"+params.storedName;}
`,
    )
    try {
      const opening = f.open(),
        getter = await f.waitSelector('Name getter selector', 1, opening)
      assert.deepEqual(f.dialogState()?.pendingIds, [getter.id])
      assert.equal(f.choose(getter, 'game://./scripts/chosen.tjs'), true)
      const outer = await f.waitSelector('Outer selector', 1, opening)
      assert.equal(outer.selector.name, 'game://./scripts/chosen.tjs')
      assert.equal(f.choose(outer, 'game://./scripts/expression.tjs', 2), true)
      const setter = await f.waitSelector('Index setter selector', 1, opening)
      // The outer dialog's response has already released its modal scope;
      // the native C++ call still waits for the original options setter.
      assert.deepEqual(f.dialogState()?.pendingIds, [setter.id])
      assert.equal(f.choose(outer, 'game://./scripts/chosen.tjs', 1), false)
      assert.ok(!f.logs.some((entry) => entry.startsWith('name:write:')))
      assert.equal(f.choose(setter, 'game://./pack.xp3>scenario/member.tjs'), true)
      assert.equal(await f.settled(opening), '1|2|game://./scripts/expression.tjs')
      before(f.logs, 'getter:before', 'getter:after:1')
      before(f.logs, 'getter:after:1', 'index:before:2')
      before(f.logs, 'index:before:2', 'index:after:1:game://./pack.xp3>scenario/member.tjs')
      before(
        f.logs,
        'index:after:1:game://./pack.xp3>scenario/member.tjs',
        'name:write:game://./scripts/expression.tjs',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a startup selector permits a Timer to nest System.inform and restores the same parent request`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("child:before");System.inform("Nested body","Child inform");mark("child:after");},"");timer.interval=10;
function run(){var local=["kept",37],params=%[title:"Startup selector"];timer.enabled=true;
  var result=Storages.selectFile(params);mark("parent:after:"+result+":"+local[0]+":"+local[1]);}
`,
      { startup: true },
    )
    try {
      const parent = await f.waitSelector('Startup selector', 1, f.starting)
      assert.deepEqual(f.session.snapshot().windows, [])
      f.clock.advance(10)
      const child = await f.waitDialog('Child inform', 2, f.starting)
      assert.equal(child.kind, 'inform')
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, child.id])
      assert.equal(f.choose(parent, 'game://./scripts/chosen.tjs'), false)
      assert.equal(f.respond(child, ''), true)
      const restored = await f.waitSelector('Startup selector', 1, f.starting)
      assert.equal(restored.id, parent.id)
      assert.equal(f.respond(child, ''), false)
      assert.equal(f.choose(restored, 'game://./scripts/chosen.tjs'), true)
      await f.settled(f.starting)
      before(f.logs, 'child:before', 'child:after')
      before(f.logs, 'child:after', 'parent:after:1:kept:37')
      before(f.logs, 'parent:after:1:kept:37', 'startup:after')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Timer selector nested inside System.inputString retains the parent result and native continuation`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;var params=%[title:"Child selector"];
  var result=Storages.selectFile(params);mark("child:"+result+":"+params.name);},"");timer.interval=10;
function run(){timer.enabled=true;var value=System.inputString("Parent input","Prompt","seed");mark("parent:"+value);return value;}
`,
    )
    try {
      const opening = f.open(),
        parent = await f.waitDialog('Parent input', 1, opening)
      f.clock.advance(10)
      const child = await f.waitSelector('Child selector', 2, opening)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, child.id])
      assert.equal(f.respond(parent, 'too early'), false)
      assert.equal(f.choose(child, 'game://./scripts/chosen.tjs'), true)
      const restored = await f.waitDialog('Parent input', 1, opening)
      assert.equal(restored.id, parent.id)
      assert.equal(restored.value, 'seed')
      assert.equal(f.choose(child, 'game://./scripts/expression.tjs'), false)
      assert.equal(f.respond(restored, 'parent value'), true)
      assert.equal(await f.settled(opening), 'parent value')
      before(f.logs, 'child:1:game://./scripts/chosen.tjs', 'parent:parent value')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a selector opened by a Window callback blocks other input until that original callback returns`, async () => {
    const f = await fixture(
      binary,
      String.raw`
a.keyHandler=function(key){if(key==65){var params=%[title:"Callback selector"];
  mark("callback:before");var result=Storages.selectFile(params);mark("callback:after:"+result);}};
`,
      { windows: true },
    )
    try {
      const callback = f.key('selector-A', 65)
      assert.equal(callback.status, 'accepted')
      const request = await f.waitSelector('Callback selector', 1, callback)
      for (const caption of ['selector-A', 'selector-B']) {
        assert.equal(f.view(caption).view.blocked, true)
        const input = f.key(caption, 66)
        assert.equal(input.status, 'ignored')
        await succeeded(input)
        const close = f.session.acceptCloseWindow(f.view(caption).id)
        assert.equal(close.status, 'ignored')
        await succeeded(f.track(close.completion))
      }
      assert.equal(f.respond(request, null), true)
      await f.settled(callback)
      before(f.logs, 'callback:before', 'callback:after:0')
      assert.ok(!f.logs.some((entry) => entry.endsWith(':key:66')))
      assert.equal(f.view('selector-B').view.blocked, false)
      await succeeded(f.key('selector-B', 67))
      assert.ok(f.logs.includes('selector-B:key:67'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: pausing rejects selector choices and cancel while preserving the same request on resume`, async () => {
    const f = await fixture(
      binary,
      String.raw`
function run(){var params=%[title:"Paused selector"];var result=Storages.selectFile(params);
  mark("after:"+result);return result+"|"+params.name;}
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitSelector('Paused selector', 1, opening)
      f.session.pause()
      await f.until(() => f.session.snapshot().state === 'paused', 'paused selector')
      assert.equal(f.choose(request, 'game://./scripts/chosen.tjs'), false)
      assert.equal(f.respond(request, null), false)
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('after:1'))
      f.session.resume()
      const restored = await f.waitSelector('Paused selector', 1, opening)
      assert.equal(restored.id, request.id)
      assert.equal(f.choose(restored, 'game://./scripts/chosen.tjs'), true)
      assert.equal(f.choose(restored, 'game://./scripts/expression.tjs'), false)
      assert.equal(await f.settled(opening), '1|game://./scripts/chosen.tjs')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: eventDisabled does not prevent a selector response or prematurely deliver deferred script events`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var ticks=0,fires=0;
var timer=new Timer(function(){ticks++;},"");timer.interval=10;
var trigger=new AsyncTrigger(function(){fires++;mark("trigger:delivered");},"");
function run(){System.eventDisabled=true;timer.enabled=true;trigger.trigger();
  var params=%[title:"Disabled selector"],result=Storages.selectFile(params);
  return result+"|"+ticks+"|"+fires+"|"+int(System.eventDisabled);}
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitSelector('Disabled selector', 1, opening)
      f.clock.advance(10)
      assert.equal(f.session.snapshot().eventDisabled, true)
      assert.ok(!f.logs.includes('trigger:delivered'))
      assert.equal(f.choose(request, 'game://./scripts/chosen.tjs'), true)
      assert.equal(await f.settled(opening), '1|0|0|1')
      assert.equal(
        await f.session.evaluate(
          '(function(){System.eventDisabled=false;return ticks+"|"+fires;})()',
        ),
        '0|1',
      )
      f.clock.advance(10)
      await f.session.idle()
      assert.equal(await f.session.evaluate('ticks+"|"+fires'), '1|1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Stop unwinds nested selectors and their opening Window input receipt and ignores all late choices`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;var params=%[title:"Stop child"];
  Storages.selectFile(params);mark("child:after-stop");},"");timer.interval=10;
a.keyHandler=function(key){if(key==65){var params=%[title:"Stop parent"];timer.enabled=true;
  Storages.selectFile(params);mark("parent:after-stop");}};
`,
      { windows: true },
    )
    try {
      const callback = f.key('selector-A', 65)
      assert.equal(callback.status, 'accepted')
      const parent = await f.waitSelector('Stop parent', 1, callback)
      f.clock.advance(10)
      const child = await f.waitSelector('Stop child', 2, callback)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, child.id])
      assert.ok(f.session.inspectOwnership().eventReceipts > 0)
      assert.ok(f.session.snapshot().handles > 0)
      await f.stop()
      assert.equal((await bounded(callback.result, 'cancel selector callback')).ok, false)
      assert.ok(!f.logs.includes('child:after-stop'))
      assert.ok(!f.logs.includes('parent:after-stop'))
      assert.equal(f.choose(child, 'game://./scripts/chosen.tjs'), false)
      assert.equal(f.respond(parent, null), false)
      assert.deepEqual(f.session.snapshot().windows, [])
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Stop inside a modal option getter cancels selectFile before later getters or writeback can run`, async () => {
    const f = await fixture(
      binary,
      String.raw`
class Options {
  var title="Must never open";
  property filter {
    getter(){mark("getter:before");System.inform("Suspended option getter","Getter modal");mark("getter:after-stop");return "All|*.*";}
  }
  property filterIndex {
    getter(){mark("index:read-after-stop");return 1;}
    setter(value){mark("index:write-after-stop");}
  }
  property name {
    getter(){mark("name:read-after-stop");return "scripts/chosen.tjs";}
    setter(value){mark("setter:after-stop");}
  }
}
var params=new Options();
function run(){Storages.selectFile(params);mark("select:after-stop");}
`,
    )
    try {
      const opening = f.open(),
        getter = await f.waitDialog('Getter modal', 1, opening)
      assert.equal(getter.kind, 'inform')
      assert.ok(f.logs.includes('getter:before'))
      assert.ok(
        !f.events.some(
          (event) => event.type === 'system-dialog' && event.request?.kind === 'storage-selector',
        ),
      )
      await f.stop()
      assert.equal((await bounded(opening.result, 'cancel modal option getter')).ok, false)
      for (const entry of [
        'getter:after-stop',
        'index:read-after-stop',
        'index:write-after-stop',
        'name:read-after-stop',
        'setter:after-stop',
        'select:after-stop',
      ])
        assert.ok(!f.logs.includes(entry), entry)
      assert.equal(f.respond(getter, ''), false)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a caught function limit before the selector pump starts releases its published scope and permits a fresh selector`, async () => {
    const observation = await observeSelectorExecution(),
      f = await fixture(
        binary,
        selectorAtFunctionLimit +
          String.raw`
function run(){var message="";
  try{selectAtFunctionLimit(128);}catch(error){message=error.message;}
  __host("SelectorBudget.afterCatch");return message;}
function recover(){var params=%[title:"Recovered selector"];
  var result=Storages.selectFile(params);return result+"|"+params.name;}
`,
        {},
        { createRuntime: observation.createRuntime },
      )
    observation.attach(f.session, f.dialog)
    try {
      assert.equal(observation.budget().functionLimit, 128)
      const baseline = f.session.inspectOwnership(),
        opening = f.open(),
        message = await f.settled(opening)
      assert.match(message, /VM function depth exceeds 128 frames/)
      assert.equal(observation.opened.length, 1)
      const rejected = observation.opened[0]!,
        rejectedRequest = rejected.request,
        token = rejected.token
      assert.ok(rejectedRequest?.kind === 'storage-selector')
      assert.equal(rejectedRequest.caption, 'Rejected at function limit')
      assert.equal(rejected.kind, 'invoke')
      assert.ok(typeof token === 'number')
      assert.equal(rejected.budget.functions, 128)
      assert.equal(rejected.ownership?.modalScopes, 1)
      assert.equal(rejected.ownership?.modalWaits, 0)
      assert.equal(observation.waits.includes(token), false)
      assert.ok(
        f.events.some(
          (event) => event.type === 'system-dialog' && event.request?.id === rejectedRequest.id,
        ),
        'The rejected native invoke must have actually published its selector',
      )
      assert.ok(
        observation.sampledFunctions.length > 1 && observation.sampledFunctions.length <= 128,
      )
      assert.equal(observation.sampledFunctions.at(-1), 128)
      assert.equal(observation.caught.length, 1)
      assert.equal(observation.caught[0]!.ownership?.modalScopes, 0)
      assert.equal(observation.caught[0]!.request, undefined)
      assert.deepEqual(f.session.inspectOwnership(), baseline)
      assert.equal(f.respond(rejectedRequest, null), false)
      observation.assertIdle()

      const recovering = f.open('recover()'),
        fresh = await f.waitSelector('Recovered selector', 1, recovering)
      assert.notEqual(fresh.id, rejectedRequest.id)
      assert.equal(f.choose(fresh, 'game://./scripts/chosen.tjs'), true)
      assert.equal(await f.settled(recovering), '1|game://./scripts/chosen.tjs')
      assert.deepEqual(f.session.inspectOwnership(), baseline)
      observation.assertIdle()
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Timer child rejected before its selector pump starts leaves its parent modal usable`, async () => {
    const observation = await observeSelectorExecution(),
      f = await fixture(
        binary,
        selectorAtFunctionLimit +
          String.raw`
var timer=new Timer(function(){timer.enabled=false;
  try{selectAtFunctionLimit(128);}catch(error){mark("child:caught:"+error.message);}
  __host("SelectorBudget.afterCatch");
  var params=%[title:"Recovered child"],result=Storages.selectFile(params);
  mark("child:recovered:"+result+":"+params.name);
},"");timer.interval=10;timer.enabled=false;
function run(){var params=%[title:"Budget parent"];timer.enabled=true;
  var result=Storages.selectFile(params);return result+"|"+params.name;}
`,
        {},
        { createRuntime: observation.createRuntime },
      )
    observation.attach(f.session, f.dialog)
    try {
      assert.equal(observation.budget().functionLimit, 128)
      const opening = f.open(),
        parent = await f.waitSelector('Budget parent', 1, opening),
        parentBudget = observation.budget()
      assert.ok(parentBudget.functions > 0)
      f.clock.advance(10)
      const fresh = await f.waitSelector('Recovered child', 2, opening),
        rejected = observation.opened.find(
          (entry) => entry.request?.caption === 'Rejected at function limit',
        )
      assert.ok(rejected)
      const rejectedRequest = rejected.request,
        token = rejected.token
      assert.ok(rejectedRequest?.kind === 'storage-selector')
      assert.equal(rejected.kind, 'invoke')
      assert.ok(typeof token === 'number')
      assert.equal(rejected.budget.functions, 128)
      assert.equal(rejected.ownership?.modalScopes, 2)
      assert.equal(rejected.ownership?.modalWaits, 0)
      assert.equal(observation.waits.includes(token), false)
      assert.ok(
        f.events.some(
          (event) => event.type === 'system-dialog' && event.request?.id === rejectedRequest.id,
        ),
      )
      assert.ok(
        f.logs.some((entry) => /child:caught:.*VM function depth exceeds 128 frames/.test(entry)),
      )
      assert.equal(observation.caught.length, 1)
      assert.equal(observation.caught[0]!.ownership?.modalScopes, 1)
      assert.equal(observation.caught[0]!.request?.id, parent.id)
      assert.ok(observation.caught[0]!.budget.functions > 0)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, fresh.id])
      assert.equal(f.respond(rejectedRequest, null), false)
      assert.equal(f.choose(parent, 'game://./scripts/chosen.tjs'), false)
      assert.equal(f.choose(fresh, 'game://./scripts/expression.tjs'), true)

      const restored = await f.waitSelector('Budget parent', 1, opening),
        restoredBudget = observation.budget()
      assert.equal(restored.id, parent.id)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id])
      assert.ok(f.logs.includes('child:recovered:1:game://./scripts/expression.tjs'))
      for (const field of ['depth', 'bytes', 'functions', 'tries', 'delegations'] as const)
        assert.equal(restoredBudget[field], parentBudget[field], `Restored parent ${field}`)
      assert.equal(f.choose(restored, 'game://./scripts/chosen.tjs'), true)
      assert.equal(await f.settled(opening), '1|game://./scripts/chosen.tjs')
      observation.assertIdle()
    } finally {
      await f.stop()
    }
  })
}

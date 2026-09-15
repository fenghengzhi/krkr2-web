import { expect, test, type Page, type Worker } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export const systemPrefix = 'system-core-proof:'
export const systemText = '存档の文字 😀 café'
export const systemAsset = '游戏资源 雪 Ω 😀'
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface SystemWorker {
  worker: Worker
  url: string
  closed: boolean
}
export interface SystemRandomProof {
  secure: boolean
  worker: boolean
  installed: boolean
  errors: string[]
  calls: number[][]
  dropped: number
}

// This is inserted as plain source, not a serialized transformed function.
// Every call still reaches the real Worker Web Crypto method exactly once,
// with its original receiver, arguments, return object and exception behavior.
// Only the bounded synthetic UUID samples used by this fixture are retained.
const observeRandomSource = `;(() => {
  const proof = {
    secure: isSecureContext,
    worker: typeof document === "undefined" && self instanceof DedicatedWorkerGlobalScope,
    installed: false, errors: [], calls: [], dropped: 0
  };
  Object.defineProperty(self, "__systemCoreRandomProof", {value: proof});
  try {
    const original = crypto.getRandomValues;
    Object.defineProperty(crypto, "getRandomValues", {
      configurable: true, writable: true,
      value: new Proxy(original, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          try {
            const bytes = args[0];
            if (bytes instanceof Uint8Array && bytes.length === 16) {
              if (proof.calls.length < 64) proof.calls.push(Array.from(bytes));
              else proof.dropped++;
            }
          } catch (error) { proof.errors.push(String(error)); }
          return result;
        }
      })
    });
    proof.installed = true;
  } catch (error) { proof.errors.push(String(error)); }
})();`

export async function prepareSystemPage(page: Page, backend: string, observeRandom = false) {
  const errors: string[] = [],
    workers: SystemWorker[] = [],
    routed: { url: string; originalSha256: string }[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('worker', (worker) => {
    if (!/\/session\.worker[-.]/.test(new URL(worker.url()).pathname)) return
    const entry = { worker, url: worker.url(), closed: false }
    workers.push(entry)
    worker.on('close', () => (entry.closed = true))
  })
  if (observeRandom)
    await page.context().route('**/assets/session.worker-*.js*', async (route) => {
      const response = await route.fetch(),
        bytes = await response.body()
      if (!response.ok()) throw new Error('The actual hosted Session Worker could not be read')
      routed.push({
        url: route.request().url(),
        originalSha256: createHash('sha256').update(bytes).digest('hex'),
      })
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'cache-control': 'no-store' },
        body: observeRandomSource + '\n' + bytes.toString('utf8'),
      })
    })
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' &&
      !(await page.evaluate(() => 'Suspending' in WebAssembly && 'promising' in WebAssembly)),
    'JSPI is not implemented by this browser',
  )
  return { errors, workers, routed }
}

export function systemMark(page: Page, message: string) {
  return page.getByText(systemPrefix + message, { exact: true })
}

export function systemFiles(binary: boolean, code: string, identity = 'same-game') {
  return [
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("system-core.tjs","savedata/system-core.cjs",false,true,false);Scripts.execStorage("savedata/system-core.cjs");'
          : 'Scripts.execStorage("system-core.tjs");',
      ),
    },
    { name: 'system-core.tjs', mimeType: 'text/plain', buffer: Buffer.from(code) },
    { name: 'scene-雪-Ω.txt', mimeType: 'text/plain', buffer: Buffer.from(systemAsset) },
    { name: 'identity.txt', mimeType: 'text/plain', buffer: Buffer.from(identity) },
  ]
}

export async function stopSystemPage(page: Page, errors: string[]) {
  if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
  await expect(page.locator('#status')).toHaveText('待机')
  await expect(page.locator('#choose-files')).toBeEnabled()
  await expect(page.locator('#evaluate')).toBeDisabled()
  await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
  await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
  expect(errors).toEqual([])
}

export interface SystemBackup {
  format: string
  version: number
  gameId: string
  files: { path: string; base64: string }[]
}
export async function exportSystemSaves(page: Page): Promise<SystemBackup> {
  await expect(page.locator('#evaluate')).toBeEnabled()
  await expect(page.locator('#save-status')).toContainText('已保存')
  await expect(page.locator('#export-saves')).toBeEnabled()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-saves').click(),
  ])
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as SystemBackup
}

export async function readSystemRandom(entry: SystemWorker): Promise<SystemRandomProof> {
  return entry.worker.evaluate(
    () =>
      (self as unknown as { __systemCoreRandomProof: SystemRandomProof }).__systemCoreRandomProof,
  )
}

/** Independent expected v4 formatting of the bytes observed after native Web Crypto. */
export function observedUuid(sample: number[]): string {
  const bytes = [...sample]
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export const systemIdentityProgram = `
function systemCheck(value,message){if(!value)throw "system-core:"+message;}
function systemMark(value){Debug.message("${systemPrefix}"+value);}
systemCheck(System instanceof "Class" && System instanceof "System" && System instanceof "Object","native-class");
systemCheck(!(System instanceof "Dictionary") && !(System instanceof "Function"),"not-dictionary-function");
systemCheck(System.createUUID instanceof "Function" && System.inform instanceof "Function","native-methods");
systemCheck(System.exceptionHandler===null && System.onActivate===null && System.onDeactivate===null,"initial-null-callbacks");
var directRejected=0,derivedRejected=0,missingRejected=0;
try{new System("ignored");}catch(e){directRejected=1;}
class SystemChild extends System {}
try{new SystemChild();}catch(e){derivedRejected=1;}
try{var missing=System.__system_core_missing_member__;}catch(e){missingRejected=1;}
systemCheck(directRejected && derivedRejected && missingRejected,"construction-or-missing-member");
System.System("ignored",void);System.finalize("ignored");
var pathReference=&System.dataPath,versionReference=&System.versionString;
systemCheck((&global.pathReference) instanceof "Property" && (&global.versionReference) instanceof "Property","native-properties");
var names=["exePath","exeName","dataPath","personalPath","appDataPath","versionString","versionInformation","platformName","osName"],values=[],rejected=0;
for(var i=0;i<names.count;i++){
  var name=names[i];values.add(System[name]);
  try{System[name]="must-not-replace";}catch(e){rejected++;}
  systemCheck(System[name]===values[i],"readonly-value:"+name);
}
systemCheck(rejected==names.count,"readonly-setters");
systemCheck(System.exePath=="" && System.exeName=="krkr2-web","virtual-executable");
systemCheck(System.dataPath=="savedata/" && System.personalPath=="savedata/" && System.appDataPath=="savedata/","save-aliases");
systemCheck(Storages.extractStoragePath(System.exeName)===System.exePath,"exe-path-prefix");
systemCheck(!Storages.isExistentStorage(System.exeName),"no-pretend-executable");
systemCheck(System.platformName=="Web" && System.osName=="Web","platform");
var originalTitle=System.title;System.title="System core title";
systemCheck(System.title=="System core title","writable-title");System.title=originalTitle;
System.exceptionHandler=function(e){return true;};System.onActivate=function(){};System.onDeactivate=function(){};
systemCheck(System.exceptionHandler instanceof "Function" && System.onActivate instanceof "Function" && System.onDeactivate instanceof "Function","writable-callbacks");
System.exceptionHandler=null;System.onActivate=null;System.onDeactivate=null;
function runSystemUUID(){
  var firstUuid=System.createUUID("ignored"),discardedArguments=0;
  System.createUUID(discardedArguments++);
  var secondUuid=System.createUUID();
  systemCheck(discardedArguments==1,"discarded-call-arguments");
  systemMark("uuid:first:"+firstUuid);systemMark("uuid:second:"+secondUuid);
  return "complete";
}
systemMark("version:"+System.versionString);systemMark("information:"+System.versionInformation);
systemMark("identity-ready");
`

export const systemPersistenceProgram = `
function systemCheck(value,message){if(!value)throw "system-core:"+message;}
function systemMark(value){Debug.message("${systemPrefix}"+value);}
systemCheck(System.exceptionHandler===null && System.onActivate===null && System.onDeactivate===null,"fresh-callbacks");
System.onActivate=function(){};System.onDeactivate=function(){};
var asset=[].load(System.exePath+"scene-雪-Ω.txt","utf-8");
systemCheck(asset[0]===${JSON.stringify(systemAsset)},"exe-path-resource");
var counterPath=System.dataPath+"system-counter.txt",textPath=System.personalPath+"system-text.txt",binaryPath=System.appDataPath+"system-binary.bin";
var prior=int(Storages.isExistentStorage(counterPath))+int(Storages.isExistentStorage(textPath))+int(Storages.isExistentStorage(binaryPath));
systemCheck(prior==0 || prior==3,"partial-alias-recovery");
var count=0;
if(prior){
  count=int([].load(counterPath,"utf-8")[0]);
  systemCheck([].load(textPath,"utf-8")[0]===${JSON.stringify(systemText)},"personal-path-recovered");
  var priorBinary=Scripts.evalStorage(binaryPath);
  systemCheck(priorBinary.large===9007199254740993 && priorBinary.text===${JSON.stringify(systemText)},"appdata-path-recovered");
}
[string(++count)].save(counterPath,"utf-8");
[${JSON.stringify(systemText)}].save(textPath,"utf-8");
var payload=%["large"=>9007199254740993,"text"=>${JSON.stringify(systemText)}];
(Dictionary.saveStruct incontextof payload)(binaryPath,"b");
systemCheck(int([].load(System.personalPath+"system-counter.txt","utf-8")[0])==count,"counter-alias-read");
systemCheck([].load(System.appDataPath+"system-text.txt","utf-8")[0]===${JSON.stringify(systemText)},"text-alias-read");
var binary=Scripts.evalStorage(System.dataPath+"system-binary.bin");
systemCheck(binary.large===9007199254740993 && binary.text===${JSON.stringify(systemText)},"binary-alias-read");
systemMark("persistence:"+prior+":"+count);
systemMark("version:"+System.versionString);systemMark("information:"+System.versionInformation);
systemMark("persistence-ready");
`

export interface SystemEmbeddingCounters {
  created: Record<string, number>
  installed: string[]
  errors: string[]
}
declare global {
  interface Window {
    systemEmbeddingCounters: SystemEmbeddingCounters
  }
}

/** Count real host acquisitions without changing constructor arguments or results. */
export async function observeSystemEmbeddingAcquisitions(page: Page) {
  await page.addInitScript(() => {
    const proof: SystemEmbeddingCounters = { created: {}, installed: [], errors: [] }
    window.systemEmbeddingCounters = proof
    const globals = window as unknown as Record<string, unknown>
    for (const name of ['MessageChannel', 'Worker', 'AudioContext', 'webkitAudioContext']) {
      const original = globals[name]
      if (typeof original !== 'function') continue
      proof.created[name] = 0
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          writable: true,
          value: new Proxy(original, {
            construct(target, args, newTarget) {
              const instance = Reflect.construct(target, args, newTarget)
              proof.created[name]++
              return instance
            },
          }),
        })
        proof.installed.push(name)
      } catch (error) {
        proof.errors.push(`${name}: ${String(error)}`)
      }
    }
  })
}

export const systemEmbeddingProgram = `
var initialPath=System.dataPath,initialArgument=System.getArgument("-datapath");
var path=initialPath+"embedding-counter.txt",count=0;
if(Storages.isExistentStorage(path))count=int([].load(path,"utf-8")[0]);
[string(++count)].save(path,"utf-8");
if(int([].load(path,"utf-8")[0])!=count)throw "embedding-read-after-write";
System.setArgument("-datapath","other");
if(System.dataPath!==initialPath)throw "embedding-dataPath-was-recomputed";
Debug.message("${systemPrefix}embedding:"+initialPath+":"+count);
`

/** The public embedding API creates every host and its own real Session Worker. */
export async function runSystemEmbedding(
  page: Page,
  entry: string,
  backend: 'asyncify' | 'jspi',
  dataPath?: string,
) {
  return page.evaluate(
    async ({ entry, backend, dataPath, source, readyPrefix }) => {
      const { createPlayer, createGameWindows } = (await import(entry)) as {
          createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
          createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
        },
        root = document.createElement('main'),
        canvas = document.createElement('canvas'),
        logs: string[] = [],
        errors: string[] = [],
        audio: string[] = []
      let signalReady!: () => void
      const ready = new Promise<void>((resolve) => (signalReady = resolve))
      root.id = 'system-embedding-root'
      root.append(canvas)
      document.body.append(root)
      const windows = createGameWindows(root, canvas, () => {}),
        options: import('../../src/player/create-player.ts').PlayerOptions = {
          windows,
          ...(dataPath === undefined ? {} : { dataPath }),
          onError: (error) => errors.push(String(error)),
        },
        supplied = Object.hasOwn(options, 'dataPath')
      let player: ReturnType<typeof createPlayer> | undefined
      try {
        player = createPlayer(
          canvas,
          (event) => {
            if (event.type === 'log') {
              logs.push(event.text)
              if (event.text.startsWith(readyPrefix)) signalReady()
            }
          },
          (state) => audio.push(state.state),
          false,
          options,
        )
        // The configured value belongs to this Player. Mutating the caller's
        // option object later must not change the not-yet-initialized Worker.
        if (supplied) options.dataPath = 'changed-before-load/'
        const loaded = await player.load(
          [{ path: 'startup.tjs', blob: new Blob([source], { type: 'text/plain' }) }],
          'startup.tjs',
          backend,
        )
        await ready
        const actual = await player.session.evaluate(
            '[initialPath,System.dataPath,System.getArgument("-datapath"),count,System.personalPath,System.appDataPath].join("|")',
          ),
          configuredArgument = await player.session.evaluate(
            'initialArgument===void ? "<absent>" : initialArgument',
          ),
          files = (await player.session.exportSaves()).map(({ path, bytes }) => ({
            path,
            bytes: Array.from(bytes),
          }))
        await player.stop()
        return {
          supplied,
          configured: dataPath,
          gameId: player.gameId,
          backend: loaded.backend,
          actual,
          configuredArgument,
          files,
          logs,
          errors,
          audio,
          disposed: player.session.isDisposed,
          liveWindows: root.querySelectorAll('.game-window').length,
        }
      } finally {
        try {
          await player?.stop()
        } finally {
          windows.dispose()
          root.remove()
        }
      }
    },
    {
      entry,
      backend,
      dataPath,
      source: systemEmbeddingProgram,
      readyPrefix: systemPrefix + 'embedding:',
    },
  )
}

export async function rejectSystemEmbeddingPaths(page: Page, entry: string, paths: string[]) {
  return page.evaluate(
    async ({ entry, paths }) => {
      const { createPlayer, createGameWindows } = (await import(entry)) as {
          createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
          createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
        },
        results: {
          path: string
          error: string | null
          constructed: boolean
          before: SystemEmbeddingCounters
          after: SystemEmbeddingCounters
          events: number
          audio: number
        }[] = []
      for (const path of paths) {
        const root = document.createElement('main'),
          canvas = document.createElement('canvas')
        root.append(canvas)
        document.body.append(root)
        const windows = createGameWindows(root, canvas, () => {}),
          before = structuredClone(window.systemEmbeddingCounters)
        let player: ReturnType<typeof createPlayer> | undefined,
          error: string | null = null,
          events = 0,
          audio = 0
        try {
          player = createPlayer(
            canvas,
            () => events++,
            () => audio++,
            false,
            {
              windows,
              dataPath: path,
            },
          )
        } catch (caught) {
          error = String(caught)
        } finally {
          try {
            if (player) await player.stop()
          } finally {
            windows.dispose()
            root.remove()
          }
        }
        results.push({
          path,
          error,
          constructed: !!player,
          before,
          after: structuredClone(window.systemEmbeddingCounters),
          events,
          audio,
        })
      }
      return results
    },
    { entry, paths },
  )
}

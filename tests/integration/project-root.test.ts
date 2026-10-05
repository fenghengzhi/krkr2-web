import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { GameProject } from '../../src/engine/storage/project.ts'
import { selectProject } from '../../src/engine/storage/project.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import { archivePatchFiles, kagAutoPathProgram, solidBmp, patchColors } from '../helpers/archive-patch.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const demand = `function demand(a,b,label){if(a!==b)throw label+": expected ["+b+"] actual ["+a+"]";}\n`
const startup = (binary: boolean) => binary
  ? 'Scripts.compileStorage("program.tjs",System.dataPath+"project.cjs",false,true,false);Scripts.execStorage(System.dataPath+"project.cjs");'
  : 'Scripts.execStorage("program.tjs");'
async function fixture(binary: boolean, project: GameProject, program: string,
  other: Record<string, string | Uint8Array> = {}, overrides: Partial<SessionDependencies> = {}) {
  const f = await headless({
    'startup.tjs': 'throw "wrong namespace startup";', ...other,
    [project.directory + 'startup.tjs']: startup(binary),
    [project.directory + 'program.tjs']: demand + program,
  }, { project, ...overrides })
  try { await f.session.start(); return f }
  catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: frozen project directory governs nested scripts, roots, aliases and canonical UPDATE`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, { directory: 'games/A/', executableDirectory: 'games/' }, String.raw`
demand(System.exePath,"game://./games/","exe differs from project");
demand(System.dataPath,"game://./games/savedata/","save root anchored");
demand(Storages.getFullPath("value.tjs"),"game://./games/A/value.tjs","current directory");
Scripts.execStorage("sub/read.tjs");
demand(nestedValue,"A","nested exec does not change current directory");
demand(Scripts.evalStorage("/root.tjs"),"root","media root");
demand(Scripts.evalStorage("game:///games/B/value.tjs"),"B","explicit other project");
Storages.addAutoPath("extra/");
demand(Storages.getPlacedPath("extra.tjs"),"game://./games/A/extra/extra.tjs","relative auto path");
Storages.removeAutoPath("game:///games/A/extra/");
demand(Storages.isExistentStorage("extra.tjs"),false,"absolute remove same registration");
["A first"].save("slot.txt","utf-8");["A appended"].save(Storages.getPlacedPath("slot.txt"),"utf-8a");
demand([].load("slot.txt")[1],"A appended","canonical update must not prepend project twice");
demand(Storages.getPlacedPath("slot.txt"),"game://./games/A/slot.txt","save canonical");
var complete=true;
`, { 'games/A/value.tjs': '"A"', 'games/B/value.tjs': '"B"', 'root.tjs': '"root"',
      'games/A/sub/read.tjs': 'global.nestedValue=Scripts.evalStorage("value.tjs");',
      'games/A/extra/extra.tjs': '42' })
    try {
      assert.equal(await f.session.evaluate('complete'), '1')
      assert.deepEqual(f.session.snapshot().project, { directory: 'games/A/', executableDirectory: 'games/' })
      assert(f.session.exportSaves().some((file) => file.path === 'games/A/slot.txt'))
      assert(f.session.exportSaves().every((file) => !file.path.includes('games/A/games/A')))
      if (binary) assert(f.session.exportSaves().some((file) => file.path === 'games/savedata/project.cjs' &&
        Buffer.from(file.bytes.subarray(0, 4)).toString() === 'TJS2'))
    } finally { await f.session.stop() }
  })

  test(`${mode}: real archive project starts original KAG auto-path slice and preserves patch/cache identities`, { timeout: 60000 }, async (t) => {
    const original = await kagAutoPathProgram(), program = original.source + demand + String.raw`
var window=new Window();window.setInnerSize(4,3);var root=new Layer(window,null);window.add(root);root.setSize(4,3);var image=new Layer(window,root);
function readPatch(){image.loadImages("patch-probe.bmp");return Scripts.evalStorage("patch-value.tjs")+"|"+Storages.getPlacedPath("patch-value.tjs")+"|"+image.getMainPixel(1,1);}
function removePatch(path){Storages.removeAutoPath(System.exePath+path);return readPatch();}
function restorePatch(){Storages.addAutoPath(System.exePath+"patch2.xp3>");return readPatch();}
demand(System.exePath,"game://./bundle/","exe root");
demand(Storages.getFullPath("nested.tjs"),"game://./bundle/data.xp3>nested.tjs","archive current directory");
`, files = archivePatchFiles().filter((file) => file.path !== 'data.xp3')
    files.push({ path: 'data.xp3', bytes: xp3Fixture({
      'startup.tjs': startup(binary), 'program.tjs': program,
      'system/patch-value.tjs': '"base"', 'image/patch-probe.bmp': solidBmp(patchColors.base),
    }).bytes })
    const resources = await importResources(files.map(({ path, bytes }) => ({ path: 'bundle/' + path,
      blob: new Blob([Uint8Array.from(bytes).buffer]) })), async () => {}),
      selected = selectProject(resources, { mode: 'auto', executableDirectory: 'bundle/' })!,
      f = await headless({ 'startup.tjs': 'throw "wrong root";' }, { project: selected })
    t.diagnostic(JSON.stringify({ source: 'original KAG Initialize', sha256: original.sha256,
      sliceSha256: original.sliceSha256, firstLine: original.firstLine, lastLine: original.lastLine }))
    try {
      f.session.mount(resources); await f.session.start()
      assert.equal(await f.session.evaluate('readPatch()'), `patch2|game://./bundle/patch2.xp3>patch-value.tjs|${patchColors.patch2}`)
      const initial = f.session.snapshot()
      assert.equal(await f.session.evaluate('removePatch("patch2.xp3>")'), `patch|game://./bundle/patch.xp3>patch-value.tjs|${patchColors.patch}`)
      assert.equal(await f.session.evaluate('removePatch("patch.xp3>")'), `base|game://./bundle/data.xp3>system/patch-value.tjs|${patchColors.base}`)
      const afterBase = f.session.snapshot()
      assert.equal(afterBase.imageCacheMisses, initial.imageCacheMisses + 2)
      assert.equal(await f.session.evaluate('restorePatch()'), `patch2|game://./bundle/patch2.xp3>patch-value.tjs|${patchColors.patch2}`)
      assert.equal(f.session.snapshot().imageCacheMisses, afterBase.imageCacheMisses)
      assert(f.session.snapshot().imageCacheHits > afterBase.imageCacheHits)
      assert.equal(await f.session.evaluate('Scripts.evalStorage("/bundle/data.xp3>system/patch-value.tjs")'), 'base')
    } finally { await f.session.stop() }
  })

  test(`${mode}: archive cwd denies relative writes and persists explicitly rooted saves into a fresh VM`, { timeout: 60000 }, async () => {
    const store = new MemorySaveStore(), project = { directory: 'bundle/data.xp3>', executableDirectory: 'bundle/' },
      f = await fixture(binary, project, String.raw`
var denied=0;
try{["bad"].save("new.txt");}catch(error){denied++;}
try{["bad"].save("existing.txt","utf-8a");}catch(error){denied++;}
try{["bad"].save("existing.txt","utf-8o0");}catch(error){denied++;}
demand(denied,3,"archive construction read-only");
["saved",42].save(System.dataPath+"slot.txt","utf-8");
demand([].load(System.dataPath+"slot.txt")[0],"saved","root save read");
demand(Storages.getPlacedPath("existing.txt"),"game://./bundle/data.xp3>existing.txt","canonical archive remains");
`, { 'bundle/data.xp3>existing.txt': 'original' }, { saveStore: store })
    try {
      assert.equal(f.session.exportSaves().some((file) => file.path.includes('>')), false)
      assert(f.session.exportSaves().some((file) => file.path === 'bundle/savedata/slot.txt'))
    } finally { await f.session.stop() }
    const next = await fixture(binary, project,
      'var persisted=[].load(System.dataPath+"slot.txt").join("|");', {}, { saveStore: store })
    try { assert.equal(await next.session.evaluate('persisted'), 'saved|42') }
    finally { await next.session.stop() }
  })

  test(`${mode}: project System datapath parents use executable directory and stay frozen after setArgument`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, { directory: 'games/app/content-data/', executableDirectory: 'games/app/' }, String.raw`
demand(System.dataPath,"game://./games/slots/","parent path");
["state"].save(System.dataPath+"slot.txt");
System.setArgument("-datapath","elsewhere");
demand(System.dataPath,"game://./games/slots/","frozen save directory");
demand([].load("/games/slots/slot.txt")[0],"state","root read of save");
var complete=true;
`, {}, { arguments: new Map([['-datapath', '../slots']]) })
    try {
      assert.equal(await f.session.evaluate('complete'), '1')
      assert(f.session.exportSaves().some((file) => file.path === 'games/slots/slot.txt'))
    } finally { await f.session.stop() }
  })
}

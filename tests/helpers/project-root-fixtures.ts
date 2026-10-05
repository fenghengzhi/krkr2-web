import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { BlobSource, inflateRaw } from '../../src/backends/files/blob-source.ts'
import { readZip } from '../../src/formats/zip/archive.ts'
import { xp3Fixture } from './xp3-fixtures.ts'
import { solidBmp } from './archive-patch.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const observationProgram = (name: 'A' | 'B') => `
var projectName=${JSON.stringify(name)};
var projectWindow=new Window();projectWindow.caption="Project pixels "+projectName;
projectWindow.setPos(720,40);projectWindow.setInnerSize(48,32);projectWindow.setZoom(16,1);projectWindow.visible=true;
var projectPixels=new Layer(projectWindow,null);projectWindow.add(projectPixels);projectPixels.loadImages("project-pixel.bmp");
function projectSaved(){return Storages.isExistentStorage("game://./shared-project-save.txt")
 ? [].load("game://./shared-project-save.txt","utf-8")[0] : "none";}
function projectWrite(value){[value].save("game://./shared-project-save.txt","utf-8");return projectSaved();}
function projectState(){return [projectName,global.projectPatch,Scripts.evalStorage("project-value.tjs"),
 Scripts.evalStorage("probe/nested/read-root.tjs"),System.exePath,System.dataPath,
 Storages.getPlacedPath("project-value.tjs"),Storages.getPlacedPath("project-pixel.bmp"),
 projectPixels.getMainPixel(1,1),projectSaved()].join("|");}
Debug.message("project-ready:"+projectName+":"+projectSaved());
`

/** Authored project layout around the unchanged complete original KAG files.
 * Called only by hosted browser tests; never run this helper locally. */
export async function projectRootFiles(binary: boolean) {
  const zip = await readFile(new URL('../fixtures/compatibility/kag3_template.zip', import.meta.url))
  assert.equal(hash(zip), 'bc14c13281aa9d00e714e6b9d1053d8d0cbde639cf6b7c84d7715551baea00de')
  const entries = await readZip(new BlobSource(new Blob([Uint8Array.from(zip).buffer])), {
    inflate: inflateRaw, utf8: (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    checkpoint: async () => {},
  }), original: Record<string, Buffer> = {}
  for (const entry of entries) original[entry.name] = Buffer.from(await entry.read())
  assert.equal(hash(original['system/Initialize.tjs']!), '01f2b1544a686dc77a4e24bcaf7ec50d564a8de92447c64f51615539b3b41cab')
  const files: { path: string; bytes: Buffer }[] = [{ path: 'startup.tjs',
    bytes: Buffer.from('throw new Exception("collection startup must not run for a selected project");') }]
  const afterInit = binary
    ? 'Scripts.compileStorage("project-observer.tjs",System.dataPath+"project-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"project-observer.cjs");'
    : 'Scripts.execStorage("project-observer.tjs");'
  for (const name of ['A', 'B'] as const) {
    const base = `games/${name}/`, project: Record<string, string | Uint8Array> = {
      ...original,
      'project-value.tjs': JSON.stringify(`${name}-root`),
      'probe/nested/read-root.tjs': 'Scripts.evalStorage("project-value.tjs")',
      'probe/nested/project-value.tjs': JSON.stringify(`${name}-wrong-nested-directory`),
      'project-observer.tjs': observationProgram(name),
    }
    if (name === 'A') {
      for (const [path, value] of Object.entries(project)) files.push({ path: base + 'content-data/' + path,
        bytes: typeof value === 'string' ? Buffer.from(value) : Buffer.from(value) })
      // Valid lower-priority index; importing every archive remains strict.
      files.push({ path: base + 'data.xp3', bytes: xp3Fixture({
        'startup.tjs': 'throw new Exception("content-data must precede data.xp3");',
      }, { compressed: true }).bytes })
    } else files.push({ path: base + 'data.xp3', bytes: xp3Fixture(project, { compressed: true, continuation: true }).bytes })
    files.push({ path: base + 'AfterInit2.tjs', bytes: Buffer.from(afterInit) },
      { path: base + 'patch.xp3', bytes: xp3Fixture({
        'Override.tjs': `global.projectPatch=${JSON.stringify(name + '-patch')};`,
        'first.ks': `[iscript]\nDebug.message("project-first:${name}");\n[endscript]\n[s]\n`,
        'project-pixel.bmp': solidBmp(name === 'A' ? 0x778899 : 0x336699),
      }, { compressed: true }).bytes })
  }
  return { files, provenance: { originalZipSha256: hash(zip),
    originalInitializeSha256: hash(original['system/Initialize.tjs']!), originalEntries: entries.length,
    observerMode: binary ? 'compiled TJS2' : 'source',
    scope: 'Original KAG startup and system methods remain byte-for-byte unchanged; only authored project-observer.tjs is compiled.',
    inputFiles: files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes) })),
  } }
}

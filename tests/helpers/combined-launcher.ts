import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { distributionZip, member } from './deflated-distribution.ts'
import { embedXp3, xp3Fixture } from './xp3-fixtures.ts'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const combinedLauncherPaths = [
  'game://./Release/Game.exe', 'game://./Release/', 'game://./Release/Profiles/',
  'combined-release', 'game://./Release/Game.exe>startup.tjs', 'game://./Release/patch.xp3>first.ks',
].join('|')

export const combinedLauncherStory = String.raw`[eval exp="f.combinedProgress=0"]
*choice|Combined launcher
[cm][nowait]LAUNCHER READY[endnowait]
[iscript]
global.combinedRendered=global.kag.historyLayer.currentLine;
global.combinedVisits++;
[endscript]
[r][link target=*selected]Choose route[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.combinedProgress=7"]
[jump target=*checkpoint]
*checkpoint|Combined route
[cm][nowait]PATCH ROUTE [emb exp="f.combinedProgress"][endnowait]
[iscript]
global.combinedRendered=global.kag.historyLayer.currentLine;
global.combinedVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.combinedProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`

/** Original KAG's tag handlers and conductor are unchanged. Only this authored
 * observer/settings script is compiled in the bytecode variant. */
export const combinedLauncherObserver = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="combined";kag.saveDataLocation=System.dataPath;
var combinedVisits=0,combinedRendered="";
function combinedPaths(){
 return [System.exeName,System.exePath,System.dataPath,System.getArgument("-edition"),
  Storages.getPlacedPath("startup.tjs"),Storages.getPlacedPath("first.ks")].join("|");
}
function combinedState(){
 return [f.combinedProgress,global.combinedRendered,global.combinedVisits,kag.currentLabel,
  kag.current.numLinks,kag.conductor.status].join("|");
}
function combinedStoredState(){
 var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [saved.user.combinedProgress,saved.core.mainConductor.curLabel].join("|");
}
Debug.message("combined-launcher-ready");
`

export async function combinedLauncherDistribution(binary: boolean) {
  const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    originalSha = sha(original)
  if (originalSha !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The fixed original KAG template changed')
  const utf16 = (value: string) => Buffer.from('\ufeff' + value, 'utf16le'),
    // No PE image or runnable machine code: the EXE suffix and MZ prefix are
    // inert archive input. Neither launcher is ever passed to the OS.
    game = embedXp3(original), setup = Buffer.from('MZ inert installer without an XP3 mark\0', 'ascii'),
    patch = xp3Fixture({ 'first.ks': utf16(combinedLauncherStory) }, { compressed: true }),
    files = [
      { name: 'Release/Setup.exe', bytes: setup },
      { name: 'Release/Setup.cf', bytes: Buffer.from('edition=wrong-installer\r\ndatapath=$(exepath)/WrongProfiles\r\n') },
      { name: 'Release/Tools/startup.tjs', bytes: utf16('throw new Exception("Wrong tools sample was selected");') },
      { name: 'Release/Game.exe', bytes: game },
      { name: 'Release/Game.cf', bytes: Buffer.from('edition=combined-release\r\nedition=wrong-duplicate\r\ndatapath=$(exepath)/Profiles\r\n') },
      { name: 'Release/patch.xp3', bytes: patch.bytes },
      { name: 'Release/combined-observer.tjs', bytes: utf16(combinedLauncherObserver) },
      { name: 'Release/AfterInit2.tjs', bytes: utf16(binary
        ? 'Scripts.compileStorage(System.exePath+"combined-observer.tjs",System.dataPath+"combined-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"combined-observer.cjs");'
        : 'Scripts.execStorage(System.exePath+"combined-observer.tjs");') },
    ], bytes = distributionZip(files.map((file) => member(file.name, file.bytes)))
  return { bytes, evidence: { originalSha256: originalSha, originalBytes: original.length,
    embeddedOffset: game.length - original.length, zipSha256: sha(bytes), zipBytes: bytes.length,
    files: files.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: sha(file.bytes) })),
    scope: 'Unmodified original KAG XP3 behind an inert MZ prefix, in a method-8 ZIP with installer, tools sample, external configuration and authored story patch. No executable file is run.' } }
}

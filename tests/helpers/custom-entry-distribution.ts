import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { distributionZip, member } from './deflated-distribution.ts'

export const customEntryPaths = [
  'game://./Release/', 'game://./Release/savedata/',
  'game://./Release/data/boot.tjs', 'game://./Release/data/first.ks',
].join('|')
export const customEntryStory = String.raw`[eval exp="f.customProgress=0"]
*choice|Custom entry opening
[cm][nowait]CUSTOM ENTRY[endnowait]
[iscript]
global.customRendered=global.kag.historyLayer.currentLine;global.customVisits++;
[endscript]
[r][link target=*selected]Choose route[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.customProgress=7"]
[jump target=*checkpoint]
*checkpoint|Custom entry chapter
[cm][nowait]CHAPTER [emb exp=f.customProgress][endnowait]
[iscript]
global.customRendered=global.kag.historyLayer.currentLine;global.customVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.customProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
export const customEntryObserver = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="custom";kag.saveDataLocation=System.dataPath;
var customVisits=0,customRendered="";
function customPaths(){return [System.exePath,System.dataPath,Storages.getPlacedPath("boot.tjs"),Storages.getPlacedPath("first.ks")].join("|");}
function customState(){return [f.customProgress,global.customRendered,global.customVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");}
function customStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.customProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("custom-entry-game-ready");
`
export async function customEntryDistribution(binary: boolean) {
  const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    originalSha256 = hash(original), wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
  if (originalSha256 !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The fixed original KAG template changed')
  const files = [
    { name: 'Release/data/engine.xp3', bytes: original },
    { name: 'Release/data/boot.tjs', bytes: wide('Storages.addAutoPath(System.exePath+"data/engine.xp3>");Scripts.execStorage("engine.xp3>startup.tjs");') },
    { name: 'Release/data/first.ks', bytes: wide(customEntryStory) },
    { name: 'Release/observer.tjs', bytes: wide(customEntryObserver) },
    { name: 'Release/AfterInit2.tjs', bytes: wide(binary
      ? 'Scripts.compileStorage(System.exePath+"observer.tjs",System.dataPath+"custom-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"custom-observer.cjs");'
      : 'Scripts.execStorage(System.exePath+"observer.tjs");') },
    { name: 'Release/Tools/startup.tjs', bytes: wide('throw new Exception("A bundled tools sample was launched instead of boot.tjs");') },
  ], bytes = distributionZip(files.map((file) => member(file.name, file.bytes)))
  return { bytes, evidence: { originalSha256, originalBytes: original.length, zipSha256: hash(bytes), zipBytes: bytes.length,
    files: files.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: hash(file.bytes) })),
    scope: 'Unmodified original KAG template in an independently named archive, started by an authored boot.tjs and public auto-path/exec APIs. An unrelated tools startup is retained as a negative control. Only the observer is compiled in the bytecode arm.' } }
}

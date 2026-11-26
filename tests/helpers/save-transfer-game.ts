import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { distributionZip, member } from './deflated-distribution.ts'
import { embedXp3, xp3Fixture } from './xp3-fixtures.ts'

export const saveTransferStory = String.raw`[eval exp="f.transferValue=0"]
*choice|Edition opening
[cm][hr][nowait]EDITION [emb exp=global.transferEdition][endnowait]
[iscript]
global.transferRendered=kag.historyLayer.currentLine;global.transferVisits++;
[endscript]
[r][link target=*seven]Choose 7[endlink] / [link target=*ninety]Choose 99[endlink] / [link target=*load]Load slot[endlink]
[s]
*seven
[eval exp="f.transferValue=7"]
[jump target=*checkpoint]
*ninety
[eval exp="f.transferValue=99"]
[jump target=*checkpoint]
*checkpoint|Portable chapter
[cm][hr][nowait]VALUE [emb exp=f.transferValue][endnowait]
[iscript]
global.transferRendered=kag.historyLayer.currentLine;global.transferVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[iscript]
["notes:"+f.transferValue].save(System.dataPath+"notes/player.txt","utf-8");
[endscript]
[save place=0 ask=false]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
export const saveTransferObserver = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="portable";kag.saveDataLocation=System.dataPath;
var transferEdition=System.getArgument("-edition"),transferRendered="",transferVisits=0;
["outside:"+transferEdition].save(System.exePath+"outside.txt","utf-8");
if(transferEdition=="old")["source-only"].save(System.dataPath+"source-only.txt","utf-8");
else ["target-only"].save(System.dataPath+"target-only.txt","utf-8");
function transferState(){return [global.transferEdition,f.transferValue,global.transferRendered,global.transferVisits,
 kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");}
function transferPaths(){return System.exePath+"|"+System.dataPath+"|"+Storages.getPlacedPath("first.ks");}
function transferStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return saved.user.transferValue+"|"+saved.core.mainConductor.curLabel;}
function transferNotes(){return [].load(System.dataPath+"notes/player.txt").join("|");}
Debug.message("save-transfer-ready:"+transferEdition);
`

export async function saveTransferGame(edition: 'old' | 'new', binary: boolean) {
  const root = edition === 'old' ? 'OldRelease/' : 'NewRelease/', folder = edition === 'old' ? 'OldProfiles/' : 'PlayerData/',
    original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
  if (sha(original) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('Original KAG template changed')
  const files = [
    { name: root + 'Game.exe', bytes: embedXp3(original) },
    { name: root + 'Game.cf', bytes: Buffer.from(`edition=${edition}\r\ndatapath=$(exepath)/${folder}\r\n`) },
    { name: root + 'patch.xp3', bytes: xp3Fixture({ 'first.ks': wide(saveTransferStory) }, { compressed: true }).bytes },
    { name: root + 'observer.tjs', bytes: wide(saveTransferObserver) },
    { name: root + 'AfterInit2.tjs', bytes: wide(binary
      ? `Scripts.compileStorage(System.exePath+"observer.tjs",System.dataPath+"observer-${edition}.cjs",false,true,false);Scripts.execStorage(System.dataPath+"observer-${edition}.cjs");`
      : 'Scripts.execStorage(System.exePath+"observer.tjs");') },
  ], bytes = distributionZip(files.map((file) => member(file.name, file.bytes)))
  return { edition, binary, bytes, root, dataDirectory: root + folder,
    evidence: { edition, binary, sha256: sha(bytes), bytes: bytes.length,
      originalSha256: sha(original), files: files.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: sha(file.bytes) })),
      scope: 'Unmodified original KAG inside inert archive input. Authored old/new versions have different game paths, custom data directories and actual native bookmark files.' } }
}

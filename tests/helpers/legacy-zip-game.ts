import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { legacyZip } from './legacy-zip-names.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

export const legacyGamePaths = [
  'game://./ソ/', 'game://./ソ/savedata/', 'game://./ソ/data.xp3>startup.tjs',
  'game://./ソ/patch.xp3>first.ks', 'game://./ソ/chapters.zip>表.ks', 'game://./ソ/表.txt', 'EXTERNAL 表',
].join('|')

export const legacyGameFirst = String.raw`[eval exp="f.legacyProgress=0"]
*choice|Japanese ZIP release
[cm][nowait]ARCHIVE READY[endnowait]
[iscript]
global.legacyRendered=global.kag.historyLayer.currentLine;global.legacyVisits++;
[endscript]
[r][link target=*selected]Read chapter[endlink] / [link target=*load]Load slot[endlink]
[s]
*selected
[eval exp="f.legacyProgress=7"]
[jump storage=表.ks target=*checkpoint]
*load
[load place=0 ask=false]
`

export const legacyGameChapter = String.raw`*checkpoint|Japanese chapter
[cm][nowait]CHAPTER 表 [emb exp="f.legacyProgress"][endnowait]
[iscript]
global.legacyRendered=global.kag.historyLayer.currentLine;global.legacyVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.legacyProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`

export const legacyGameObserver = String.raw`
Storages.addAutoPath(System.exePath+"chapters.zip>");
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="legacy";kag.saveDataLocation=System.dataPath;
var legacyVisits=0,legacyRendered="",legacyOuterText=[].load(System.exePath+"表.txt","utf-8")[0];
function legacyPaths(){
 return [System.exePath,System.dataPath,Storages.getPlacedPath("startup.tjs"),Storages.getPlacedPath("first.ks"),
  Storages.getPlacedPath("表.ks"),Storages.getPlacedPath(System.exePath+"表.txt"),global.legacyOuterText].join("|");
}
function legacyState(){
 return [f.legacyProgress,global.legacyRendered,global.legacyVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");
}
function legacyStoredState(){
 var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
 return [saved.user.legacyProgress,saved.core.mainConductor.curLabel].join("|");
}
Debug.message("legacy-zip-game-ready");
`

export async function legacyGameDistribution(binary: boolean) {
  const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'), originalSha = sha(original)
  if (originalSha !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The fixed original KAG template changed')
  const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le'),
    // Literal CP932 on-disk names, never encoded with the product decoder.
    // Both characters contain a 5c trail byte that must not become a slash.
    root = Buffer.from([0x83, 0x5c, 0x2f]), table = Buffer.from([0x95, 0x5c]),
    name = (suffix: string) => Buffer.concat([root, Buffer.from(suffix, 'ascii')]),
    chapterName = Buffer.concat([table, Buffer.from('.ks')]),
    chapters = legacyZip([{ name: chapterName, bytes: utf16(legacyGameChapter) }]),
    patch = xp3Fixture({ 'first.ks': utf16(legacyGameFirst) }, { compressed: true }),
    files = [
      { logicalName: 'ソ/data.xp3', name: name('data.xp3'), bytes: original },
      { logicalName: 'ソ/patch.xp3', name: name('patch.xp3'), bytes: patch.bytes },
      { logicalName: 'ソ/chapters.zip', name: name('chapters.zip'), bytes: chapters },
      { logicalName: 'ソ/表.txt', name: Buffer.concat([root, table, Buffer.from('.txt')]), bytes: Buffer.from('EXTERNAL 表\n') },
      { logicalName: 'ソ/legacy-observer.tjs', name: name('legacy-observer.tjs'), bytes: utf16(legacyGameObserver) },
      { logicalName: 'ソ/AfterInit2.tjs', name: name('AfterInit2.tjs'), bytes: utf16(binary
        ? 'Scripts.compileStorage(System.exePath+"legacy-observer.tjs",System.dataPath+"legacy-observer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"legacy-observer.cjs");'
        : 'Scripts.execStorage(System.exePath+"legacy-observer.tjs");') },
    ], bytes = legacyZip(files)
  return { bytes, evidence: { originalSha256: originalSha, zipSha256: sha(bytes), zipBytes: bytes.length,
    chapterNameHex: chapterName.toString('hex'), files: files.map((file) => ({ logicalName: file.logicalName,
      nameHex: file.name.toString('hex'), bytes: file.bytes.length, sha256: sha(file.bytes) })),
    scope: 'Literal unflagged CP932 filenames in the outer distribution and an inner chapter ZIP, with the unchanged original KAG template and authored patch. Only the authored observer is compiled.' } }
}

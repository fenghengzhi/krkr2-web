import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

/** Independent classic-ZIP reader for inspecting the player's exported bytes.
 * Uses Node zlib and a bitwise CRC; it never calls the product ZIP loader. */
export function nativeSaveZipFiles(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22
  assert(end >= 0 && zip.readUInt32LE(end) === 0x06054b50, 'Expected uncommented classic ZIP')
  assert.equal(zip.readUInt16LE(end + 4), 0); assert.equal(zip.readUInt16LE(end + 6), 0)
  const count = zip.readUInt16LE(end + 10), central = zip.readUInt32LE(end + 16)
  assert.equal(zip.readUInt16LE(end + 8), count); assert(count > 0 && count < 1000)
  assert.equal(central + zip.readUInt32LE(end + 12), end)
  const result = new Map<string, Buffer>()
  let at = central
  for (let index = 0; index < count; index++) {
    assert(at + 46 <= end); assert.equal(zip.readUInt32LE(at), 0x02014b50)
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16),
      compressed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24),
      nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32),
      local = zip.readUInt32LE(at + 42), nameBytes = zip.subarray(at + 46, at + 46 + nameLength), name = nameBytes.toString('utf8')
    assert.equal(flags & 1, 0); assert(method === 0 || method === 8)
    assert(at + 46 + nameLength + extra + comment <= end)
    assert(name.length && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'))
    assert(!name.endsWith('/') && !result.has(name), 'Every exported file has a unique relative name')
    assert.equal(zip.readUInt32LE(local), 0x04034b50)
    assert.equal(zip.readUInt16LE(local + 8), method)
    const localName = zip.readUInt16LE(local + 26), data = local + 30 + localName + zip.readUInt16LE(local + 28)
    assert(zip.subarray(local + 30, local + 30 + localName).equals(nameBytes))
    assert(data + compressed <= central && size <= 64 * 1024 * 1024)
    const stored = zip.subarray(data, data + compressed), bytes = method === 0 ? Buffer.from(stored)
      : inflateRawSync(stored, { maxOutputLength: 64 * 1024 * 1024 })
    assert.equal(bytes.length, size)
    let actual = 0xffffffff
    for (const byte of bytes) {
      actual ^= byte
      for (let bit = 0; bit < 8; bit++) actual = (actual >>> 1) ^ (actual & 1 ? 0xedb88320 : 0)
    }
    assert.equal((actual ^ 0xffffffff) >>> 0, crc, name)
    result.set(name, bytes); at += 46 + nameLength + extra + comment
  }
  assert.equal(at, end)
  return result
}

export const saveBytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Original public KAG save/load tags, reached only by actual link clicks. */
export const nativeSaveStory = String.raw`[eval exp="f.nativeProgress=7"]
*checkpoint|Native save migration
[cm][hr][nowait]CHECKPOINT [emb exp="f.nativeProgress"][endnowait]
[iscript]
global.nativeRendered=global.kag.historyLayer.currentLine;
global.nativeVisits++;
[endscript]
[r][link target=*save]Save[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load[endlink] / [link target=*sdk]SDK[endlink] / [link target=*finish]Finish[endlink]
[s]
*save
[save place=0 ask=false]
[iscript]
["native-sidecar:"+f.nativeProgress].save(System.dataPath+"notes/player.txt","z");
[endscript]
[jump target=*checkpoint]
*change
[eval exp="f.nativeProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*sdk
[iscript]
global.nativeSdkResult=nativeReadSdkBookmark();
[endscript]
[jump target=*checkpoint]
*finish
[cm][hr][nowait]FINISHED[endnowait]
[iscript]
global.nativeRendered=global.kag.historyLayer.currentLine;
Debug.message("native-save-story-finished:"+f.nativeProgress);
[endscript]
[s]
`

/** Only this authored script is compiled in the bytecode variant. The SDK
 * parser snapshot below is separate from the original KAG Window's save. */
export const nativeSaveGameSource = String.raw`
kag.saveThumbnail=true;kag.thumbnailWidth=64;kag.thumbnailDepth=24;
kag.dataName="migration";kag.saveDataLocation=System.dataPath;
var nativeVisits=0,nativeRendered="",nativeSdkResult="not-read";
["outside-data-directory"].save("outside-native.txt","z");
function nativeSaveState(){
 return [f.nativeProgress,global.nativeRendered,global.nativeVisits,global.kag.currentLabel,
  global.kag.current.numLinks,global.kag.conductor.status].join("|");
}
function nativeStoredState(){
 var k=global.kag,d=Scripts.evalStorage(k.getBookMarkFileNameAtNum(0),"o"+k.calcThumbnailSize().size);
 return [d.user.nativeProgress,d.core.mainConductor.curLabel].join("|");
}
class NativeSaveParser extends KAGParser {
 var loadedArgs="";
 function NativeSaveParser(){super.KAGParser();debugLevel=tkdlNone;}
 function onScenarioLoad(name){
  if(macroParams!==null)loadedArgs=callStackDepth+"|"+macroParams.actor+"|"+macroParams.extra;
 }
}
function nativeReadSdkBookmark(){
 var p=new NativeSaveParser(),result,failed=false,primary;
 try{
  p.restore(Scripts.evalStorage(System.dataPath+"sdk-bookmark.tjs"));
  var tag=p.getNextTag();
  result=tag.actor+"|"+p.callStackDepth+"|"+p.macroParams.actor+"|"+p.macroParams.extra+"|"+p.loadedArgs;
  result+="|"+p.getNextTag().tagname+"|"+p.callStackDepth+"|"+int(p.macroParams===null);
 }catch(e){failed=true;primary=e;}
 try{invalidate p;}catch(e){if(failed)Debug.message("native-parser-cleanup:"+e.message);else throw e;}
 if(failed)throw primary;return result;
}
Debug.message("native-save-game-ready");
`

export const nativeSdkResult = 'Alice|1|Alice|live|1|Alice|live|finished|0|1'

// The immutable native output and the exact scenario bytes follow. They were
// read from the already archived original SDK result, not generated by Web.

export const nativeSdkSaveReference = {
  "runId": "45757288264",
  "commit": "653ca3be6f398a5c4c60d0453c1539c2de9e0dcc",
  "artifact": "original-eri-reference",
  "sourcePath": "kag/game/",
  "comparisonComplete": true,
  "scope": "Fixed 2.32r2 SDK KAGParser macro/call snapshot; not a complete KAG MainWindow bookmark.",
  "files": [
    {
      "name": "native-bookmark.tjs",
      "bytes": 2244,
      "sha256": "79bfe6c694272f1faecc12331434f6f27a45708b2f796e2b58727340c5a25c0d",
      "base64": "//4oAGMAbwBuAHMAdAApACAAJQBbAA0ACgAgACIARQB4AGMAbAB1AGQAZQBMAGUAdgBlAGwAUwB0AGEAYwBrACIAIAA9AD4AIAAiACIALAANAAoAIAAiAEkAZgBMAGUAdgBlAGwAIgAgAD0APgAgADAALAANAAoAIAAiAG0AYQBjAHIAbwBzACIAIAA9AD4AIAAoAGMAbwBuAHMAdAApACAAJQBbAA0ACgAgACAAIgBzAGMAZQBuAGUAIgAgAD0APgAgACIAWwBjAGEAbABsACAAcwB0AG8AcgBhAGcAZQA9AGMAaABhAHAAdABlAHIALgBrAHMAIAB0AGEAcgBnAGUAdAA9ACoAYwBoAGEAcAB0AGUAcgBdAFsAbQBhAGMAcgBvAHAAbwBwAF0AIgANAAoAIABdACwADQAKACAAIgBtAGEAYwByAG8AQQByAGcAUwB0AGEAYwBrAEIAYQBzAGUAIgAgAD0APgAgADEALAANAAoAIAAiAEkAZgBMAGUAdgBlAGwARQB4AGUAYwB1AHQAZQBkAFMAdABhAGMAawAiACAAPQA+ACAAIgAiACwADQAKACAAIgBjAHUAcgBQAG8AcwAiACAAPQA+ACAAMgAyACwADQAKACAAIgBzAHQAbwByAGEAZwBlAFMAaABvAHIAdABOAGEAbQBlACIAIAA9AD4AIAAiAGMAaABhAHAAdABlAHIALgBrAHMAIgAsAA0ACgAgACIAYwB1AHIATABpAG4AZQAiACAAPQA+ACAAMQAsAA0ACgAgACIAcwB0AG8AcgBhAGcAZQBOAGEAbQBlACIAIAA9AD4AIAAiAGMAaABhAHAAdABlAHIALgBrAHMAIgAsAA0ACgAgACIAbABpAG4AZQBCAHUAZgBmAGUAcgBVAHMAaQBuAGcAIgAgAD0APgAgADAALAANAAoAIAAiAGMAYQBsAGwAUwB0AGEAYwBrACIAIAA9AD4AIAAoAGMAbwBuAHMAdAApACAAWwANAAoAIAAgACgAYwBvAG4AcwB0ACkAIAAlAFsADQAKACAAIAAgACIARQB4AGMAbAB1AGQAZQBMAGUAdgBlAGwAUwB0AGEAYwBrACIAIAA9AD4AIAAiACIALAANAAoAIAAgACAAIgBJAGYATABlAHYAZQBsACIAIAA9AD4AIAAwACwADQAKACAAIAAgACIASQBmAEwAZQB2AGUAbABFAHgAZQBjAHUAdABlAGQAUwB0AGEAYwBrACIAIAA9AD4AIAAiACIALAANAAoAIAAgACAAIgBtAGEAYwByAG8AQQByAGcAUwB0AGEAYwBrAEIAYQBzAGUAIgAgAD0APgAgADAALAANAAoAIAAgACAAIgBsAGkAbgBlAEIAdQBmAGYAZQByAFUAcwBpAG4AZwAiACAAPQA+ACAAMQAsAA0ACgAgACAAIAAiAG0AYQBjAHIAbwBBAHIAZwBTAHQAYQBjAGsARABlAHAAdABoACIAIAA9AD4AIAAxACwADQAKACAAIAAgACIAcABvAHMAIgAgAD0APgAgADQAMQAsAA0ACgAgACAAIAAiAGwAYQBiAGUAbAAiACAAPQA+ACAAIgAqAHMAdABhAHIAdAAiACwADQAKACAAIAAgACIAcwB0AG8AcgBhAGcAZQAiACAAPQA+ACAAIgBlAG4AdAByAHkALgBrAHMAIgAsAA0ACgAgACAAIAAiAEUAeABjAGwAdQBkAGUATABlAHYAZQBsACIAIAA9AD4AIAAtADEALAANAAoAIAAgACAAIgBsAGkAbgBlAEIAdQBmAGYAZQByACIAIAA9AD4AIAAiAFsAYwBhAGwAbAAgAHMAdABvAHIAYQBnAGUAPQBjAGgAYQBwAHQAZQByAC4AawBzACAAdABhAHIAZwBlAHQAPQAqAGMAaABhAHAAdABlAHIAXQBbAG0AYQBjAHIAbwBwAG8AcABdAFsAZgBpAG4AaQBzAGgAZQBkAF0AXABcACIALAANAAoAIAAgACAAIgBvAHIAZwBMAGkAbgBlAFMAdAByACIAIAA9AD4AIAAiAFsAcwBjAGUAbgBlACAAYQBjAHQAbwByAD0AQQBsAGkAYwBlAF0AWwBmAGkAbgBpAHMAaABlAGQAXQBcAFwAIgAsAA0ACgAgACAAIAAiAG8AZgBmAHMAZQB0ACIAIAA9AD4AIAAyAA0ACgAgACAAXQANAAoAIABdACwADQAKACAAIgBtAGEAYwByAG8AQQByAGcAcwAiACAAPQA+ACAAKABjAG8AbgBzAHQAKQAgAFsADQAKACAAIAAoAGMAbwBuAHMAdAApACAAJQBbAA0ACgAgACAAIAAiAGUAeAB0AHIAYQAiACAAPQA+ACAAIgBsAGkAdgBlACIALAANAAoAIAAgACAAIgBhAGMAdABvAHIAIgAgAD0APgAgACIAQQBsAGkAYwBlACIALAANAAoAIAAgACAAIgB0AGEAZwBuAGEAbQBlACIAIAA9AD4AIAAiAHMAYwBlAG4AZQAiAA0ACgAgACAAXQANAAoAIABdACwADQAKACAAIgBtAGEAYwByAG8AQQByAGcAUwB0AGEAYwBrAEQAZQBwAHQAaAAiACAAPQA+ACAAMQAsAA0ACgAgACIAYwB1AHIATABhAGIAZQBsACIAIAA9AD4AIAAiACoAYwBoAGEAcAB0AGUAcgAiACwADQAKACAAIgBFAHgAYwBsAHUAZABlAEwAZQB2AGUAbAAiACAAPQA+ACAALQAxACwADQAKACAAIgBsAGkAbgBlAEIAdQBmAGYAZQByACIAIAA9AD4AIAAiAFsAYwBhAGwAbAAgAHMAdABvAHIAYQBnAGUAPQBjAGgAYQBwAHQAZQByAC4AawBzACAAdABhAHIAZwBlAHQAPQAqAGMAaABhAHAAdABlAHIAXQBbAG0AYQBjAHIAbwBwAG8AcABdAFsAZgBpAG4AaQBzAGgAZQBkAF0AXABcACIADQAKAF0A"
    },
    {
      "name": "entry.ks",
      "bytes": 220,
      "sha256": "9e196b31c88f6ef968922b8aa016823b6cb469f1340c8adf8150b9ba1dbbbd81",
      "base64": "//4qAHMAdABhAHIAdAAKAFsAbQBhAGMAcgBvACAAbgBhAG0AZQA9AHMAYwBlAG4AZQBdAFsAYwBhAGwAbAAgAHMAdABvAHIAYQBnAGUAPQBjAGgAYQBwAHQAZQByAC4AawBzACAAdABhAHIAZwBlAHQAPQAqAGMAaABhAHAAdABlAHIAXQBbAGUAbgBkAG0AYQBjAHIAbwBdAFwACgBbAHMAYwBlAG4AZQAgAGEAYwB0AG8AcgA9AEEAbABpAGMAZQBdAFsAZgBpAG4AaQBzAGgAZQBkAF0AXAAKAA=="
    },
    {
      "name": "chapter.ks",
      "bytes": 88,
      "sha256": "ead5f5ad462015e847d7313a060c0b57399e269b6269e70a2584cd302da180c1",
      "base64": "//4qAGMAaABhAHAAdABlAHIACgBbAG8AYgBzAGUAcgB2AGUAIABhAGMAdABvAHIAPQAlAGEAYwB0AG8AcgBdAFwACgBbAHIAZQB0AHUAcgBuAF0AXAAKAA=="
    }
  ]
} as const

export function nativeSdkSaveFiles(): Map<string, Buffer> {
  return new Map(nativeSdkSaveReference.files.map((file) => {
    const bytes = Buffer.from(file.base64, "base64")
    assert.equal(bytes.length, file.bytes); assert.equal(saveBytesDigest(bytes), file.sha256)
    return [file.name, bytes]
  }))
}

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { distributionZip, member } from './deflated-distribution.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

const wide = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
const story = `[eval exp="f.swapProgress=0"]
*first|First disc
[cm][hr][nowait][emb exp="global.swapFirstText"][endnowait]
[iscript]
global.swapOpening=kag.historyLayer.currentLine;
[endscript]
[r][link target=*enter]Continue after inserting the story disc[endlink] / [link target=*load]Load chapter[endlink]
[s]
*enter
[if exp="global.swapUsePrompt"]
[eval exp="System.inform('Insert the story disc, then press OK.','Next disc')"]
[eval exp="global.swapContinued++;Debug.message('disc-swap-modal-resumed')"]
[endif]
[eval exp="f.swapProgress=Scripts.evalStorage('D:/Routes/開幕.tjs')"]
[jump target=*arrival]
*arrival|Second disc chapter
[image layer=base page=fore storage="D:/Art/Title.bmp"]
[cm][hr][nowait][emb exp="Scripts.evalStorage('D:/Routes/Moon Finale.tjs')"] [emb exp="f.swapProgress"][endnowait]
[iscript]
global.swapRendered=kag.historyLayer.currentLine;global.swapVisits++;
[endscript]
[r][link target=*save]Save chapter[endlink] / [link target=*change]Change progress[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*arrival]
*change
[eval exp="f.swapProgress=99"]
[jump target=*arrival]
*load
[load place=0 ask=false]
`

const observer = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="swap";kag.saveDataLocation=System.dataPath;
var swapFirstText=[].load("D:/scene.txt","utf-8")[0],swapOpening="",swapRendered="",swapVisits=0;
function swapState(){return [kag.currentLabel,kag.current.numLinks,kag.conductor.status,f.swapProgress].join("|");}
function swapVolumes(){return [Storages.searchCD("KRKR_PLAIN"),Storages.searchCD("KRKR_STORY"),
 int(Storages.isExistentStorage("D:/scene.txt")),int(Storages.isExistentStorage("D:/Art/Title.bmp"))].join("|");}
function swapStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.swapProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("disc-swap-ready:"+swapFirstText);
`

/** Both real ISO files come from the independent hosted ISO authoring step.
 * The game is a separate ZIP containing the unchanged original KAG template. */
export function discSwapGame(binary: boolean) {
  const directory = new URL('../../out/verification/disc-volumes/', import.meta.url),
    hashes = readFileSync(new URL('SHA256SUMS', directory), 'utf8'),
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    image = (name: string) => {
      const bytes = readFileSync(new URL(name, directory)), row = hashes.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
        .find((fields) => fields[1] === name)
      if (!row || row[0] !== hash(bytes)) throw new Error('Disc swap input identity differs: ' + name)
      return { name, buffer: bytes, mimeType: 'application/octet-stream' }
    },
    original = readFileSync(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
  if (hash(original) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The original KAG template changed')
  const hook = binary
    ? 'Scripts.compileStorage(System.exePath+"swap-observer.tjs",System.dataPath+"swap.cjs",false,true,false);Scripts.execStorage(System.dataPath+"swap.cjs");'
    : 'Scripts.execStorage(System.exePath+"swap-observer.tjs");'
  const script = `var swapUsePrompt=${Number(binary)},swapContinued=0;\n` + observer
  const inputs = [
    { name: 'Game/data.xp3', bytes: original },
    { name: 'Game/patch.xp3', bytes: xp3Fixture({ 'first.ks': wide(story) }).bytes },
    { name: 'Game/AfterInit2.tjs', bytes: wide(hook) },
    { name: 'Game/swap-observer.tjs', bytes: wide(script) },
  ]
  const files = [{ name: 'Game.zip', mimeType: 'application/octet-stream',
    buffer: distributionZip(inputs.map((file) => member(file.name, file.bytes))) }, image('plain.iso'), image('story.iso')]
  return { files, manifest: { binary, initialBinding: 'D=plain.iso',
    inputs: inputs.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: hash(file.bytes) })),
    files: files.map((file) => ({ name: file.name, bytes: file.buffer.length, sha256: hash(file.buffer) })),
    story, observer: script } }
}

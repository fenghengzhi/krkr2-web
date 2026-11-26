import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { discBootProjectFiles } from './disc-boot.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

const wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const menu = String.raw`[eval exp="f.discProgress=0"]
*choice|Japanese disc opening
[cm][hr][nowait]Open the Japanese disc[endnowait]
[r][link target=*enter]Read chapter[endlink] / [link target=*load]Load chapter[endlink]
[s]
*enter
[eval exp="f.discProgress=Scripts.evalStorage(global.discRoot+'表/表.tjs')"]
[jump storage="表.ks" target=*arrival]
*load
[load place=0 ask=false]
`
const observer = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="disc";kag.saveDataLocation=System.dataPath;
var discRoot=Storages.searchCD("KRKR_表")+":/";
var discRendered="",discVisits=0;
Storages.addAutoPath(discRoot+"表/");Storages.addAutoPath(discRoot+"Art/");
var discTitle=Scripts.evalStorage(discRoot+"表/Title.tjs");
var discBonus=Scripts.evalStorage(discRoot+"Books/Scenes.zip>Bonus.tjs");
function discState(){return [kag.currentLabel,kag.current.numLinks,kag.conductor.status,f.discProgress].join("|");}
function discSlot(){var slot=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [slot.user.discProgress,slot.core.mainConductor.curLabel].join("|");}
function discOemPaths(){return [Storages.searchCD("KRKR_表"),Storages.getPlacedPath("表.ks"),
 Scripts.evalStorage(discRoot+"表/表.tjs")].join("|");}
Debug.message("story-disc-ready:"+discRoot+"|"+discTitle+"|"+discBonus);
`

/** Only authored game files change. The original KAG XP3 is untouched. The
 * Python author writes ASCII ISO identifiers, then applies listed equal-size
 * CP932 identifier bytes; it does not use the production filesystem reader. */
export function oemDiscProjectFiles() {
  const files = discBootProjectFiles(false).map((file) => ({
    name: '表Game/' + file.name, isoName: 'JPGame/' + file.name,
    buffer: file.name === 'patch.xp3' ? xp3Fixture({ 'first.ks': wide(menu) }).bytes
      : file.name === 'story-observer.tjs' ? wide(observer) : file.buffer,
  }))
  files.push(
    { name: '表/表.ks', isoName: 'JP/JP.ks', buffer: wide(readFileSync(new URL('../fixtures/disc-story/Story.ks', import.meta.url), 'utf8')) },
    { name: '表/表.tjs', isoName: 'JP/JP.tjs', buffer: wide('6*7') },
    { name: '表/Title.tjs', isoName: 'JP/Title.tjs', buffer: wide('"Moon disc scene"') },
    { name: 'Art/Title.bmp', isoName: 'Art/Title.bmp', buffer: readFileSync(new URL('../../out/verification/disc-volumes/story-files/Art/Title.bmp', import.meta.url)) },
    { name: 'Books/Scenes.zip', isoName: 'Books/Scenes.zip', buffer: readFileSync(new URL('../../out/verification/disc-volumes/story-files/Books/Scenes.zip', import.meta.url)) },
  )
  return files
}

interface OemDiscManifest {
  schema: 1
  complete: boolean
  commit: string
  name: string
  bytes: number
  sha256: string
  encoding: string
  volume: string
  volumeBytes: string
  layout: { joliet: boolean; udf: boolean; isoDescriptors: number[]; primaryOnly: boolean }
  readback: { complete: boolean; files: Array<{ name: string; rawPathHex: string; bytes: number; sha256: string }> }
  inputs: Array<{ name: string; isoName: string; bytes: number; sha256: string }>
}

export function oemGameDiscInput() {
  const directory = new URL('../../out/verification/oem-game-disc/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as OemDiscManifest,
    name = 'boot-oem932-source.iso'
  if (manifest.schema !== 1 || !manifest.complete || manifest.name !== name || manifest.encoding !== 'shift_jis' ||
      manifest.volume !== 'KRKR_表' || manifest.volumeBytes !== '4b524b525f955c' ||
      manifest.layout.joliet || manifest.layout.udf || !manifest.layout.primaryOnly ||
      manifest.layout.isoDescriptors.join(',') !== '1,255' || !manifest.readback.complete ||
      manifest.readback.files.length !== manifest.inputs.length ||
      manifest.inputs.some((input) => !manifest.readback.files.some((file) => file.name === input.name &&
        file.bytes === input.bytes && file.sha256 === input.sha256)) ||
      !manifest.readback.files.some((file) => file.name === '表/表.ks' && file.rawPathHex === '955c2f955c2e6b73') ||
      !manifest.readback.files.some((file) => file.name === '表Game/data.xp3' && file.rawPathHex === '955c47616d652f646174612e787033') ||
      process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)
    throw new Error('Incomplete independent OEM-name ISO game disc')
  const buffer = readFileSync(new URL(name, directory))
  if (buffer.length !== manifest.bytes || createHash('sha256').update(buffer).digest('hex') !== manifest.sha256)
    throw new Error('OEM-name ISO differs from its independent readback manifest')
  return { files: [{ name, buffer, mimeType: 'application/octet-stream' }], manifest }
}

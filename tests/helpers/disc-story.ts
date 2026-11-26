import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { xp3Fixture } from './xp3-fixtures.ts'

export const discStoryCue = 'FILE "story.iso" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00\n'
export const discStoryImage = () => readFileSync(new URL('../../out/verification/disc-volumes/story.iso', import.meta.url))

const menu = `[eval exp="f.discProgress=0"]
*choice|Disc opening
[cm][hr][nowait]Open the story disc[endnowait]
[r][link target=*enter]Read chapter[endlink] / [link target=*load]Load chapter[endlink]
[s]
*enter
[eval exp="f.discProgress=Scripts.evalStorage(global.discRoot+'Routes/開幕.tjs')"]
[jump storage=story.ks target=*arrival]
*load
[load place=0 ask=false]
`

const observer = `kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="disc";kag.saveDataLocation=System.dataPath;
var discRoot=Storages.searchCD("krkr_story")+":/";
var discRendered="",discVisits=0;
Storages.addAutoPath(discRoot+"Routes/");Storages.addAutoPath(discRoot+"Art/");
var discTitle=Scripts.evalStorage(discRoot+"Routes/Moon Finale.tjs");
var discBonus=Scripts.evalStorage(discRoot+"Books/Scenes.zip>Bonus.tjs");
function discState(){return [kag.currentLabel,kag.current.numLinks,kag.conductor.status,f.discProgress].join("|");}
function discSlot(){var slot=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [slot.user.discProgress,slot.core.mainConductor.curLabel].join("|");}
Debug.message("story-disc-ready:"+discRoot+"|"+discTitle+"|"+discBonus);`

export function discStoryProject(binary: boolean) {
  const original = readFileSync(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
  if (createHash('sha256').update(original).digest('hex') !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The original KAG template changed')
  const wide = (s: string) => Buffer.from('\ufeff' + s, 'utf16le')
  const hook = binary
    ? 'Scripts.compileStorage(System.exePath+"story-observer.tjs",System.dataPath+"story.cjs",false,true,false);Scripts.execStorage(System.dataPath+"story.cjs");'
    : 'Scripts.execStorage(System.exePath+"story-observer.tjs");'
  const files = [
    { name: 'data.xp3', buffer: original },
    { name: 'patch.xp3', buffer: xp3Fixture({ 'first.ks': wide(menu) }).bytes },
    { name: 'AfterInit2.tjs', buffer: wide(hook) },
    { name: 'story-observer.tjs', buffer: wide(observer) },
  ]
  return files.map((file) => ({ ...file, mimeType: 'application/octet-stream' }))
}

export function discStoryGame(binary: boolean) {
  const mimeType = 'application/octet-stream'
  return [...discStoryProject(binary),
    { name: 'story.cue', buffer: Buffer.from(discStoryCue), mimeType },
    { name: 'story.iso', buffer: discStoryImage(), mimeType }]
}

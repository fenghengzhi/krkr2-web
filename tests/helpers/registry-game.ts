import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { distributionZip, member } from './deflated-distribution.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

const wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const registry = (caption: string, score: number, target: string) => wide([
  'Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\\Software\\KrkrRegistryFixture]',
  `"Caption"="${caption}"`, `"Score"=dword:${score.toString(16).padStart(8, '0')}`,
  `"Target"="${target}"`, '"Empty"=""', '',
].join('\r\n'))

const observer = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="registry";kag.saveDataLocation=System.dataPath;
var registryPrefix="HKEY_CURRENT_USER\\Software\\KrkrRegistryFixture\\";
function registryValue(name){return System.readRegValue(registryPrefix+name);}
var registryCaption=registryValue("Caption"),registryScore=registryValue("Score"),registryTarget=registryValue("Target");
var registryRoute=registryTarget===void?"*unconfigured":registryTarget,registryVisits=0,registryRendered="";
function registryReads(){var caption=registryValue("Caption"),score=registryValue("Score"),target=registryValue("Target");
 return [caption===void?"void":caption,score===void?"void":score,target===void?"void":target,
 int(registryValue("Empty")===""),int(registryValue("Missing")===void)].join("|");}
function registryState(){return [kag.currentLabel,kag.current.numLinks,kag.conductor.status,f.registryProgress].join("|");}
function registryStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return [saved.user.registryProgress,saved.core.mainConductor.curLabel].join("|");}
Debug.message("registry-game-ready");
`
const story = `[eval exp="f.registryProgress=0"]
*choice|Registry opening
[cm][hr][nowait][emb exp="global.registryCaption===void?'NO REGISTRY':global.registryCaption"][endnowait]
[iscript]
global.registryRendered=kag.historyLayer.currentLine;global.registryVisits++;
[endscript]
[r][link target=&global.registryRoute]Choose configured chapter[endlink] / [link target=*load]Load chapter[endlink]
[s]
*selected
[eval exp="f.registryProgress=global.registryScore"]
[jump target=*checkpoint]
*checkpoint|Registry chapter
[cm][hr][nowait]REGISTRY SAVED [emb exp="f.registryProgress"][endnowait]
[iscript]
global.registryRendered=kag.historyLayer.currentLine;global.registryVisits++;
[endscript]
[r][link target=*save]Save chapter[endlink] / [link target=*change]Change progress[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.registryProgress=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
*unconfigured
[cm][hr][nowait]Registry was not configured[endnowait][s]
*wrong
[cm][hr][nowait]WRONG REGISTRY ROUTE[endnowait][s]
`

export function registryGame(binary: boolean) {
  const original = readFileSync(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  if (hash(original) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The original KAG template changed')
  const chosen = registry('REGISTRY ROUTE', 7, '*selected'), other = registry('OTHER REGISTRY', 99, '*wrong'),
    registryFile = binary ? 'Game/config.xp3>settings.reg' : 'Game/settings.reg',
    hook = binary
      ? 'Scripts.compileStorage(System.exePath+"registry-observer.tjs",System.dataPath+"registry.cjs",false,true,false);Scripts.execStorage(System.dataPath+"registry.cjs");'
      : 'Scripts.execStorage(System.exePath+"registry-observer.tjs");',
    inputs = [
      { name: 'Game/data.xp3', bytes: original },
      { name: 'Game/patch.xp3', bytes: xp3Fixture({ 'first.ks': wide(story) }).bytes },
      { name: 'Game/AfterInit2.tjs', bytes: wide(hook) },
      { name: 'Game/registry-observer.tjs', bytes: wide(observer) },
      { name: 'Game/settings.reg', bytes: chosen },
      { name: 'Game/config.xp3', bytes: xp3Fixture({ 'settings.reg': chosen }).bytes },
      { name: 'Game/other.reg', bytes: other },
    ],
    buffer = distributionZip(inputs.map((file) => member(file.name, file.bytes)))
  return { files: [{ name: 'RegistryGame.zip', buffer, mimeType: 'application/octet-stream' }],
    registryFile, publicRegistryFile: 'game://./' + registryFile, otherFile: 'Game/other.reg',
    manifest: { binary, registryFile, selectedRegistrySha256: hash(chosen), alternateRegistrySha256: hash(other),
      zipBytes: buffer.length, zipSha256: hash(buffer),
      files: inputs.map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: hash(file.bytes) })), story, observer } }
}

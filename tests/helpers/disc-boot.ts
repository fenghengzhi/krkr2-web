import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { discStoryProject } from './disc-story.ts'
import { legacyZip } from './legacy-zip-names.ts'

export const discBootDirectory = 'DiscGame'
export const discBootVolume = 'KRKR_STORY'
const wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')

/** Reuse the original template, authored chapter menu and observer from the
 * data-disc route. All startup inputs now live inside the imported ISO. */
export function discBootProjectFiles(binary: boolean) {
  const files = discStoryProject(binary).filter((file) => file.name !== 'AfterInit2.tjs')
  const hook = String.raw`
var discBootRoot=System.exePath;
if(discBootRoot=="")throw new Exception("No project directory for the disc hook");
` + (binary
    ? 'Scripts.compileStorage(discBootRoot+"story-observer.tjs",System.dataPath+"story.cjs",false,true,false);Scripts.execStorage(System.dataPath+"story.cjs");'
    : 'Scripts.execStorage(discBootRoot+"story-observer.tjs");') + String.raw`
function discBootPaths(){return [System.exePath,Storages.getFullPath("./"),System.dataPath,
 Storages.getPlacedPath("startup.tjs"),Storages.getPlacedPath("first.ks"),discBootRoot].join("|");}
`
  return [...files,
    // A filename/configuration input only; no PE image or machine code. The
    // Windows reference always runs the separately pinned original SDK.
    { name: 'Story.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('Authored launcher name only. No executable image.\r\n') },
    { name: 'Story.cf', mimeType: 'text/plain', buffer: Buffer.from('disc-edition=pressing\r\n') },
    { name: 'AfterInit2.tjs', mimeType: 'application/octet-stream', buffer: wide(hook) }]
}

export interface DiscBootManifest {
  schema: 1
  complete: boolean
  commit: string
  images: Array<{ name: string; mode: 'source' | 'bytecode'; bytes: number; sha256: string;
    files: Array<{ name: string; bytes: number; sha256: string }>; independentlyExtracted: string[] }>
}
export function discBootInput(binary: boolean) {
  const directory = new URL('../../out/verification/disc-volumes/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('boot-manifest.json', directory), 'utf8')) as DiscBootManifest,
    name = `boot-${binary ? 'bytecode' : 'source'}.iso`, row = manifest.images.find((image) => image.name === name),
    bytes = readFileSync(new URL(name, directory))
  if (manifest.schema !== 1 || !manifest.complete || !row || bytes.length !== row.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256 ||
      (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)) throw new Error('Incomplete or mismatched boot disc input')
  const files = [{ name, mimeType: 'application/octet-stream', buffer: bytes }]
  if (binary) files.unshift({ name: 'boot.cue', mimeType: 'application/octet-stream',
    buffer: Buffer.from(`FILE "${name}" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00\n`) })
  return { files, manifest, image: row }
}

export function localizedDiscRelease(binary: boolean) {
  const { files, manifest } = discBootInput(binary), iso = files.find((file) => file.name.endsWith('.iso'))!
  // Literal unflagged Windows ZIP names; no standalone ISO fallback. The
  // mounted CUE must find the .bin before the original KAG game can start.
  const stem = Buffer.from(binary ? 'c4e8f1ea' : 'c7d1b1db', 'hex') // Диск or 한글
  const cueName = Buffer.concat([Buffer.from('Media/'), stem, Buffer.from('.cue')])
  // The CUE itself uses a different Windows code page than the archive.
  // Its image has a Unicode ZIP name, independent of both legacy settings.
  const image = binary ? '한글.bin' : 'Диск.bin'
  const imageBytes = Buffer.from(binary ? 'c7d1b1db' : 'c4e8f1ea', 'hex')
  const cue = Buffer.concat([Buffer.from('FILE "'), imageBytes, Buffer.from('.bin" BINARY\r\n TRACK 01 MODE1/2048\r\n INDEX 01 00:00:00\r\n')])
  const buffer = legacyZip([{ name: cueName, bytes: cue }, { name: 'Media/' + image, utf8: true, bytes: iso.buffer }])
  return { files: [{ name: 'Release.zip', mimeType: 'application/zip', buffer }], manifest }
}

interface DiscRelease {
  outer: string
  mode: 'source' | 'bytecode'
  volumes: Array<{ name: string; bytes: number; sha256: string }>
  image: string
  imageSha256: string
  zipSha256: string
}
export function discReleaseInput(binary: boolean) {
  const directory = new URL('../../out/verification/disc-volumes/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('release-manifest.json', directory), 'utf8')) as {
    schema: number; commit: string; releases: DiscRelease[]
  }
  const row = manifest.releases.find((release) => release.mode === (binary ? 'bytecode' : 'source'))
  if (manifest.schema !== 1 || !row || row.volumes.length !== (binary ? 3 : 1) ||
      (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)) throw new Error('Incomplete disc release')
  const files = row.volumes.map(({ name, bytes, sha256 }) => {
    const buffer = readFileSync(new URL(name, directory))
    if (buffer.length !== bytes || createHash('sha256').update(buffer).digest('hex') !== sha256)
      throw new Error('Mismatched disc release volume: ' + name)
    return { name, buffer, mimeType: 'application/octet-stream' }
  })
  if (createHash('sha256').update(Buffer.concat(files.map((file) => file.buffer))).digest('hex') !== row.zipSha256)
    throw new Error('Mismatched joined disc release')
  return { files: files.reverse(), manifest, release: row }
}

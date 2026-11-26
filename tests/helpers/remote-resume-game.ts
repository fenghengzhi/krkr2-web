import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { httpServer, type HttpFixture } from './http-server.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

export const resumeBlockBytes = 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const story = String.raw`[eval exp="f.resumeValue=0"]
*choice|Download opening
[cm][hr][nowait]RESUME READY[endnowait]
[iscript]
global.resumeRendered=kag.historyLayer.currentLine;global.resumeVisits++;
[endscript]
[r][link target=*scene]Read downloaded scene[endlink] / [link target=*load]Load slot[endlink]
[s]
*scene
[image layer=base page=fore storage=scene.bmp]
[eval exp="f.resumeValue=7"]
[jump target=*checkpoint]
*checkpoint|Downloaded scene
[cm][hr][nowait]SCENE [emb exp=f.resumeValue][endnowait]
[iscript]
global.resumeRendered=kag.historyLayer.currentLine;global.resumeVisits++;
[endscript]
[r][link target=*save]Save slot[endlink] / [link target=*change]Change[endlink] / [link target=*load]Load slot[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*checkpoint]
*change
[eval exp="f.resumeValue=99"]
[jump target=*checkpoint]
*load
[load place=0 ask=false]
`
const observer = String.raw`
kag.saveThumbnail=false;kag.saveDataMode="";kag.dataName="resume";kag.saveDataLocation=System.dataPath;
var resumeVisits=0,resumeRendered="";
function resumeState(){return [f.resumeValue,global.resumeRendered,global.resumeVisits,kag.currentLabel,kag.current.numLinks,kag.conductor.status].join("|");}
function resumePixels(){return kag.fore.base.getMainPixel(0,0)+"|"+kag.fore.base.getMaskPixel(0,0);}
function resumeStored(){var saved=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));return saved.user.resumeValue+"|"+saved.core.mainConductor.curLabel;}
Debug.message("resume-game-ready");
`

/** Valid authored BMP with a distant pixel plane. Its uncompressed XP3 is
 * several real 1 MiB copy blocks; no product decoder supplies the expectation. */
function distantBitmap(red: number, green: number, blue: number) {
  const pixelOffset = 3 * resumeBlockBytes, bytes = Buffer.alloc(pixelOffset + 8 * 8 * 3)
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(pixelOffset, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(8, 18); bytes.writeInt32LE(8, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(8 * 8 * 3, 34)
  for (let i = pixelOffset; i < bytes.length; i += 3) bytes.set([blue, green, red], i)
  return bytes
}

export async function remoteResumeGame(binary: boolean) {
  const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
  if (sha(original) !== '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
    throw new Error('The original KAG template changed')
  const patch = xp3Fixture({ 'first.ks': wide(story), 'scene.bmp': distantBitmap(51, 102, 153) }).bytes,
    changed = xp3Fixture({ 'first.ks': wide(story), 'scene.bmp': distantBitmap(153, 102, 51) }).bytes,
    inputs = [
      { path: 'data.xp3', bytes: original },
      { path: 'patch.xp3', bytes: patch },
      { path: 'AfterInit2.tjs', bytes: wide(binary
        ? 'Scripts.compileStorage(System.exePath+"resume-game.tjs",System.dataPath+"resume-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"resume-game.cjs");'
        : 'Scripts.execStorage(System.exePath+"resume-game.tjs");') },
      { path: 'resume-game.tjs', bytes: wide(observer) },
    ], manifest = Buffer.from(JSON.stringify({ version: 1, files: inputs.map((file) => file.path) }))
  let gate = false, offline = false, retired = false, closed = false, version = 1
  const held: { response?: ServerResponse; requests: number; disconnects: number } = { requests: 0, disconnects: 0 }
  const files: Record<string, HttpFixture> = {
    '/manifest.json': { bytes: manifest, full: true, intercept: (_request, response) => {
      if (!retired) return false
      response.writeHead(404).end(); return true
    } },
  }
  for (const input of inputs) files['/' + input.path] = {
    bytes: input.bytes, etag: '"' + sha(input.bytes) + '"', intercept: (request, response) => {
      if (offline) { response.writeHead(503).end(); return true }
      if (input.path === 'patch.xp3' && gate && request.headers.range === 'bytes=1048576-2097151') {
        held.requests++; held.response = response; return true
      }
      return false
    },
  }
  const server = await httpServer(files)
  return {
    server, held, manifest, source: story + '\n' + observer, patch,
    evidence: inputs.map((input) => ({ path: input.path, bytes: input.bytes.length, sha256: sha(input.bytes) })),
    firstBlockSha256: sha(patch.subarray(0, resumeBlockBytes)),
    arm() { gate = true },
    disconnect() { offline = true; held.disconnects++; held.response?.destroy() },
    restore() { offline = false; gate = false },
    manifestAvailable(available: boolean) { retired = !available },
    version(next: 1 | 2) {
      version = next
      files['/patch.xp3']!.bytes = next === 1 ? patch : changed
      files['/patch.xp3']!.etag = '"' + sha(files['/patch.xp3']!.bytes) + '"'
    },
    snapshot() { return { gate, offline, retired, closed, version, heldRequests: held.requests, disconnects: held.disconnects,
      currentPatchSha256: sha(files['/patch.xp3']!.bytes),
      requests: server.requests.map((request) => ({ ...request })), stats: server.stats() } },
    get closed() { return closed },
    async close() { if (!closed) { closed = true; await server.close() } },
  }
}

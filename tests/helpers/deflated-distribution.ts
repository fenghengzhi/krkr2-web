import { Readable } from 'node:stream'
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib'
import { longCompressedWave, xp3BackSample, xp3FarSample } from './xp3-segment-fixtures.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

interface ZipMember { name: string; size: number; crc: number; packed: Buffer }
export function member(name: string, bytes: Uint8Array | string): ZipMember {
  const plain = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  return { name, size: plain.length, crc: crc32(plain), packed: deflateRawSync(plain) }
}

// Standard single-disk ZIP with independent Node/zlib method-8 payloads.
export function distributionZip(files: readonly ZipMember[]): Buffer {
  const bodies: Buffer[] = [], records: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name), local = Buffer.alloc(30), record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(file.crc, 14); local.writeUInt32LE(file.packed.length, 18)
    local.writeUInt32LE(file.size, 22); local.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4)
    local.copy(record, 6, 4, 28); record.writeUInt32LE(offset, 42)
    bodies.push(local, name, file.packed); records.push(record, name)
    offset += local.length + name.length + file.packed.length
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...bodies, directory, end])
}

export async function musicDistribution(binary: boolean) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('The large music distribution fixture requires a GitHub-hosted runner')
  const wave = longCompressedWave()
  let crc = 0
  function* blocks() {
    for (let i = 0; i < wave.size; i += 65536) {
      const data = wave.read(i, Math.min(65536, wave.size - i))
      crc = crc32(data, crc)
      yield data
    }
  }
  const packed: Buffer[] = []
  for await (const bytes of Readable.from(blocks()).pipe(createDeflateRaw())) packed.push(Buffer.from(bytes))
  const program = `
System.exitOnNoWindowStartup=false;
Storages.addAutoPath(System.exePath+"patch.xp3>");
var patchValue=Scripts.evalStorage("chapter.tjs");
class ReleaseMusic extends WaveSoundBuffer {
 function ReleaseMusic(){super.WaveSoundBuffer(null);}
 function onLabel(name){Debug.message("release-label:"+name);}
}
var music=new ReleaseMusic();
music.open(System.exePath+"music.wav");
function playFrom(at){music.paused=true;music.samplePosition=at;music.play();music.paused=false;}
Debug.message("distribution-ready:"+patchValue);
`
  const game = xp3Fixture({
    'startup.tjs': binary ? 'Scripts.compileStorage("music.tjs",System.dataPath+"music.cjs",false,true,false);Scripts.execStorage(System.dataPath+"music.cjs");' : 'Scripts.execStorage("music.tjs");',
    'music.tjs': program,
  }, { compressed: true })
  const patch = xp3Fixture({ 'chapter.tjs': '"updated"' }, { compressed: true })
  const bytes = distributionZip([
    member('Release/data.xp3', game.bytes), member('Release/patch.xp3', patch.bytes),
    member('Release/music.wav.sli', `#2.00\nLabel {Position=12000;Name='prefix';}\nLabel {Position=${xp3FarSample + 12000};Name='far';}\nLabel {Position=${xp3BackSample + 12000};Name='back';}\n`),
    { name: 'Release/music.wav', size: wave.size, crc, packed: Buffer.concat(packed) },
  ])
  return { bytes, wave, crc, far: xp3FarSample, back: xp3BackSample }
}

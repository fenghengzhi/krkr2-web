import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflate, deflateSync } from 'node:zlib'

export const xp3SegmentText = 'XP3 segmented text: 日本語 / alpha / omega / end'
export const xp3SegmentScript = 'XP3 segmented script: 日本語 / ready'
export const xp3CompressedWaveName = 'compressed-long.wav' as const
const dataBytes = 72 * 1024 * 1024, rate = 48000, samples = dataBytes / 2
export const xp3FarSample = samples - rate * 30
export const xp3BackSample = rate * 30
export const xp3AudioRegions = [
  { id: 'prefix', startSample: 0, frequency: 500, amplitude: 12000 },
  { id: 'back', startSample: xp3BackSample, frequency: 750, amplitude: 9000 },
  { id: 'far', startSample: xp3FarSample, frequency: 1000, amplitude: 6000 },
] as const
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const u64 = (value: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }
const chunk = (name: string, bytes: Buffer) => Buffer.concat([Buffer.from(name, 'ascii'), u64(bytes.length), bytes])
const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')

/** Independent authored PCM, generated in bounded ranges. Three distinct
 * literal waves make wrong-offset reads audible as a wrong frequency/level. */
export function longCompressedWave() {
  const size = dataBytes + 44, header = Buffer.alloc(44),
    amplitudes = [
      [0, 4592, 8485, 11087, 12000, 11087, 8485, 4592, 0, -4592, -8485, -11087, -12000, -11087, -8485, -4592],
      [0, 3444, 6364, 8315, 9000, 8315, 6364, 3444, 0, -3444, -6364, -8315, -9000, -8315, -6364, -3444],
      [0, 2296, 4243, 5544, 6000, 5544, 4243, 2296, 0, -2296, -4243, -5544, -6000, -5544, -4243, -2296],
    ],
    tiles = xp3AudioRegions.map((region, index) => {
      const period = rate / region.frequency, tile = Buffer.alloc(period * 2)
      for (let i = 0; i < period; i++) tile.writeInt16LE(amplitudes[index]![Math.floor(i / (period / 16))]!, i * 2)
      return tile
    })
  header.write('RIFF', 0); header.writeUInt32LE(size - 8, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40)
  return { size, dataBytes, rate, samples, read(offset: number, length: number): Buffer {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size)
      throw new RangeError('Authored WAVE range exceeds its exact bytes')
    const bytes = Buffer.alloc(length)
    let written = 0
    if (offset < header.length) written = header.copy(bytes, 0, offset, Math.min(header.length, offset + length))
    while (written < length) {
      const raw = offset + written - header.length,
        region = raw >= xp3FarSample * 2 ? 2 : raw >= xp3BackSample * 2 ? 1 : 0,
        tile = tiles[region]!, at = (raw - xp3AudioRegions[region]!.startSample * 2) % tile.length,
        end = region === 2 ? dataBytes : xp3AudioRegions[region + 1]!.startSample * 2,
        count = Math.min(tile.length - at, length - written, end - raw)
      tile.copy(bytes, written, at, at + count); written += count
    }
    return bytes
  } }
}

export interface Xp3FixtureSegment { offset: number; originalSize: number; archivedSize: number; compressed: boolean }
export interface Xp3FixtureEntry { name: string; size: number; sha256: string; adler32: number; segments: Xp3FixtureSegment[] }

export const xp3CompressedAudioHeader = `48000|16|1|786432|0|12000|${xp3FarSample + 12000}|${xp3BackSample + 12000}`
/** Original public Wave/TextStream calls. No production archive or audio
 * implementation is imported by this fixture. The SDK observer never plays. */
export const xp3CompressedAudioSource = String.raw`
System.exitOnNoWindowStartup=false;
var xp3SegmentScript="${xp3SegmentScript}";
var xp3Audio=void,xp3AudioPhase="prefix";
class Xp3CompressedSound extends WaveSoundBuffer {
 function Xp3CompressedSound(){super.WaveSoundBuffer(null);}
 function onLabel(name){Debug.message("xp3-compressed-label:"+global.xp3AudioPhase+":"+name);}
}
function xp3CompressedText(prefix=""){
 var lines=[];lines.load(prefix+"segment-text.txt");return lines.join("\n");
}
function xp3CompressedOpen(prefix=""){
 global.xp3Audio=new Xp3CompressedSound();
 xp3Audio.open(prefix+"${xp3CompressedWaveName}");
 return [xp3Audio.frequency,xp3Audio.bits,xp3Audio.channels,xp3Audio.totalTime,xp3Audio.samplePosition,
   xp3Audio.labels["prefix"].samplePosition,xp3Audio.labels["far"].samplePosition,xp3Audio.labels["back"].samplePosition].join("|");
}
function xp3CompressedSeek(sample,phase){
 xp3Audio.paused=true;xp3Audio.samplePosition=sample;global.xp3AudioPhase=phase;
 return xp3Audio.samplePosition;
}
function xp3CompressedClose(){
 if(global.xp3Audio!==void && isvalid global.xp3Audio)invalidate global.xp3Audio;
 global.xp3Audio=void;return "closed";
}
`

/** One genuine zlib segment expands to a 72-MiB WAVE. Only 64-KiB raw chunks
 * and bounded compressed output are retained; no whole decoded member is
 * allocated by the writer. Small UTF-16 script/text entries have mixed raw and
 * zlib segments split inside a code unit, independent of the product reader. */
export async function createLongCompressedXp3(options: { startup?: string; program?: string } = {}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Large XP3 fixture generation requires a GitHub-hosted runner')
  const wave = longCompressedWave(), waveHash = createHash('sha256'), compressed: Buffer[] = []
  let compressedBytes = 0
  function* blocks() {
    for (let offset = 0; offset < wave.size; offset += 64 * 1024) {
      const bytes = wave.read(offset, Math.min(64 * 1024, wave.size - offset))
      waveHash.update(bytes); yield bytes
    }
  }
  await pipeline(Readable.from(blocks()), createDeflate({ level: 6 }), new Writable({
    write(bytes: Buffer, _encoding, done) {
      compressedBytes += bytes.length
      if (compressedBytes > 8 * 1024 * 1024) { done(new Error('Authored compressed fixture exceeds its bounded output')); return }
      compressed.push(Buffer.from(bytes)); done()
    },
  }))
  const payload = Buffer.concat(compressed), waveSha256 = waveHash.digest('hex'),
    entries: Xp3FixtureEntry[] = [], payloads: Buffer[] = [], records: Buffer[] = []
  let position = 19
  const add = (name: string, size: number, sha256: string, adler32: number,
    pieces: { bytes: Buffer; originalSize: number; compressed: boolean }[]) => {
    const segments = pieces.map((piece) => {
      const segment = { offset: position, originalSize: piece.originalSize, archivedSize: piece.bytes.length, compressed: piece.compressed }
      payloads.push(piece.bytes); position += piece.bytes.length; return segment
    })
    const archivedSize = segments.reduce((sum, segment) => sum + segment.archivedSize, 0)
    records.push(chunk('File', Buffer.concat([
      chunk('info', Buffer.concat([u32(0), u64(size), u64(archivedSize), u16(name.length), Buffer.from(name, 'utf16le')])),
      chunk('segm', Buffer.concat(segments.map((segment) => Buffer.concat([
        u32(Number(segment.compressed)), u64(segment.offset), u64(segment.originalSize), u64(segment.archivedSize),
      ])))), chunk('adlr', u32(adler32)),
    ])))
    entries.push({ name, size, sha256, adler32, segments })
  }
  const small = (name: string, bytes: Buffer, split = false) => {
    const encoded = deflateSync(bytes), pieces = split
      ? [bytes.subarray(0, 5), bytes.subarray(5, 19), bytes.subarray(19)]
      : [bytes]
    add(name, bytes.length, hash(bytes), encoded.readUInt32BE(encoded.length - 4), pieces.filter((part) => part.length > 0).map((part, index) => ({
      bytes: index === 1 ? part : deflateSync(part), originalSize: part.length, compressed: index !== 1,
    })))
  }
  small('startup.tjs', utf16(options.startup ?? 'Scripts.execStorage("compressed-audio.tjs");'))
  small('compressed-audio.tjs', utf16(options.program ?? xp3CompressedAudioSource), true)
  small('segment-text.txt', utf16(xp3SegmentText), true)
  small(xp3CompressedWaveName + '.sli', Buffer.from(`#2.00\nLabel {Position=12000;Name='prefix';}\nLabel {Position=${xp3BackSample + 12000};Name='back';}\nLabel {Position=${xp3FarSample + 12000};Name='far';}\n`))
  add(xp3CompressedWaveName, wave.size, waveSha256, payload.readUInt32BE(payload.length - 4),
    [{ bytes: payload, originalSize: wave.size, compressed: true }])
  const index = Buffer.concat(records), bytes = Buffer.concat([
    Buffer.from([88,80,51,13,10,32,10,26,139,103,1]), u64(position), ...payloads, Buffer.from([0]), u64(index.length), index,
  ])
  return { bytes, sha256: hash(bytes), wave, waveSha256, waveName: xp3CompressedWaveName,
    farSample: xp3FarSample, backSample: xp3BackSample, segmentText: xp3SegmentText, entries }
}

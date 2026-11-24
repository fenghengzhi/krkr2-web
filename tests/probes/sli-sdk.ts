import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sliInvalidNames, sliNativeFiles, sliNativeSource } from '../helpers/sli-native-fixtures.ts'
import { wavePrecisionFiles } from '../helpers/extensible-wave.ts'
import { wavePositionExpected, wavePositionFiles, wavePositionSource } from '../helpers/wave-position.ts'
import { waveFadeExpected, waveFadeDelayedExpected, waveFadeSource } from '../helpers/wave-fade.ts'
import { waveFrequencyExpected, waveFrequencyFiles, waveFrequencySource } from '../helpers/wave-frequency.ts'
import { soundOpenExpected, soundOpenFiles, soundOpenSource } from '../helpers/sound-open.ts'
import { createLongCompressedXp3, xp3CompressedAudioHeader, xp3SegmentScript, xp3SegmentText } from '../helpers/xp3-segment-fixtures.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const wine = process.argv[3] === '--wine-pulse'
assert(process.argv[3] === undefined || wine)
assert.equal(process.env.RUNNER_OS, wine ? 'Linux' : 'Windows')
const output = resolve(wine ? 'out/verification/original-sound-wine' : 'out/verification/native-eri/sli')
const game = resolve(output, 'game')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const expected: Record<string, string> = { open: 'open', names: '0|10|40|41|400|800',
  ...Object.fromEntries(sliInvalidNames.map((name) => [name, 'sli:<' + name + '.sli>'])),
  changed: 'changed:<bad-smooth.wav.sli>', reopen: 'open',
  '12-in-16.wav': 'open|48000', '20-in-24.wav': 'open|48000', '24-in-32.wav': 'open|48000',
  'foreign-guid.wav': 'wave:<foreign-guid.wav>', ...wavePositionExpected,
  ...Object.fromEntries(Object.entries(waveFadeExpected).map(([id, value]) => ['fade-' + id, value])),
  'fade-delayed': waveFadeDelayedExpected, 'frequency-original': waveFrequencyExpected,
  ...Object.fromEntries(Object.entries(soundOpenExpected).map(([kind, value]) => ['sound-open-' + kind, value])),
  'xp3-compressed': [xp3SegmentScript, xp3SegmentText, xp3CompressedAudioHeader, 'closed'].join('~') }
const precision = wavePrecisionFiles(), files = { ...sliNativeFiles(), ...precision, ...wavePositionFiles(), ...waveFrequencyFiles(), ...soundOpenFiles() }
const save = (name: string, data: unknown) => writeFileSync(resolve(output, name), JSON.stringify(data, null, 2) + '\n')
if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(resolve(game, name), bytes)
  const archive = await createLongCompressedXp3(), archiveName = 'compressed-audio.xp3'
  writeFileSync(resolve(game, archiveName), archive.bytes)
  const startup = Buffer.from('\ufeff' + [
    'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;',
    'var rows=[];function record(s){rows.add(s);rows.save("native-events.txt");}',
    'record("start");System.exceptionHandler=function(e){record("fatal|"+e.message);System.exit();return true;};',
    sliNativeSource,
    wavePositionSource,
    ...Object.keys(wavePositionExpected).map((name) =>
      `try{record("${name}|"+wavePositionObserve("${name}"));}catch(e){record("${name}|unexpected-error:"+e.message);}`),
    'System.assignMessage("TVPInvalidLoopInformation","sli:<%1>");record("open|"+sliTryOpen("native.wav"));',
    String.raw`try{var n=["start",'"quoted"',"path\\tone","日本語","selected","later"],positions=[];
      for(var i=0;i<n.count;i++){positions.add(sliSound.labels[n[i]].samplePosition);}
      record("names|"+positions.join("|"));}catch(e){record("names|"+e.message);}`,
    ...sliInvalidNames.map((name) => `record("${name}|"+sliTryOpen("${name}"));`),
    'System.assignMessage("TVPInvalidLoopInformation","changed:<%1>");',
    'record("changed|"+sliTryOpen("bad-smooth.wav"));record("reopen|"+sliTryOpen("native.wav"));',
    'System.assignMessage("TVPUnknownWaveFormat","wave:<%1>");var opened;',
    ...Object.keys(precision).map((name) =>
      `opened=sliTryOpen("${name}");record("${name}|"+opened+(opened=="open"?"|"+sliSound.frequency:""));`),
    waveFrequencySource,
    'try{record("frequency-original|"+waveFrequencyObserve());}catch(e){record("frequency-original|unexpected-error:"+e.message);}',
    soundOpenSource,
    ...Object.keys(soundOpenExpected).map((kind) =>
      `try{record("sound-open-${kind}|"+soundOpenObserve("${kind}"));}catch(e){record("sound-open-${kind}|unexpected-error:"+e.message);}`),
    // Normal public archive/TextStream/Wave open calls only. Do not play or
    // construct a device buffer: Windows audio availability is not this gate.
    'try{Scripts.execStorage("compressed-audio.xp3>compressed-audio.tjs");var xp3Proof=[xp3SegmentScript,xp3CompressedText("compressed-audio.xp3>"),xp3CompressedOpen("compressed-audio.xp3>"),xp3CompressedClose()];record("xp3-compressed|"+xp3Proof.join("~"));}catch(e){record("xp3-compressed|unexpected-error:"+e.message);}',
    waveFadeSource,
    ...Object.keys(waveFadeExpected).map((id) =>
      `try{record("fade-${id}|"+waveFadeObserve("${id}"));}catch(e){record("fade-${id}|unexpected-error:"+e.message);}`),
    'fadeDelayedAfter=function(result){global.record("fade-delayed|"+result);global.record("done");global.System.exit();};fadeDelayedStart();',
  ].join('\n'), 'utf16le')
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, startupSha256: digest(startup),
    files: Object.entries(files).map(([name, bytes]) => ({ name, sha256: digest(bytes) })),
    xp3Archive: { name: archiveName, bytes: archive.bytes.length, sha256: archive.sha256,
      waveBytes: archive.wave.size, waveSha256: archive.waveSha256, entries: archive.entries,
      scope: '72-MiB WAVE in one real zlib segment, streamed writer; mixed compressed/raw multi-segment script and text. Original SDK checks open/header/labels/text without playback.' } })
} else if (process.argv[2] === 'compare') {
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8'))
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.equal(digest(readFileSync(resolve(game, 'startup.tjs'))), manifest.startupSha256)
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(new Uint8Array(readFileSync(resolve(game, name))), bytes)
  const archiveBytes = readFileSync(resolve(game, 'compressed-audio.xp3'))
  assert.equal(manifest.xp3Archive.name, 'compressed-audio.xp3')
  assert.equal(archiveBytes.length, manifest.xp3Archive.bytes)
  assert.equal(digest(archiveBytes), manifest.xp3Archive.sha256)
  assert.equal(manifest.xp3Archive.waveBytes, 72 * 1024 * 1024 + 44)
  let sdk: { commit?: string; state?: string; exitCode?: number | null } = {}, processReportError: string | undefined
  try { sdk = JSON.parse(readFileSync(resolve(output, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, '')) }
  catch (error) { processReportError = String(error) }
  const path = resolve(game, 'native-events.txt'), raw = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = raw.toString(raw[0] === 255 && raw[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const results = Object.entries(expected).map(([id, value]) => {
    const observed = lines.filter((line) => line.startsWith(id + '|')).map((line) => line.slice(id.length + 1))
    const matched = observed.length === 1 && observed[0] === value
    const unavailable = observed.some((line) => /DirectSoundCreate failed\.\/HR=88780078/i.test(line))
    return { id, expected: value, observed, matched,
      state: !observed.length ? 'unreported' : unavailable ? 'no-sound-driver' : matched ? 'matched' : 'mismatched' }
  })
  const complete = sdk.commit === manifest.commit && sdk.state === 'observed' && sdk.exitCode === 0 &&
    lines.length === results.length + 2 && lines[0] === 'start' && lines.at(-1) === 'done' && results.every((r) => r.matched)
  save('comparison.json', { commit: manifest.commit, complete, observationSha256: digest(raw), results,
    xp3Archive: manifest.xp3Archive,
    host: wine ? 'Ubuntu / Wine 32-bit / PulseAudio' : 'Windows / DirectSound',
    processState: sdk.state ?? 'unreported', exitCode: sdk.exitCode ?? null, processReportError,
    wavePositionScope: 'Default ordinary sound mode: float coordinates, pan capability lifecycle and script errors. Device-dependent open/play failures remain failed observations, not spatial-rendering evidence or passing skips.' })
  assert(complete, 'SLI file or label dictionary observations differed')
} else throw new Error('Expected prepare or compare')

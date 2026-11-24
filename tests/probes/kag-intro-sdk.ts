import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { adler32, readXp3 } from '../../src/formats/xp3/archive.ts'
import { kagIntroSource, kagIntroStateExpression, kagIntroLayoutExpression,
  kagIntroLayoutFields, kagIntroFontMetricExpression, kagIntroFontMetricFields } from '../helpers/kag-intro-observation.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/kag-intro'), game = resolve(output, 'game')
const originalStartup = '__intro_original_startup.tjs'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n')
const textBytes = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
const inputPath = (name: string) => {
  assert(name && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') &&
    name.split('/').every((part) => part && part !== '.' && part !== '..'), 'Invalid original package path')
  const path = resolve(game, name)
  assert(path.startsWith(game + sep), 'Original package path escaped owned directory')
  return path
}
interface Input { name: string; preparedName: string; bytes: number; sha256: string }
interface Manifest { commit: string; source: typeof kagIntroSource; inputs: Input[]; observerSha256: string }
// Use a separate hidden Window after preserving the original game's layout.
// Record only identity relationships. OS interface pointer values are private.
const drawDeviceExpected = '1,1,1|0,1,2,3,4|1,1,1|0,1,1|0,1'
const drawDeviceExpression = `(function(){
  var control=new Window(),old=control.drawDevice,device=void,rows=[],failure=void;
  try{
    device=new Window.PassThroughDrawDevice();
    rows.add([int(old instanceof "PassThroughDrawDevice"),int(old===control.drawDevice),int(old!==device)].join(","));
    rows.add([device.dtNone,device.dtDrawDib,device.dtDBGDI,device.dtDBDD,device.dtDBD3D].join(","));
    device.preferredDrawer=device.dtDrawDib;
    rows.add([device.preferredDrawer,int(device.interface!=0),int(old.interface!=device.interface)].join(","));
    control.drawDevice=device;
    rows.add([int(isvalid old),int(control.drawDevice===device),device.preferredDrawer].join(","));
    control.drawDevice=void;
    rows.add([int(isvalid device),int(control.drawDevice===void)].join(","));
  }catch(error){failure=error;}
  try{invalidate control;}catch(cleanup){
    if(failure!==void)throw new Exception(failure.message+" | draw device cleanup: "+cleanup.message);
    throw cleanup;
  }
  if(failure!==void)throw failure;
  return rows.join("|");
})()`
const startup = textBytes(`
var introRecords=[];
function introRecord(value){introRecords.add(value);introRecords.save("native-events.txt");}
introRecord("start");
// Execute the original startup bytes, with every original resource at its
// original directory. The extra observer neither replaces KAG methods nor
// changes fonts, scenario, waits, labels or user input.
Scripts.execStorage("${originalStartup}");
var introTicks=0,introPrevious="",introTimer;
function introObserve(){
  var done=false;
  try{
    global.introTicks++;
    if(global.introTicks>200){global.introRecord("timeout");done=true;}
    else{
      var state=${kagIntroStateExpression};
      if(state!=="pending"){
        var fields=[].split("|",state),candidate=fields[0]=="*syokai_start" &&
          ((fields[1]=="0" && fields[6]=="0" && fields[7]=="3") || (fields[1]=="1" && fields[3]=="1"));
        if(candidate && state==global.introPrevious){
          global.introRecord("state|"+state);
          global.introRecord("layout|"+${kagIntroLayoutExpression});
          // The separate hidden Layer owns the Font used for measurement.
          // The game's live message layer keeps its settings.
          try{global.introRecord("font-metrics|"+${kagIntroFontMetricExpression});}
          catch(e){global.introRecord("font-metrics-error|"+e.message);}
          try{global.introRecord("draw-device|"+${drawDeviceExpression});}
          catch(e){global.introRecord("draw-device-error|"+e.message);}
          global.introRecord("done|"+(fields[1]=="1"?"initial-automatic-page":"initial-three-link-choice"));
          done=true;
        }
        global.introPrevious=state;
      }
    }
  }catch(e){global.introRecord("fatal|"+e.message);done=true;}
  if(done){global.introTimer.enabled=false;System.exit();}
}
introTimer=new Timer(global,"introObserve");introTimer.interval=100;introTimer.enabled=true;
`)

if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  const preparation: Record<string, unknown> = { commit: process.env.GITHUB_SHA, phase: 'acquire', complete: false,
    scope: 'Pinned original archive and per-resource hashes are integrity checks. The XP3 adlr field is recorded as opaque extraction metadata, not assumed to be a content checksum.' }
  let primary: unknown
  try {
    const response = await fetch(kagIntroSource.url, { signal: AbortSignal.timeout(30000) })
    assert(response.ok, 'Original introduction acquisition failed: HTTP ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, kagIntroSource.bytes)
    assert.equal(sha(bytes), kagIntroSource.sha256)
    writeFileSync(resolve(output, 'kag3_intro.xp3'), bytes)
    preparation.phase = 'archive-index'
    // This extractor only prepares input bytes; it supplies no font, wait or
    // rendering oracle. zlib and XP3 checks remain explicit setup failures.
    const entries = await readXp3({ size: bytes.length, async read(offset, length) {
      assert(offset >= 0 && length >= 0 && offset + length <= bytes.length)
      return bytes.subarray(offset, offset + length)
    } }, async (compressed, expected) => {
      assert(expected <= 64 * 1024 * 1024)
      const plain = inflateSync(compressed, { maxOutputLength: expected || 1 })
      assert.equal(plain.length, expected)
      return plain
    })
    assert(entries.length > 0 && entries.length <= 10000)
    const seen = new Set<string>(), inputs: Input[] = []
    let total = 0
    for (const entry of entries) {
      preparation.phase = 'resource'; preparation.resource = entry.name
      preparation.archiveFileHash = entry.xp3.fileHash ?? null
      const key = entry.name.toLowerCase()
      assert(!seen.has(key) && ![originalStartup, 'native-events.txt'].includes(key), 'Duplicate or reserved original path')
      seen.add(key)
      total += entry.size
      assert(total <= 64 * 1024 * 1024, 'Original package exceeds input preparation budget')
      const content = await entry.read(), preparedName = entry.name === 'startup.tjs' ? originalStartup : entry.name
      assert.equal(content.length, entry.size)
      const destination = inputPath(preparedName)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, content)
      const input = { name: entry.name, preparedName, bytes: content.length, sha256: sha(content),
        archiveFileHash: entry.xp3.fileHash ?? null, actualAdler32: adler32(content),
        pathCodeUnitSum: entry.name.split('').reduce((sum, character) => sum + character.charCodeAt(0), 0) }
      inputs.push(input)
      // Persist the first concrete comparison even if a later entry fails.
      if (inputs.length === 1) preparation.firstResource = input
    }
    assert(inputs.some((entry) => entry.name === 'startup.tjs'))
    assert(inputs.some((entry) => entry.name === 'scenario/first.ks'))
    preparation.phase = 'launch-observer'
    writeFileSync(inputPath('startup.tjs'), startup)
    save('inputs.json', { commit: process.env.GITHUB_SHA, source: kagIntroSource, inputs, observerSha256: sha(startup),
      scope: 'Every original resource is extracted byte-for-byte. The wrapper executes the retained original startup, observes game state, and runs its draw-device controls in a separate Window. The original XP3 is also preserved. No game methods, fonts, scenarios or inputs are replaced.' })
    preparation.complete = true
    preparation.phase = 'complete'
  } catch (error) {
    primary = error
    preparation.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
      cause: error.cause === undefined ? undefined : String(error.cause) } : String(error)
    throw error
  } finally {
    try { save('prepare-status.json', preparation) }
    catch (error) {
      if (primary !== undefined) throw new AggregateError([primary, error], 'Introduction preparation and evidence saving failed', { cause: primary })
      throw error
    }
  }
} else if (process.argv[2] === 'native') {
  const manifest = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8')) as Manifest
  assert.equal(manifest.commit, process.env.GITHUB_SHA)
  assert.deepEqual(manifest.source, kagIntroSource)
  const xp3 = readFileSync(resolve(output, 'kag3_intro.xp3'))
  assert.equal(xp3.length, kagIntroSource.bytes); assert.equal(sha(xp3), kagIntroSource.sha256)
  for (const input of manifest.inputs) {
    const bytes = readFileSync(inputPath(input.preparedName))
    assert.equal(bytes.length, input.bytes); assert.equal(sha(bytes), input.sha256)
  }
  assert.equal(sha(readFileSync(inputPath('startup.tjs'))), manifest.observerSha256)
  assert.equal(manifest.observerSha256, sha(startup))
  const path = inputPath('native-events.txt'), bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const lines = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8')
    .replace(/^\ufeff/, '').trimEnd().split(/\r?\n/)
  const processResult = JSON.parse(readFileSync(resolve(output, 'sdk-process.json'), 'utf8').replace(/^\ufeff/, '')) as {
    state: string; exitCode: number | null; commit: string; timedOut: boolean }
  const states = lines.filter((line) => line.startsWith('state|')).map((line) => line.slice(6).split('|'))
  const layouts = lines.filter((line) => line.startsWith('layout|')).map((line) => line.slice(7).split('|'))
  const fontMetricLines = lines.filter((line) => line.startsWith('font-metrics|')),
    fontMetricRows = fontMetricLines[0]?.slice('font-metrics|'.length).split(';').map((row) => row.split(',')),
    fontMetricErrors = lines.filter((line) => line.startsWith('font-metrics-error|')).map((line) => line.slice('font-metrics-error|'.length)),
    fontMetricsComplete = fontMetricLines.length === 1 && fontMetricErrors.length === 0 &&
      fontMetricRows?.length === 4 && fontMetricRows.every((row) => row.length === kagIntroFontMetricFields.length &&
        row.every((value) => value.length > 0 && Number.isFinite(Number(value))))
  const classification = lines.find((line) => line.startsWith('done|'))?.slice(5)
  const state = states[0], classified = classification === 'initial-three-link-choice'
    ? state?.[1] === '0' && state[6] === '0' && state[7] === '3'
    : classification === 'initial-automatic-page' && state?.[1] === '1' && state[3] === '1' && state[10] !== 'p'
  const drawDeviceObservation = lines.filter((line) => line.startsWith('draw-device|') || line.startsWith('draw-device-error|'))
  const drawDeviceMatched = drawDeviceObservation.length === 1 && drawDeviceObservation[0] === 'draw-device|' + drawDeviceExpected
  const observed = processResult.state === 'observed' && processResult.exitCode === 0 && !processResult.timedOut &&
    processResult.commit === manifest.commit && lines.length === 6 && lines[0] === 'start' &&
    states.length === 1 && states[0]!.length === 11 && states[0]![0] === '*syokai_start' &&
    layouts.length === 1 && layouts[0]!.length === kagIntroLayoutFields.length &&
    classified
  save('observation.json', { commit: manifest.commit, observed, classification, state: states[0],
    layout: layouts[0] && Object.fromEntries(kagIntroLayoutFields.map((name, index) => [name, layouts[0]![index]])),
    observationsSha256: sha(bytes), lines, process: processResult,
    drawDeviceMatched, drawDeviceObservation, drawDeviceExpected, fontMetricsComplete, fontMetricErrors, fontMetricFields: kagIntroFontMetricFields,
    fontMetrics: fontMetricRows?.map((row) => Object.fromEntries(kagIntroFontMetricFields.map((key, index) => [key, Number(row[index])]))),
    scope: 'Original SDK initial layout, Layer font measurements and separate Window draw-device controls. Records a three-link menu or an automatic page wait. No input was injected.' })
  assert(observed, 'Incomplete original Introduction initial-layout observation')
  assert(fontMetricsComplete, 'Incomplete separate original Introduction font measurement')
  assert(drawDeviceMatched, 'Original Window draw-device observations incomplete or different')
} else throw new Error('Expected prepare or native')

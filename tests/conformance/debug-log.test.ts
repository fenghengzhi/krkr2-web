import test from 'node:test'
import assert from 'node:assert/strict'
import { DebugLog, type LogEntry } from '../../src/engine/diagnostics/log.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
const epoch = new Date(2026, 8, 14, 12, 34, 56).getTime(),
  file = 'savedata/krkr.console.log',
  encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf16le')),
  decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf16le'),
  create = () => {
    let writes = 0,
      time = epoch
    const saves = new SaveOverlay(new MemorySaveStore(), () => writes++),
      events: LogEntry[] = [],
      log = new DebugLog(
        saves,
        () => time,
        (entry) => events.push(entry),
      )
    return { log, saves, events, writes: () => writes, tick: () => (time += 1000) }
  }

test('Debug history keeps original wall times, unsigned counts and native hundred-line trimming', () => {
  const { log, tick } = create()
  log.capture('first')
  tick()
  log.capture('second\nline')
  assert.equal(log.last(), '12:34:56 first\r\n12:34:57 second\nline\r\n')
  assert.equal(log.last(0), '')
  assert.equal(log.last(1), '12:34:57 second\nline\r\n')
  assert.equal(log.last(2 ** 32), '')
  assert.equal(log.last(-1), log.last())
  for (let i = 2; i < 2147; i++) log.capture('m' + i)
  assert.equal(log.last().split('\r\n').length - 1, 2147)
  log.capture('m2147')
  assert.equal(log.last().split('\r\n').length - 1, 2048)
  assert(log.last().startsWith('12:34:57 m100\r\n'))
})

test('late file logging preserves important entries, replays only recent ordinary history and writes UTF-16LE', () => {
  const { log, saves } = create()
  log.finish(log.begin('important 漢\ud800', true))
  for (let i = 0; i < 150; i++) log.capture('normal-' + i)
  log.start()
  log.capture('after-start')
  log.flush()
  const bytes = saves.get(file)!,
    text = decode(bytes)
  assert.deepEqual([...bytes.slice(0, 2)], [255, 254])
  assert(text.includes('12:34:56 ! important 漢\ud800\r\n'))
  assert(!text.includes('normal-49\r\n'))
  assert(text.includes('normal-50\r\n'))
  assert(text.endsWith('12:34:56 after-start\r\n'))
  assert.equal((text.match(/normal-/g) ?? []).length, 100)
})

test('log append is batched, first clear is honored and an active start remains idempotent', () => {
  const { log, saves, writes } = create()
  saves.write(file, encode('\ufeffold\r\n'))
  log.start(false)
  for (let i = 0; i < 1000; i++) log.capture('item-' + i)
  assert.equal(writes(), 1)
  log.start(true)
  log.flush()
  assert.equal(writes(), 2)
  let text = decode(saves.get(file)!)
  assert(text.startsWith('\ufeffold\r\n'))
  assert.equal((text.match(/\ufeff/g) ?? []).length, 1)
  assert.equal((text.match(/item-/g) ?? []).length, 1000)
  log.capture('second-batch')
  log.flush()
  assert.equal(writes(), 3)
  text = decode(saves.get(file)!)
  assert.equal((text.match(/Logging to/g) ?? []).length, 1)
  const fresh = new DebugLog(
    saves,
    () => epoch,
    () => {},
  )
  fresh.start(true)
  fresh.flush()
  assert(!decode(saves.get(file)!).includes('old\r\n'))
})

test('error flags, directory changes and startup arguments preserve their distinct logging behavior', () => {
  const { log, saves } = create()
  log.logToFileOnError = false
  log.error()
  log.capture('before')
  log.flush()
  assert.equal(saves.count, 0)
  saves.write(file, encode('\ufeffold\r\n'))
  log.clearLogFileOnError = true
  log.logToFileOnError = true
  log.error()
  log.capture('first-location')
  log.setLocation('logs/sub/../', new Map())
  log.capture('second-location')
  log.flush()
  assert.equal(log.location, 'logs/')
  assert(!decode(saves.get(file)!).includes('old\r\n'))
  assert(decode(saves.get(file)!).endsWith('first-location\r\n'))
  const other = decode(saves.get('logs/krkr.console.log')!)
  assert(other.endsWith('second-location\r\n'))
  assert(!other.includes('first-location'))
  assert.throws(() => log.setLocation('pack.xp3>', new Map()), /directory/)
  assert.throws(() => log.setLocation('../escape', new Map()), /escapes/)
  assert.equal(log.location, 'logs/')
  log.setLocation(
    '',
    new Map([
      ['-forcelog', 'clear'],
      ['-logerror', 'no'],
    ]),
  )
  log.flush()
  assert.equal(log.location, '')
  assert(saves.get('krkr.console.log'))
  assert.equal(log.logToFileOnError, false)
  assert.equal(log.clearLogFileOnError, false)
})

test('failed materialization retains complete pending log bytes for a later retry', () => {
  class Overlay extends SaveOverlay {
    failed = true
    override writeDiagnostic(path: string, bytes: Uint8Array) {
      if (this.failed) throw new Error('temporary write failure')
      super.writeDiagnostic(path, bytes)
    }
  }
  const saves = new Overlay(new MemorySaveStore()),
    log = new DebugLog(
      saves,
      () => epoch,
      () => {},
    )
  log.start()
  log.capture('pending')
  assert.throws(() => log.flush(), /temporary write/)
  assert.equal(saves.count, 0)
  saves.failed = false
  log.capture('later')
  log.flush()
  const text = decode(saves.get(file)!)
  assert.equal((text.match(/pending/g) ?? []).length, 1)
  assert(text.endsWith('12:34:56 pending\r\n12:34:56 later\r\n'))
})

test('history budgets reject additions, while file exhaustion preserves the game and can recover at a new location', () => {
  const { log, saves, events } = create(),
    large = 'a'.repeat(256 * 1024)
  assert.throws(() => log.begin(large + 'b'), /256 Ki/)
  assert.equal(log.last(), '')
  for (let i = 0; i < 7; i++) log.begin(large, true)
  const before = log.last()
  assert.throws(() => log.begin(large, true), /4 MiB/)
  assert.equal(log.last(), before)
  saves.write(file, new Uint8Array(16 * 1024 * 1024))
  log.start()
  assert(events.some((entry) => entry.text.includes('file budget')))
  assert.equal(saves.get(file)!.length, 16 * 1024 * 1024)
  log.setLocation('smaller/', new Map())
  log.capture('after-file-reset')
  log.flush()
  assert(decode(saves.get('smaller/krkr.console.log')!).endsWith('after-file-reset\r\n'))
})

test('a game write arriving during a diagnostic transaction keeps its critical status until its own revision commits', async () => {
  const commits: { files: { path: string; bytes: Uint8Array }[]; done(): void }[] = []
  let secondReady!: () => void
  const second = new Promise<void>((resolve) => (secondReady = resolve)),
    saves = new SaveOverlay({
      load: async () => [],
      close() {},
      commit: (files) =>
        new Promise<void>((done) => {
          commits.push({ files, done })
          if (commits.length === 2) secondReady()
        }),
    })
  saves.writeDiagnostic(file, new Uint8Array([1]))
  assert.equal(saves.hasPendingGameWrites, false)
  const flush = saves.flush()
  saves.write(file, new Uint8Array([2]))
  saves.writeDiagnostic(file, new Uint8Array([2, 3]))
  assert.equal(saves.hasPendingGameWrites, true)
  commits[0]!.done()
  await second
  assert.equal(saves.hasPendingGameWrites, true)
  assert.deepEqual([...commits[1]!.files[0]!.bytes], [2, 3])
  commits[1]!.done()
  await flush
  assert.equal(saves.pending, 0)
  assert.equal(saves.hasPendingGameWrites, false)
  saves.writeDiagnostic(file, new Uint8Array([4]))
  assert.equal(saves.hasPendingGameWrites, false)
})

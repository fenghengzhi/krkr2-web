import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DebugLog } from '../../src/engine/diagnostics/log.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'

test('history, importance, file rollback and error/start flags match 96 original KRKR2 native cases', async () => {
  const reference = JSON.parse(
    await readFile(new URL('../fixtures/debug/native.json', import.meta.url), 'utf8'),
  ) as {
    cases: {
      count: number
      automatic: boolean
      clear: boolean
      force: boolean
      history: Record<string, string>
      file: string
      observers: string
    }[]
  }
  assert.equal(reference.cases.length, 96)
  const epoch = new Date(2026, 8, 14, 12, 34, 56).getTime(),
    path = 'savedata/krkr.console.log',
    header =
      '-'.repeat(78) +
      '\r\nLogging to ' +
      path +
      ' started on ' +
      new Date(epoch).toISOString() +
      '\r\n',
    hash = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex')
  for (const row of reference.cases) {
    const saves = new SaveOverlay(new MemorySaveStore()),
      seen: string[] = [],
      log = new DebugLog(
        saves,
        () => epoch,
        (entry) => seen.push(entry.line + '\r\n'),
      )
    saves.write(path, new Uint8Array(Buffer.from('PREVIOUS\r\n', 'utf16le')))
    log.logToFileOnError = row.automatic
    log.clearLogFileOnError = row.clear
    for (let i = 0; i < row.count; i++) log.finish(log.begin('row-' + i + '漢', i % 37 === 0))
    if (row.force) log.start(row.clear)
    else log.error()
    if (row.force || row.automatic) log.start(!row.clear)
    log.capture('after')
    log.flush()
    const label = JSON.stringify([row.count, row.automatic, row.clear, row.force])
    for (const [count, expected] of Object.entries(row.history))
      assert.equal(hash(log.last(Number(count))), expected, label + ' history ' + count)
    let body = Buffer.from(saves.get(path)!).toString('utf16le')
    if (row.force || row.automatic) {
      assert.equal(body.split(header).length, 2, label + ' one OS banner')
      body = body.replace(header, '').replace(/^\ufeff/, '')
    }
    assert.equal(hash(body), row.file, label + ' file body')
    assert.equal(hash(seen.join('')), row.observers, label + ' observer lines')
  }
})

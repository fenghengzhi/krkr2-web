import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCddaSettings, formatCddaSettings } from '../../src/app/cdda-settings.ts'
import { gameSettings, summary, validateRecord, validateSummary, type LibraryRecord } from '../../src/player/library/records.ts'

test('player CUE settings preserve default-disc order, exact storage paths and explicit absence', () => {
  assert.equal(parseCddaSettings(' \r\n'), undefined)
  assert.equal(formatCddaSettings(), '')
  const expected = [{ drive: 'E', cue: 'Disc 2/score=live.cue' }, { drive: 'D', cue: 'game://./data.xp3>Disc 1.cue' }]
  const bindings = parseCddaSettings('e = Disc 2/score=live.cue\r\n\r\nD=game://./data.xp3>Disc 1.cue')
  assert.deepEqual(bindings, expected)
  assert.deepEqual(parseCddaSettings(formatCddaSettings(bindings)), expected)
  assert(Object.isFrozen(bindings)); assert(Object.isFrozen(bindings![0]))
  const labeled = parseCddaSettings('D.label=Garden=Spring\nE=disc2.cue\nE.label=\nD=disc1.cue')
  assert.deepEqual(labeled, [{ drive: 'E', cue: 'disc2.cue', volumeLabel: '' },
    { drive: 'D', cue: 'disc1.cue', volumeLabel: 'Garden=Spring' }])
  assert.deepEqual(parseCddaSettings(formatCddaSettings(labeled)), labeled)
  assert.deepEqual(parseCddaSettings('无'), [])
  assert.equal(formatCddaSettings([]), '无')
  for (const input of ['D=a.cue\nd=b.cue', 'DD=a.cue', 'D=', 'D=  ', '1=a.cue', 'E.label=orphan', 'D=a.cue\nD.label=A\nd.label=B', 'D=a.cue\nD.label=' + 'x'.repeat(256), 'D=bad\0.cue', 'D=' + 'x'.repeat(4097)])
    assert.throws(() => parseCddaSettings(input))
})

test('library CUE metadata is copied without changing old identities, and omitted updates preserve bindings', () => {
  const old: LibraryRecord = { version: 1, id: 'entry-00000000-0000-4000-8000-000000000000',
    gameId: 'game-' + '1'.repeat(64), title: 'Discs', entry: 'startup.tjs', backend: 'auto', createdAt: 1,
    size: 0, fileCount: 1, files: [{ path: 'disc.cue', size: 0, hashes: [] }] }
  assert.equal(validateRecord(old), old)
  assert.equal(Object.hasOwn(summary(old), 'cddaDiscs'), false)
  const input = [{ drive: 'e', cue: 'Second.cue' }, { drive: 'D', cue: 'First.cue' }],
    record = { ...old, ...gameSettings({ ...old, cddaDiscs: input }) }
  input[0]!.cue = 'changed.cue'
  const catalog = validateSummary(summary(validateRecord(record)))
  assert.equal(catalog.id, old.id); assert.equal(catalog.gameId, old.gameId)
  assert.deepEqual(catalog.cddaDiscs, [{ drive: 'E', cue: 'Second.cue' }, { drive: 'D', cue: 'First.cue' }])
  const olderClient = gameSettings({ title: 'Renamed', entry: 'startup.tjs', backend: 'auto' })
  assert.equal(Object.hasOwn(olderClient, 'cddaDiscs'), false)
  assert.deepEqual(summary({ ...record, ...olderClient }).cddaDiscs, catalog.cddaDiscs)
  assert.equal(summary({ ...record, ...gameSettings({ ...old, cddaDiscs: undefined }) }).cddaDiscs, undefined)
  assert.deepEqual(summary({ ...record, ...gameSettings({ ...old, cddaDiscs: [] }) }).cddaDiscs, [])
  for (const cddaDiscs of [[{ drive: 'D', cue: '' }], [{ drive: 'D', cue: 'a' }, { drive: 'd', cue: 'b' }]]) {
    assert.throws(() => validateRecord({ ...old, cddaDiscs }))
    assert.throws(() => validateSummary({ ...summary(old), cddaDiscs }))
  }
})

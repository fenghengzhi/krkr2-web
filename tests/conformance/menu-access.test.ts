import assert from 'node:assert/strict'
import test from 'node:test'
import { menuAccessKey, menuAccessMatch } from '../../src/app/menu-access.ts'

test('stock menu access keys preserve Japanese suffixes, literal ampersands and separate shortcut text', () => {
  assert.equal(menuAccessKey('System(&S)'), 's')
  assert.equal(menuAccessKey('履歴(&L)'), 'l')
  assert.equal(menuAccessKey('&Save\tCtrl+S'), 's')
  assert.equal(menuAccessKey('Rock && Roll(&R)'), 'r')
  assert.equal(menuAccessKey('Rock && Roll'), undefined)
  assert.equal(menuAccessKey('Save\t&Ctrl+S'), undefined)
  assert.equal(menuAccessKey('Ending &'), undefined)
})

test('menu access keys select unique commands and cycle duplicate siblings in their displayed order', () => {
  const names = ['&Load', 'Save(&S)', 'Speed(&S)', 'Rock && Roll', 'S&top']
  assert.deepEqual(menuAccessMatch(names, 'L'), { index: 0, unique: true })
  assert.deepEqual(menuAccessMatch(names, 's'), { index: 1, unique: false })
  assert.deepEqual(menuAccessMatch(names, 'S', 1), { index: 2, unique: false })
  assert.deepEqual(menuAccessMatch(names, 's', 2), { index: 1, unique: false })
  assert.deepEqual(menuAccessMatch(names, 't'), { index: 4, unique: true })
  assert.equal(menuAccessMatch(names, '&'), undefined)
  assert.equal(menuAccessMatch([], 's'), undefined)
})

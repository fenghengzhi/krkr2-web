import test from 'node:test'
import assert from 'node:assert/strict'
import { MenuTree } from '../../src/engine/scene/menus.ts'

function fixture() {
  const tree = new MenuTree()
  const add = (windowId: number, label: string) => {
    const root = tree.create(''),
      group = tree.create(label),
      item = tree.create('Choose')
    tree.setRoot(root, windowId)
    tree.insert(root, group, 0)
    tree.insert(group, item, 0)
    return { root, group, item }
  }
  return { tree, a: add(10, 'A'), b: add(20, 'B') }
}

test('menu snapshots isolate window roots while item IDs and revision remain global', () => {
  const { tree, a, b } = fixture()
  assert.equal(tree.snapshot(10).root?.children[0]?.caption, 'A')
  assert.equal(tree.snapshot(20).root?.children[0]?.caption, 'B')
  assert.equal(tree.snapshot().root, undefined)
  assert.deepEqual(
    tree.snapshots().map((entry) => entry.windowId),
    [10, 20],
  )
  assert.equal(new Set([a.root, a.group, a.item, b.root, b.group, b.item]).size, 6)
  assert.equal(tree.windowId(a.item), 10)
  assert.equal(tree.windowId(b.item), 20)
  const revision = tree.revision
  tree.set(a.item, 'caption', 'Changed A')
  assert.ok(tree.revision > revision)
  assert.equal(tree.snapshot(20).root?.children[0]?.children[0]?.caption, 'Choose')
  assert.equal(tree.choose(a.item, 20), false)
  assert.equal(tree.choose(a.item, 10), true)
})

test('a menu display subtree changes owner when reparented across windows', () => {
  const { tree, a, b } = fixture()
  tree.insert(b.root, a.group, 1)
  assert.equal(tree.windowId(a.item), 20)
  assert.equal(tree.snapshot(10).root?.children.length, 0)
  assert.equal(tree.snapshot(20).root?.children.length, 2)
  assert.equal(tree.choose(a.item, 10), false)
  assert.equal(tree.choose(a.item, 20), true)
  assert.throws(() => tree.insert(a.root, b.root, 0), /Cannot reparent the window menu/)
  assert.throws(() => tree.setRoot(a.root, 20), /belongs to another Window/)
})

test('hiding or detaching one window leaves another window popup pending and selectable', async () => {
  const { tree, a, b } = fixture()
  const selection = tree.openPopup(b.group, 0, 15, 25)
  const popup = tree.snapshot(20).popup!
  assert.equal(popup.windowId, 20)
  assert.equal(tree.snapshot(10).popup, undefined)
  tree.hideRoot(10)
  tree.detach(a.root)
  assert.equal(tree.hasPopup, true)
  assert.equal(tree.snapshot(20).popup?.requestId, popup.requestId)
  assert.equal(tree.choose(a.item, 10), false)
  assert.equal(tree.choose(b.item, 20, popup.requestId), false)
  assert.equal(await selection, b.item)
  assert.equal(tree.snapshot(20).root?.id, b.root)
})

test('retiring a popup window cancels only its request and leaves descendants independently alive', async () => {
  const { tree, a, b } = fixture()
  const selection = tree.openPopup(a.group, 0, 1, 2)
  tree.detach(a.root)
  assert.equal(await selection, 0)
  assert.equal(tree.has(a.group), true)
  assert.equal(tree.has(a.item), true)
  assert.equal(tree.windowId(a.item), undefined)
  assert.equal(tree.selectable(a.item), false)
  assert.equal(tree.choose(a.item, 10), false)
  assert.equal(tree.choose(b.item, 20), true)
  assert.deepEqual(
    tree.snapshots().map((entry) => entry.windowId),
    [20],
  )
})

test('a stale popup response cannot select or dismiss a later request for the same menu', async () => {
  const { tree, a } = fixture()
  const first = tree.openPopup(a.group, 0, 1, 2),
    old = tree.snapshot(10).popup!
  tree.dismiss(10, old.requestId)
  assert.equal(await first, 0)
  const second = tree.openPopup(a.group, 0, 3, 4),
    current = tree.snapshot(10).popup!
  assert.notEqual(old.requestId, current.requestId)
  tree.dismiss(10, old.requestId)
  tree.dismiss(20, current.requestId)
  assert.equal(tree.choose(a.item, 10, old.requestId), false)
  assert.equal(tree.hasPopup, true)
  tree.choose(a.item, 10, current.requestId)
  assert.equal(await second, a.item)
  assert.equal(tree.choose(a.item, 10, current.requestId), false)
})

test('moving an open popup subtree cannot leave a request owned by its former window', async () => {
  const { tree, a, b } = fixture()
  const selection = tree.openPopup(a.group, 0, 1, 2)
  tree.insert(b.root, a.group, 1)
  assert.equal(await selection, 0)
  assert.equal(tree.hasPopup, false)
  assert.equal(tree.windowId(a.item), 20)
})

test('clear releases every popup and root without reusing response identities', async () => {
  const { tree, a } = fixture()
  const selection = tree.openPopup(a.group, 0, 1, 2),
    old = tree.snapshot(10).popup!
  tree.clear()
  assert.equal(await selection, 0)
  assert.deepEqual(tree.snapshots(), [])
  assert.equal(tree.choose(a.item, 10, old.requestId), false)
  const root = tree.create(''),
    group = tree.create('Next')
  tree.setRoot(root)
  tree.insert(root, group, 0)
  const next = tree.openPopup(group, 0, 0, 0)
  assert.ok(tree.snapshot().popup!.requestId > old.requestId)
  tree.dismiss()
  assert.equal(await next, 0)
})

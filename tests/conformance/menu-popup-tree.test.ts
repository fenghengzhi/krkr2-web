import test from 'node:test'
import assert from 'node:assert/strict'
import { MenuTree } from '../../src/engine/scene/menus.ts'

function fixture() {
  const tree = new MenuTree()
  const add = (windowId: number, caption: string) => {
    const root = tree.create(''),
      group = tree.create(caption),
      nested = tree.create('Nested'),
      leaf = tree.create('Select')
    tree.setRoot(root, windowId)
    tree.insert(root, group, 0)
    tree.insert(group, nested, 0)
    tree.insert(nested, leaf, 0)
    return { root, group, nested, leaf }
  }
  return { tree, a: add(10, 'A'), b: add(20, 'B') }
}

test('recursive popup scopes preserve their parent until the child is released', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.beginPopup(a.group, 0, 10, 20)!,
    child = tree.beginPopup(b.group, 1, 30, 40)!
  assert.equal(tree.snapshot(10).popup, undefined)
  assert.equal(tree.snapshot(20).popup?.requestId, child.popup.requestId)
  assert.equal(parent.outcome, 'pending')
  assert.equal(tree.choose(a.leaf, 10, parent.popup.requestId), false)
  assert.equal(parent.outcome, 'pending')
  assert.equal(tree.choose(b.leaf, 20, child.popup.requestId), false)
  assert.equal(await child.result, b.leaf)
  assert.equal(child.outcome, 'selected')
  assert.equal(tree.hasPopup, true)
  assert.equal(tree.snapshot(20).popup, undefined)
  assert.equal(tree.snapshot(10).popup, undefined)
  assert.equal(tree.choose(a.leaf, 10), false)
  assert.equal(parent.outcome, 'pending')
  tree.releasePopup(child.popup)
  assert.equal(tree.snapshot(10).popup?.requestId, parent.popup.requestId)
  tree.dismiss(10, parent.popup.requestId)
  assert.equal(await parent.result, 0)
  tree.releasePopup(parent.popup)
  assert.equal(tree.hasPopup, false)
  assert.equal(tree.choose(a.leaf, 10), true)
})

test('a popup without the recurse flag fails without dismissing or replacing its parent', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.beginPopup(a.group, 0, 1, 2)!
  const revision = tree.revision
  assert.equal(tree.beginPopup(b.group, 0, 3, 4), undefined)
  assert.equal(tree.beginPopup(b.group, 0x180, 3, 4), undefined)
  assert.equal(await tree.openPopup(b.group, 0, 3, 4), 0)
  assert.equal(tree.revision, revision)
  assert.equal(parent.outcome, 'pending')
  assert.equal(tree.snapshot(10).popup?.requestId, parent.popup.requestId)
  tree.dismiss()
  assert.equal(await parent.result, 0)
  assert.equal(tree.beginPopup(b.group, 0, 3, 4), undefined)
  tree.releasePopup(parent.popup)
})

test('dismissing an ancestor readies only its matching scope and leaves the child usable', async () => {
  const { tree, a } = fixture()
  const parent = tree.beginPopup(a.group, 0, 1, 2)!,
    child = tree.beginPopup(a.nested, 1, 3, 4)!
  tree.dismiss(10, parent.popup.requestId)
  assert.equal(await parent.result, 0)
  assert.equal(parent.outcome, 'dismissed')
  assert.equal(child.outcome, 'pending')
  assert.equal(tree.snapshot(10).popup?.requestId, child.popup.requestId)
  tree.choose(a.leaf, 10, child.popup.requestId)
  assert.equal(await child.result, a.leaf)
  tree.releasePopup(child.popup)
  assert.equal(tree.snapshot(10).popup, undefined)
  tree.releasePopup(parent.popup)
})

test('popup release rejects a live ancestor and treats unknown identities as no-ops', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.beginPopup(a.group, 0, 1, 2)!,
    child = tree.beginPopup(b.group, 1, 3, 4)!
  assert.throws(() => tree.releasePopup(parent.popup), /LIFO/)
  tree.releasePopup({ windowId: 10, requestId: child.popup.requestId })
  assert.equal(tree.snapshot(20).popup?.requestId, child.popup.requestId)
  tree.releasePopup(child.popup)
  assert.equal(await child.result, 0)
  assert.equal(child.outcome, 'unavailable')
  tree.releasePopup(child.popup)
  assert.equal(parent.outcome, 'pending')
  assert.equal(tree.snapshot(10).popup?.requestId, parent.popup.requestId)
  tree.releasePopup(parent.popup)
  assert.equal(await parent.result, 0)
})

test('settled and released popup responses cannot become ordinary menu clicks', async () => {
  const { tree, a } = fixture()
  const old = tree.beginPopup(a.group, 0, 1, 2)!
  tree.choose(a.leaf, 10, old.popup.requestId)
  assert.equal(await old.result, a.leaf)
  assert.equal(tree.choose(a.leaf, 10, old.popup.requestId), false)
  assert.equal(tree.choose(a.leaf, 10), false)
  tree.releasePopup(old.popup)
  assert.equal(tree.choose(a.leaf, 10, old.popup.requestId), false)
  assert.equal(tree.choose(a.leaf, 10), true)
  const current = tree.beginPopup(a.group, 0, 3, 4)!
  tree.dismiss(10, old.popup.requestId)
  tree.releasePopup(old.popup)
  assert.equal(tree.choose(a.leaf, 10, old.popup.requestId), false)
  assert.equal(current.outcome, 'pending')
  assert.equal(tree.snapshot(10).popup?.requestId, current.popup.requestId)
  tree.releasePopup(current.popup)
  assert.equal(await current.result, 0)
})

test('identity-free Session selection remains compatible while explicit popup identities must match', async () => {
  const { tree, a } = fixture()
  const handle = tree.beginPopup(a.group, 0, 1, 2)!
  assert.equal(tree.choose(a.leaf, 20, handle.popup.requestId), false)
  assert.equal(tree.choose(a.leaf, 10, handle.popup.requestId + 1), false)
  assert.equal(handle.outcome, 'pending')
  assert.equal(tree.choose(a.leaf), false)
  assert.equal(await handle.result, a.leaf)
  assert.equal(handle.outcome, 'selected')
  tree.releasePopup(handle.popup)
})

test('global dismissal settles all scopes while convenience calls release in LIFO order', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.openPopup(a.group, 0, 1, 2),
    child = tree.openPopup(b.group, 1, 3, 4)
  tree.dismiss()
  assert.deepEqual(await Promise.all([parent, child]), [0, 0])
  assert.equal(tree.hasPopup, false)
})

test('popup outcomes remain terminal and distinguish user dismissal from unavailability', async () => {
  const { tree, a } = fixture()
  const dismissed = tree.beginPopup(a.group, 0, 1, 2)!
  assert.equal(dismissed.outcome, 'pending')
  assert.equal(dismissed.selectedCommand, undefined)
  tree.dismiss(10, dismissed.popup.requestId)
  tree.dismiss(10, dismissed.popup.requestId, 'unavailable')
  assert.equal(await dismissed.result, 0)
  assert.equal(dismissed.outcome, 'dismissed')
  tree.releasePopup(dismissed.popup)
  const unavailable = tree.beginPopup(a.group, 0, 1, 2)!
  tree.dismiss(10, unavailable.popup.requestId, 'unavailable')
  tree.dismiss()
  assert.equal(await unavailable.result, 0)
  assert.equal(unavailable.outcome, 'unavailable')
  tree.releasePopup(unavailable.popup)
})

test('popup validation errors leave existing scopes intact', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.beginPopup(a.group, 0, 1, 2)!,
    unattached = tree.create('Detached')
  tree.set(b.group, 'visible', 0)
  assert.throws(() => tree.beginPopup(a.root, 1, 0, 0), /cannot be shown/)
  assert.throws(() => tree.beginPopup(b.group, 1, 0, 0), /cannot be shown/)
  assert.throws(() => tree.beginPopup(unattached, 1, 0, 0), /must be attached/)
  assert.throws(() => tree.beginPopup(99999, 1, 0, 0), /invalidated/)
  assert.equal(parent.outcome, 'pending')
  assert.equal(tree.snapshot(10).popup?.requestId, parent.popup.requestId)
  tree.releasePopup(parent.popup)
  assert.equal(await parent.result, 0)
})

for (const mutation of ['remove', 'detach', 'destroy', 'hideRoot'] as const) {
  test(`${mutation} ends affected ancestor popup scopes without ending an unrelated top scope`, async () => {
    const { tree, a, b } = fixture()
    const parent = tree.beginPopup(a.group, 0, 1, 2)!,
      child = tree.beginPopup(a.nested, 1, 3, 4)!,
      unrelated = tree.beginPopup(b.group, 1, 5, 6)!
    if (mutation === 'remove') tree.remove(a.root, a.group)
    else if (mutation === 'hideRoot') tree.hideRoot(10)
    else tree[mutation](a.group)
    assert.deepEqual(await Promise.all([parent.result, child.result]), [0, 0])
    assert.equal(parent.outcome, 'unavailable')
    assert.equal(child.outcome, 'unavailable')
    assert.equal(unrelated.outcome, 'pending')
    assert.equal(tree.snapshot(20).popup?.requestId, unrelated.popup.requestId)
    tree.choose(b.leaf, 20, unrelated.popup.requestId)
    assert.equal(await unrelated.result, b.leaf)
    tree.releasePopup(unrelated.popup)
    assert.equal(tree.snapshot(10).popup, undefined)
    tree.releasePopup(child.popup)
    assert.equal(tree.snapshot(10).popup, undefined)
    tree.releasePopup(parent.popup)
    assert.equal(tree.hasPopup, false)
  })
}

test('reattaching a removed popup subtree does not revive its previous request', async () => {
  const { tree, a, b } = fixture()
  const old = tree.beginPopup(a.group, 0, 1, 2)!
  tree.insert(b.root, a.group, 1)
  assert.equal(await old.result, 0)
  assert.equal(old.outcome, 'unavailable')
  assert.equal(tree.windowId(a.leaf), 20)
  assert.equal(tree.snapshot(20).popup, undefined)
  assert.equal(tree.choose(a.leaf, 20, old.popup.requestId), false)
  tree.releasePopup(old.popup)
  const current = tree.beginPopup(a.group, 0, 3, 4)!
  assert.equal(current.popup.windowId, 20)
  assert.notEqual(current.popup.requestId, old.popup.requestId)
  tree.releasePopup(old.popup)
  assert.equal(current.outcome, 'pending')
  tree.releasePopup(current.popup)
  assert.equal(await current.result, 0)
})

test('clear settles and removes every scope without recycling view or response identities', async () => {
  const { tree, a, b } = fixture()
  const parent = tree.beginPopup(a.group, 0, 1, 2)!,
    child = tree.beginPopup(b.group, 1, 3, 4)!
  tree.clear()
  assert.deepEqual(await Promise.all([parent.result, child.result]), [0, 0])
  assert.equal(parent.outcome, 'unavailable')
  assert.equal(child.outcome, 'unavailable')
  assert.equal(tree.hasPopup, false)
  assert.deepEqual(tree.snapshots(), [])
  const root = tree.create(''),
    item = tree.create('New')
  tree.setRoot(root, 10)
  tree.insert(root, item, 0)
  assert.ok(root > b.leaf)
  const current = tree.beginPopup(item, 0, 0, 0)!
  assert.ok(current.popup.requestId > child.popup.requestId)
  tree.releasePopup(child.popup)
  tree.releasePopup(parent.popup)
  assert.equal(current.outcome, 'pending')
  assert.equal(tree.command(item), 2)
  tree.releasePopup(current.popup)
  assert.equal(await current.result, 0)
})

test('commands use the lowest free Word independently of monotonic view identities', () => {
  const tree = new MenuTree()
  const root = tree.create(''),
    first = tree.create('First'),
    second = tree.create('Second')
  assert.equal(tree.command(root), 1)
  assert.equal(tree.command(first), 2)
  assert.equal(tree.command(second), 3)
  tree.setRoot(root, 70000)
  assert.equal(tree.command(root), 0)
  const third = tree.create('Third')
  assert.equal(tree.command(third), 1)
  tree.detach(first)
  const fourth = tree.create('Fourth')
  assert.equal(tree.command(fourth), 2)
  assert.ok(fourth > third && third > second)
  tree.destroy(second)
  assert.equal(tree.command(tree.create('Fifth')), 3)
  tree.insert(root, third, 0)
  assert.deepEqual(Object.keys(tree.snapshot(70000).root!.children[0]!).sort(), [
    'caption',
    'checked',
    'children',
    'enabled',
    'id',
    'radio',
    'shortcut',
    'visible',
  ])
})

test('selecting snapshots the command before item invalidation and command reuse', async () => {
  const { tree, a } = fixture()
  tree.create('Fill the earlier root command vacancy')
  const handle = tree.beginPopup(a.group, 0, 1, 2)!,
    command = tree.command(a.leaf)
  tree.choose(a.leaf, 10, handle.popup.requestId)
  tree.detach(a.leaf)
  const replacement = tree.create('Replacement')
  assert.equal(tree.command(replacement), command)
  assert.notEqual(replacement, a.leaf)
  assert.equal(await handle.result, a.leaf)
  assert.equal(handle.outcome, 'selected')
  assert.equal(handle.selectedCommand, command)
  tree.dismiss(undefined, undefined, 'unavailable')
  tree.releasePopup(handle.popup)
  assert.equal(handle.outcome, 'selected')
  assert.equal(handle.selectedCommand, command)
})

test('native notification eligibility differs from fresh visible leaf selection', () => {
  const { tree, a } = fixture()
  assert.equal(tree.canNotify(a.group), true)
  assert.equal(tree.selectable(a.group), false)
  tree.set(a.leaf, 'caption', '-')
  assert.equal(tree.canNotify(a.leaf), true)
  assert.equal(tree.selectable(a.leaf), false)
  tree.set(a.leaf, 'caption', 'Select')
  tree.set(a.group, 'visible', 0)
  assert.equal(tree.canNotify(a.leaf), true)
  assert.equal(tree.selectable(a.leaf), false)
  tree.set(a.group, 'enabled', 0)
  assert.equal(tree.canNotify(a.leaf), false)
  tree.set(a.group, 'enabled', 1)
  tree.remove(a.root, a.group)
  assert.equal(tree.canNotify(a.leaf), true)
  assert.equal(tree.selectable(a.leaf), false)
  tree.set(a.leaf, 'enabled', 0)
  assert.equal(tree.canNotify(a.leaf), false)
  tree.set(a.leaf, 'enabled', 1)
  tree.detach(a.leaf)
  assert.equal(tree.canNotify(a.leaf), false)
})

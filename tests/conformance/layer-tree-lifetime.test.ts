import test from 'node:test'
import assert from 'node:assert/strict'
import { LayerTree } from '../../src/engine/scene/layers.ts'

test('Layer exchange dirties affected child lists without refreshing unrelated snapshots', () => {
  for (const withChildren of [false, true]) {
    const tree = new LayerTree(),
      root = tree.create(0, 41),
      first = tree.create(root),
      firstChild = tree.create(first),
      second = tree.create(root),
      secondChild = tree.create(second),
      untouched = tree.create(root),
      untouchedChild = tree.create(untouched),
      otherRoot = tree.create(0, 42),
      otherChild = tree.create(otherRoot)
    const revisions = new Map(tree.ids().map((id) => [id, tree.get(id).childrenRevision]))
    tree.exchange(first, second, withChildren)
    assert.deepEqual(tree.get(root).children, [second, first, untouched])
    assert.equal(tree.get(root).childrenRevision, revisions.get(root)! + 1)
    assert.equal(tree.get(first).childrenRevision, revisions.get(first)! + Number(!withChildren))
    assert.equal(tree.get(second).childrenRevision, revisions.get(second)! + Number(!withChildren))
    for (const id of [firstChild, secondChild, untouched, untouchedChild, otherRoot, otherChild])
      assert.equal(tree.get(id).childrenRevision, revisions.get(id))
  }
})

test('exchanging complete primary trees retains their original managers and Windows', () => {
  const tree = new LayerTree(),
    first = tree.create(0, 11),
    firstChild = tree.create(first),
    second = tree.create(0, 22),
    secondChild = tree.create(second)
  tree.exchange(first, second, true)
  assert.deepEqual(tree.get(first).children, [firstChild])
  assert.deepEqual(tree.get(second).children, [secondChild])
  for (const id of [first, firstChild])
    assert.deepEqual([tree.get(id).managerId, tree.get(id).windowId], [first, 11])
  for (const id of [second, secondChild])
    assert.deepEqual([tree.get(id).managerId, tree.get(id).windowId], [second, 22])
  assert.throws(() => tree.reparent(firstChild, second), /another primary layer/)
})

test('cross-manager node exchange fails before changing either tree or cache revision', () => {
  const tree = new LayerTree(),
    first = tree.create(0, 11),
    firstChild = tree.create(first),
    second = tree.create(0, 22),
    secondChild = tree.create(second)
  const snapshot = () =>
    tree.ids().map((id) => {
      const node = tree.get(id)
      return [
        id,
        node.parent,
        [...node.children],
        node.managerId,
        node.windowId,
        node.childrenRevision,
      ]
    })
  const before = snapshot()
  assert.throws(() => tree.exchange(first, second, false), /primary managers/)
  assert.deepEqual(snapshot(), before)
  assert.throws(() => tree.exchange(firstChild, secondChild, true), /primary managers/)
  assert.deepEqual(snapshot(), before)
})

test('detached descendants retain their manager after their primary Layer is destroyed', () => {
  const tree = new LayerTree(),
    root = tree.create(0, 31),
    first = tree.create(root),
    second = tree.create(root),
    third = tree.create(first)
  tree.destroy(root)
  assert.equal(tree.get(first).parent, 0)
  assert.equal(tree.get(second).parent, 0)
  tree.exchange(first, second, true)
  tree.reparent(first, second)
  for (const id of [first, second, third]) {
    assert.equal(tree.get(id).managerId, root)
    assert.equal(tree.get(id).windowId, 31)
    assert.equal(tree.get(id).primary, false)
  }
})

test('no-op Layer ordering preserves a cache while native detach and traversal dirty it', () => {
  const tree = new LayerTree(),
    root = tree.create(0),
    child = tree.create(root),
    sibling = tree.create(root)
  const before = tree.get(root).childrenRevision
  tree.order(child, 0)
  assert.equal(tree.get(root).childrenRevision, before)
  tree.order(sibling, 0)
  assert.equal(tree.get(root).childrenRevision, before + 1)
  const leafBefore = tree.get(child).childrenRevision
  tree.detach(child)
  assert.equal(tree.get(root).childrenRevision, before + 2)
  assert.equal(tree.get(child).childrenRevision, leafBefore + 1)
  tree.invalidateChildren(child)
  assert.equal(tree.get(child).childrenRevision, leafBefore + 2)
})

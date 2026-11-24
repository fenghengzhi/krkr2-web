import test from 'node:test'
import assert from 'node:assert/strict'
import { DrawDevices } from '../../src/engine/scene/draw-devices.ts'

test('draw devices defer backend hints and publish ownership before reentrant output retirement', () => {
  const resets: [number, boolean][] = []
  let retire = false
  const devices = new DrawDevices((window, recreate) => {
    resets.push([window, recreate])
    if (retire) devices.closeWindow(window)
  })
  try {
    // Device objects are not a separate 256-Window budget. Unattached objects
    // cannot consume a renderer's independently enforced surface inventory.
    for (let i = 0; i < 300; i++) devices.create(`unused:${i}`)
    const a = devices.create('a'), b = devices.create('b')
    devices.attach(1, a, 'a'); devices.attach(2, b, 'b')
    assert.equal(devices.drawer(a), 0)
    assert.equal(devices.prepare(1, 4, 2, 4, 2), 4)
    devices.setPreferred(a, 1)
    assert.equal(devices.prepare(1, 4, 2, 4, 2), 4)
    devices.recreate(a)
    assert.equal(devices.drawer(a), 0)
    assert.equal(devices.prepare(1, 4, 2, 4, 2), 1)
    devices.setPreferred(a, 4)
    assert.equal(devices.prepare(1, 8, 4, 4, 2), 4)
    assert.throws(() => devices.attach(3, a, 'a'), /multiple Web windows/)
    assert.throws(() => devices.attach(3, a, 'forged'), /not owned by this object/)
    const before = resets.length
    devices.attach(1, a, 'a')
    assert.equal(resets.length, before)
    retire = true
    devices.recreate(a)
    assert.equal(devices.attached(1), false)
    assert.equal(devices.attached(2), true)
    assert.equal(devices.drawer(a), 0)
    devices.destroy(a); devices.destroy(a)
    assert.throws(() => devices.drawer(a), /invalidated/)
    devices.destroy(b)
    assert.equal(devices.attached(2), false)
  } finally { devices.dispose() }
  assert.throws(() => devices.create('late'), /disposed/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowState } from '../../src/engine/scene/window.ts'
import { copyWindowGeometry, HeadlessWindowGeometry, scrollWindowGeometry, validateWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import type { WindowGeometry, WindowGeometryRequest } from '../../src/engine/ports/window-geometry.ts'
import { drawDeviceGeometry, paintBoxPoint, fromPrimary, toPrimary } from '../../src/engine/scene/draw-device.ts'

function fixture() {
  const view = new WindowState().view()
  Object.assign(view, { width: 126, height: 112, layerLeft: 5, layerTop: -2 })
  const request: WindowGeometryRequest = { requestId: 9, windowId: 2, revision: 9, view,
    menus: {}, primary: { width: 200, height: 160 }, innerRequest: { width: 120, height: 80 },
    operation: 'content', resetScroll: false }
  // Explicit independent host measurements; these insets are not Windows/VCL constants.
  const geometry: WindowGeometry = {
    revision: 9, surfaceEpoch: 3, platform: 'dom',
    outer: { x: 0, y: 0, width: 126, height: 112 },
    client: { x: 3, y: 29, width: 120, height: 80 },
    inner: { x: 3, y: 29, width: 120, height: 80 },
    viewport: { x: 3, y: 29, width: 109, height: 73 },
    paintBox: { x: -9, y: 4, width: 200, height: 160 },
    actualZoom: { numer: 1, denom: 1 },
    scrollbars: { horizontal: 7, vertical: 11 },
    scroll: { x: 17, y: 23, maxX: 96, maxY: 85 },
  }
  return { request, geometry }
}

test('geometry keeps independent outer/client/inner/viewport/paintbox measurements and copies every mutable plane', () => {
  const { request, geometry } = fixture(), value = validateWindowGeometry(request, geometry)
  assert.deepEqual(value, geometry)
  geometry.client.width = 1; geometry.scroll.x = 0; geometry.actualZoom.numer = 2
  assert.equal(value.client.width, 120)
  assert.equal(value.viewport.width, 109)
  assert.equal(value.paintBox.x, -9)
  assert.equal(value.scroll.x, 17)
  assert.equal(value.actualZoom.numer, 1)
})

test('geometry rejects mismatched paintbox transforms, revision, invalid extents and out-of-range scroll', () => {
  const { request, geometry } = fixture()
  for (const mutate of [
    (g: WindowGeometry) => { g.paintBox.x++ },
    (g: WindowGeometry) => { g.paintBox.width-- },
    (g: WindowGeometry) => { g.revision++ },
    (g: WindowGeometry) => { g.surfaceEpoch = 0 },
    (g: WindowGeometry) => { g.viewport.width = 121 },
    (g: WindowGeometry) => { g.scroll.x = 97 },
    (g: WindowGeometry) => { g.client.y = NaN },
  ]) {
    const g = copyWindowGeometry(geometry); mutate(g)
    assert.throws(() => validateWindowGeometry(request, g), /geometry/)
  }
})

test('scroll changes only paintbox origin and keeps viewport-local mouse, cursor and attention transforms reciprocal', () => {
  const { request, geometry } = fixture(), next = scrollWindowGeometry(geometry, 30, 40),
    view = { ...request.view, geometry: next }, drawing = drawDeviceGeometry(view, 200, 160)
  assert.deepEqual(next.paintBox, { x: -22, y: -13, width: 200, height: 160 })
  assert.deepEqual(next.outer, geometry.outer)
  assert.deepEqual(next.inner, geometry.inner)
  assert.deepEqual(next.viewport, geometry.viewport)
  assert.deepEqual(drawing, { x: -25, y: -42, width: 200, height: 160 })
  assert.deepEqual(paintBoxPoint(view, 7.9, 9.9), { x: 32, y: 51 })
  assert.deepEqual(toPrimary({ x: 32, y: 51 }, drawing, 200, 160), { x: 32, y: 51 })
  assert.deepEqual(fromPrimary({ x: 32, y: 51 }, drawing, 200, 160), { x: 7, y: 9 })
  assert.throws(() => scrollWindowGeometry(geometry, 97, 0), /geometry/)
})

test('unframed headless geometry is an explicit platform and inner-size requests include real sunken space', { timeout: 30000 }, async () => {
  const backend = new HeadlessWindowGeometry(), view = new WindowState().view()
  Object.assign(view, { width: 80, height: 60, innerSunken: true })
  const request: WindowGeometryRequest = { requestId: 1, revision: 1, windowId: 1, view,
    menus: {}, primary: { width: 0, height: 0 }, innerRequest: { width: 76, height: 56 },
    operation: 'outer', resetScroll: false }
  const first = await backend.measure(request)
  assert.equal(first.platform, 'headless'); assert.equal(first.surfaceEpoch, 0)
  assert.deepEqual(first.inner, { x: 2, y: 2, width: 76, height: 56 })
  const next = await backend.measure({ ...request, revision: 2, requestId: 2, operation: 'inner', size: { width: 100 } })
  assert.deepEqual(next.outer, { x: 0, y: 0, width: 104, height: 60 })
  assert.deepEqual(next.inner, { x: 2, y: 2, width: 100, height: 56 })
  backend.retire(1)
  await assert.rejects(backend.measure(request), /retired/)
  backend.dispose()
})

test('tiny sunken physical geometry stays bounded while public inner getters retain the original signed subtraction', { timeout: 30000 }, async () => {
  const backend = new HeadlessWindowGeometry(), state = new WindowState()
  state.resize(1, 3); state.set('innerSunken', 1)
  const request: WindowGeometryRequest = { requestId: 1, revision: 1, windowId: 1, view: state.view(),
    menus: {}, primary: { width: 0, height: 0 }, innerRequest: { width: 1, height: 1 },
    operation: 'outer', resetScroll: true }
  const geometry = await backend.measure(request)
  assert.deepEqual(geometry.inner, { x: 1, y: 2, width: 0, height: 0 })
  state.commitGeometry(geometry)
  assert.equal(state.innerWidth, -3)
  assert.equal(state.innerHeight, -1)
  backend.dispose()
})

test('fullscreen fitting uses saved inner preference and leaves requested public zoom independent', { timeout: 30000 }, async () => {
  const backend = new HeadlessWindowGeometry(), view = new WindowState().view()
  Object.assign(view, { width: 160, height: 90, fullScreen: true, zoomNumer: 5, zoomDenom: 4 })
  const geometry = await backend.measure({ requestId: 1, revision: 1, windowId: 1, view, menus: {},
    primary: { width: 80, height: 60 }, innerRequest: { width: 80, height: 60 }, operation: 'chrome', resetScroll: false })
  assert.deepEqual(geometry.actualZoom, { numer: 90, denom: 60 })
  assert.deepEqual(geometry.viewport, { x: 20, y: 0, width: 120, height: 90 })
  assert.deepEqual(geometry.paintBox, { x: 20, y: 0, width: 120, height: 90 })
  assert.deepEqual([view.zoomNumer, view.zoomDenom], [5, 4])
  backend.dispose()
})

test('Window requested zoom normalizes one pair atomically and each property against the current normalized pair', () => {
  const state = new WindowState()
  state.setZoom(1, 2)
  state.setZoom(4, 6)
  assert.deepEqual([state.zoomNumer, state.zoomDenom], [2, 3])
  state.set('zoomNumer', 6)
  assert.deepEqual([state.zoomNumer, state.zoomDenom], [2, 1])
  state.set('zoomDenom', 4)
  assert.deepEqual([state.zoomNumer, state.zoomDenom], [1, 2])
  assert.throws(() => state.setZoom(1, 0), /zoom/)
  assert.deepEqual([state.zoomNumer, state.zoomDenom], [1, 2])
})

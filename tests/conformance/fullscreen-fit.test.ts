import assert from 'node:assert/strict'
import test from 'node:test'
import { FullscreenOptions, fullscreenLayout } from '../../src/engine/scene/fullscreen.ts'
import { HeadlessWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import { drawDeviceGeometry, fromPrimary, paintBoxPoint, toPrimary } from '../../src/engine/scene/draw-device.ts'
import { videoOutputRectangle } from '../../src/engine/media/video-mixing.ts'

test('fullscreen options retain their last native selection, including the automatic-resolution override', () => {
  const options = new FullscreenOptions()
  const select = (resolution: string, zoom: string) => options.select(new Map([['-fsres', resolution], ['-fszoom', zoom]]))
  assert.equal(select('auto', 'no'), 'inner')
  assert.equal(select('nochange', 'no'), 'none')
  assert.equal(select('unknown', 'unknown'), 'none')
  assert.equal(select('nearest', 'outer'), 'outer')
  assert.equal(select('proportional', 'yes'), 'inner')
  const zoom = (width: number) => fullscreenLayout({ x: 0, y: 0, width, height: 1024 },
    { width: 1000, height: 800 }, 'inner').zoom
  assert.deepEqual(zoom(1033), { numer: 1, denom: 1 })
  assert.equal(zoom(1034).numer / zoom(1034).denom, 1.034)
  assert.equal(zoom(999).numer / zoom(999).denom, .999)
})

test('outer and unscaled fullscreen crop the picture symmetrically and preserve input, overlay and no-scroll coordinates', async () => {
  const host = new HeadlessWindowGeometry(), view = new WindowState().view()
  Object.assign(view, { fullScreen: true, width: 160, height: 91, zoomNumer: 5, zoomDenom: 4 })
  const request = { requestId: 1, revision: 1, windowId: 1, view, menus: {}, primary: { width: 80, height: 60 },
    innerRequest: { width: 80, height: 60 }, operation: 'chrome' as const, resetScroll: false }
  try {
    const g = await host.measure({ ...request, fullscreenZoom: 'outer' })
    assert.deepEqual(g.viewport, { x: 0, y: 0, width: 160, height: 91 })
    assert.deepEqual(g.paintBox, { x: 0, y: -14, width: 160, height: 120 })
    assert.equal(g.scroll.maxY, 0)
    const screen = { ...view, geometry: g }, device = drawDeviceGeometry(screen, 80, 60)
    assert.deepEqual(fromPrimary({ x: 30, y: 20 }, device, 80, 60), { x: 60, y: 26 })
    assert.deepEqual(toPrimary(paintBoxPoint(screen, 60, 26), device, 80, 60), { x: 30, y: 20 })
    assert.deepEqual(videoOutputRectangle({ left: 10, top: 12, width: 6, height: 7 }, screen),
      { left: 20, top: 10, width: 12, height: 14 })
    const other = await host.measure({ ...request, fullscreenZoom: 'none',
      innerRequest: { width: 201, height: 75 }, primary: { width: 201, height: 75 } })
    assert.deepEqual(other.viewport, { x: 0, y: 8, width: 160, height: 75 })
    assert.deepEqual(other.paintBox, { x: -20, y: 8, width: 201, height: 75 })
    assert.equal(other.scroll.maxX, 0)
    assert.deepEqual([view.zoomNumer, view.zoomDenom], [5, 4])
  } finally { host.dispose() }
})

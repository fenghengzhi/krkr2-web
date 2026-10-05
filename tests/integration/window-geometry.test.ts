import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { HeadlessWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import type { WindowGeometry, WindowGeometryRequest, WindowGeometryScroll } from '../../src/engine/ports/window-geometry.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
class MeasuredHost extends HeadlessWindowGeometry {
  readonly requests: WindowGeometryRequest[] = []
  readonly observers = new Set<(value: WindowGeometryScroll) => void>()
  readonly waiting = new Set<(error: unknown) => void>()
  entered = deferred<void>()
  failNext = false
  holdNext = false
  releaseHeld?: () => void
  hostClosed = false
  override async measure(request: WindowGeometryRequest): Promise<WindowGeometry> {
    this.requests.push(structuredClone(request))
    if (this.failNext) { this.failNext = false; throw new Error('Measured host refused transaction') }
    if (this.holdNext) {
      this.holdNext = false
      this.entered.resolve()
      await new Promise<void>((resolve, reject) => {
        this.waiting.add(reject)
        this.releaseHeld = () => { this.waiting.delete(reject); this.releaseHeld = undefined; resolve() }
      })
    }
    // Declared test-host measurements: 4px side/bottom, 26px top, optional
    // 20px menu expansion, 11x7 bars. These are not Windows system metrics.
    const v = request.view, edge = v.innerSunken ? 4 : 0,
      menu = request.menus.root?.children.some((child) => child.visible && child.caption === 'wrapped') ? 20 : 0,
      width = request.operation === 'inner' && request.size?.width !== undefined
        ? request.size.width + edge + 8 : request.size?.width ?? v.width,
      height = request.operation === 'inner' && request.size?.height !== undefined
        ? request.size.height + edge + 30 + menu : request.size?.height ?? v.height,
      client = { x: 4, y: 26 + menu, width: width - 8, height: height - 30 - menu },
      inner = { x: 4 + edge / 2, y: 26 + menu + edge / 2, width: client.width - edge, height: client.height - edge },
      bars = v.showScrollBars && request.primary.width > inner.width && request.primary.height > inner.height,
      viewport = { ...inner, width: inner.width - (bars ? 11 : 0), height: inner.height - (bars ? 7 : 0) },
      maxX = v.showScrollBars ? Math.max(0, v.layerLeft + request.primary.width - viewport.width) : 0,
      maxY = v.showScrollBars ? Math.max(0, v.layerTop + request.primary.height - viewport.height) : 0,
      x = request.resetScroll ? 0 : Math.min(maxX, v.geometry?.scroll.x ?? 0),
      y = request.resetScroll ? 0 : Math.min(maxY, v.geometry?.scroll.y ?? 0)
    assert.equal(v.zoomNumer, 1); assert.equal(v.zoomDenom, 1)
    return { revision: request.revision, surfaceEpoch: 7, platform: 'dom',
      outer: { x: 0, y: 0, width, height }, client, inner, viewport,
      paintBox: { x: viewport.x + v.layerLeft - x, y: viewport.y + v.layerTop - y,
        width: request.primary.width, height: request.primary.height },
      actualZoom: { numer: 1, denom: 1 },
      scrollbars: { horizontal: bars ? 7 : 0, vertical: bars ? 11 : 0 },
      scroll: { x, y, maxX, maxY } }
  }
  override subscribe(listener: (value: WindowGeometryScroll) => void) {
    this.observers.add(listener); return () => { this.observers.delete(listener) }
  }
  emit(value: WindowGeometryScroll) { for (const observer of this.observers) observer(value) }
  override dispose() {
    this.hostClosed = true
    for (const reject of this.waiting) reject(new Error('Measured host closed'))
    this.waiting.clear(); this.releaseHeld = undefined
    super.dispose()
  }
}
const source = [
  'System.exitOnWindowClose=false;',
  'var win=new Window();win.setInnerSize(100,80);win.visible=true;',
  'var root=new Layer(win,null);win.add(root);root.type=ltOpaque;root.focusable=true;',
  'root.setSize(200,160);root.fillRect(0,0,200,160,0xff123456);',
  'var windowPoint="",layerPoint="",resizes=0;',
  'win.onResize=function(){global.resizes++;};',
  'win.onMouseDown=function(x,y,button,shift){global.windowPoint=x+","+y;};',
  'root.onMouseDown=function(x,y,button,shift){global.layerPoint=x+","+y;};',
].join('\n')
async function fixture(binary: boolean, host = new MeasuredHost()) {
  const frames: { width: number; height: number; layers: Pick<FrameLayer, 'x' | 'y' | 'width' | 'height' | 'clip'>[] }[] = []
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("geometry.tjs","savedata/geometry.cjs",false,true,false);Scripts.execStorage("savedata/geometry.cjs");'
    : 'Scripts.execStorage("geometry.tjs");', 'geometry.tjs': source }, {
    windowGeometry: host,
    renderer: { present(layers, width, height) {
      frames.push({ width, height, layers: layers.map(({ x, y, width, height, clip }) => ({ x, y, width, height, clip: { ...clip } })) })
    }, dispose() {} },
  })
  try {
    await f.session.start(); await f.session.idle()
    if (binary) {
      const bytes = f.session.exportSaves().find((file) => file.path === 'savedata/geometry.cjs')!.bytes
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    const id = Number(await f.session.evaluate('win.__windowId'))
    return { ...f, host, frames, id,
      view: () => f.session.snapshot().windows!.find((window) => window.id === id)!.view,
      exec: (program: string) => f.session.evaluate('Scripts.exec(' + JSON.stringify(program + ';') + ')') }
  } catch (error) { await f.session.stop(); throw error }
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(mode + ': measured outer/client sizes stay distinct and inner setters preserve explicit preference', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '108,110,100,80')
      assert.deepEqual([f.frames.at(-1)!.width, f.frames.at(-1)!.height], [89, 73])
      await f.exec('win.setSize(180,140)')
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '180,140,172,110')
      await f.exec('win.innerSunken=true')
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '180,140,168,106')
      await f.exec('win.setInnerSize(120,90)')
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '132,124,120,90')
      assert.deepEqual(f.host.requests.at(-1)!.innerRequest, { width: 120, height: 90 })
    } finally { await f.session.stop() }
    assert.equal(f.host.hostClosed, true)
    assert.equal(f.host.observers.size, 0)
  })
  test(mode + ': actual scroll drives viewport rendering, PaintBox mouse coordinates, cursor and attention together', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const before = f.view().geometry!
      f.host.emit({ windowId: f.id, surfaceEpoch: 7, baseRevision: before.revision, sequence: 1, x: 17, y: 23 })
      assert.deepEqual(f.view().geometry!.scroll, { x: 17, y: 23, maxX: 111, maxY: 87 })
      assert.deepEqual(f.frames.at(-1)!.layers.map(({ x, y }) => [x, y]), [[-17, -23]])
      await f.session.input({ type: 'down', x: 7.9, y: 9.9, button: 0, clicks: 1, shift: 0, windowId: f.id })
      assert.equal(await f.session.evaluate('windowPoint+"|"+layerPoint'), '24,32|24,32')
      await f.exec('root.useAttention=true;root.focus();root.setAttentionPos(24,32);root.setCursorPos(24,32)')
      await f.session.idle()
      const input = f.events.filter((event) => event.type === 'window-input' && event.windowId === f.id).at(-1)!
      assert.equal(input.type, 'window-input')
      if (input.type === 'window-input') {
        assert.deepEqual([input.input.virtualCursor?.x, input.input.virtualCursor?.y], [7, 9])
        assert.deepEqual([input.input.attention?.x, input.input.attention?.y], [7, 9])
      }
      await f.exec('win.setInnerSize(120,100)')
      const committed = f.view().geometry!
      f.host.emit({ windowId: f.id, surfaceEpoch: 7, baseRevision: before.revision, sequence: 999, x: 0, y: 0 })
      assert.deepEqual(f.view().geometry, committed, 'An old host revision cannot overwrite new sizing')
      f.host.emit({ windowId: f.id, surfaceEpoch: 8, baseRevision: committed.revision, sequence: 1, x: 0, y: 0 })
      assert.deepEqual(f.view().geometry, committed, 'A replaced surface cannot move this viewport')
      await f.exec('root.setSize(180,140)')
      assert.deepEqual([f.view().geometry!.scroll.x, f.view().geometry!.scroll.y], [0, 0])
      const resized = f.view().geometry!
      f.host.emit({ windowId: f.id, surfaceEpoch: 7, baseRevision: resized.revision, sequence: 1, x: 10, y: 10 })
      await f.exec('root.setCursorPos(30,40);root.width=160;var afterWidth=root.cursorX+","+root.cursorY')
      assert.equal(await f.session.evaluate('afterWidth'), '20,30', 'Property resizing resets scroll before the next TJS statement')
      assert.deepEqual([f.view().geometry!.scroll.x, f.view().geometry!.scroll.y], [0, 0])
    } finally { await f.session.stop() }
  })
  test(mode + ': menu changes are measured before getters without rewriting the saved inner request', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('var item=new MenuItem(win,"wrapped");win.menu.add(item)')
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '108,110,100,60')
      assert.deepEqual(f.host.requests.at(-1)!.innerRequest, { width: 100, height: 80 })
      await f.exec('item.visible=false')
      assert.equal(await f.session.evaluate('win.innerHeight'), '80')
    } finally { await f.session.stop() }
  })
  test(mode + ': failed host measurement preserves prior public geometry and presentation authority', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const before = f.view().geometry!
      f.host.failNext = true
      await f.exec('try{win.setSize(190,160);}catch(e){Debug.message(e.message);}')
      assert(f.logs.some((line) => line.includes('Measured host refused transaction')))
      assert.deepEqual(f.view().geometry, before)
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '108,110,100,80')
      await f.exec('root.fillRect(0,0,200,160,0xffabcdef);root.update()')
      await f.session.idle()
      assert.deepEqual([f.frames.at(-1)!.width, f.frames.at(-1)!.height], [89, 73])
      assert.equal(f.session.snapshot().state, 'running')
    } finally { await f.session.stop() }
  })
  test(mode + ': host refresh waits for in-flight script sizing and cannot restore a stale outer request', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      f.host.holdNext = true
      const script = f.exec('win.setSize(180,140)')
      await f.host.entered.promise
      const count = f.host.requests.length, refresh = f.session.refreshWindowGeometry(f.id),
        secondRefresh = f.session.refreshWindowGeometry(f.id)
      await Promise.resolve()
      assert.equal(f.host.requests.length, count, 'Refresh has not raced the suspended script request')
      assert.deepEqual([f.view().width, f.view().height], [108, 110])
      f.host.releaseHeld!()
      await Promise.all([script, refresh, secondRefresh])
      assert.deepEqual([f.view().width, f.view().height], [180, 140])
      assert.equal(f.host.requests.at(-1)!.operation, 'content')
      assert.deepEqual([f.host.requests.at(-1)!.view.width, f.host.requests.at(-1)!.view.height], [180, 140])
      // The reverse direction must also copy its candidate after the host ACK:
      // changing only innerWidth preserves the newly measured host height.
      f.host.entered = deferred<void>(); f.host.holdNext = true
      const resized = f.session.resizeWindow(f.id, 210, 170)
      await f.host.entered.promise
      const changed = f.exec('win.innerWidth=150')
      const hostCount = f.host.requests.length
      await Promise.resolve()
      assert.equal(f.host.requests.length, hostCount)
      f.host.releaseHeld!()
      await Promise.all([resized, changed])
      assert.equal(await f.session.evaluate('[win.width,win.height,win.innerWidth,win.innerHeight].join(",")'), '158,170,150,140')
    } finally { await f.session.stop() }
  })
  test(mode + ': Stop cancels a geometry request before host reply and retires transport observation', { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    f.host.holdNext = true
    const pending = f.exec('win.setSize(190,160)').then(() => undefined, (error: unknown) => error)
    await f.host.entered.promise
    await f.session.stop()
    assert(await pending instanceof Error)
    assert.equal(f.host.hostClosed, true)
    assert.equal(f.host.waiting.size, 0)
    assert.equal(f.host.observers.size, 0)
    assert.equal(f.session.snapshot().state, 'stopped')
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
  test(mode + ': fullscreen uses saved inner requests and restores outer, sunken and normalized logical zoom', { timeout: 60000 }, async () => {
    const program = 'System.exitOnWindowClose=false;var w=new Window();w.setInnerSize(80,60);w.setSize(160,90);w.setPos(10,20);w.innerSunken=true;w.setZoom(10,8);w.visible=true;',
      f = await headless({ 'startup.tjs': binary
        ? 'Scripts.compileStorage("fullgeometry.tjs","savedata/fullgeometry.cjs",false,true,false);Scripts.execStorage("savedata/fullgeometry.cjs");'
        : 'Scripts.execStorage("fullgeometry.tjs");', 'fullgeometry.tjs': program })
    try {
      await f.session.start()
      assert.equal(await f.session.evaluate('[w.zoomNumer,w.zoomDenom,w.innerWidth,w.innerHeight].join(",")'), '5,4,156,86')
      await f.session.evaluate('w.fullScreen=true')
      const view = f.session.snapshot().windows![0]!.view
      assert.deepEqual([view.width, view.height, view.left, view.top, view.innerSunken], [160, 90, 0, 0, false])
      assert.deepEqual(view.geometry!.viewport, { x: 20, y: 0, width: 120, height: 90 })
      assert.equal(view.geometry!.actualZoom.numer / view.geometry!.actualZoom.denom, 1.5)
      assert.equal(await f.session.evaluate('[w.zoomNumer,w.zoomDenom,w.innerWidth,w.innerHeight].join(",")'), '5,4,160,90')
      await f.session.exitFullScreen()
      assert.equal(await f.session.evaluate('[w.width,w.height,w.left,w.top,w.innerSunken,w.zoomNumer,w.zoomDenom,w.innerWidth,w.innerHeight].join(",")'),
        '160,90,10,20,1,5,4,156,86')
      const errors = await f.session.evaluate('Scripts.eval("(function(){var n=0;try{w.setLayerPos(1);}catch(e){n++;}try{w.setZoom(1);}catch(e){n++;}return n;})()")')
      assert.equal(errors, '2')
    } finally { await f.session.stop() }
  })

}

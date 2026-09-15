import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import type { VideoCommand } from '../../src/engine/ports/video.ts'

class WindowVideoBackend extends LifetimeVideoBackend {
  readonly opens: { id: number; windowId?: number }[] = []
  override async command(command: VideoCommand) {
    if (command.op === 'open') this.opens.push({ id: command.id, windowId: command.windowId })
    return super.command(command)
  }
}

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

const source = String.raw`
var a=new Window(),b=new Window();
var la=new Layer(a,null),lb=new Layer(b,null);
la.setSize(1,1);lb.setSize(1,1);
la.fillRect(0,0,1,1,0xff0000ff);lb.fillRect(0,0,1,1,0xff00ff00);
var ma=new VideoOverlay(a),mb=new VideoOverlay(b);
ma.mode=vomLayer;mb.mode=vomLayer;ma.layer1=la;mb.layer1=lb;
ma.open("movie.mp4");mb.open("movie.mp4");ma.play();mb.play();
`
async function fixture(binary: boolean) {
  const video = new WindowVideoBackend(),
    harness = await headless(
      {
        'startup.tjs': '',
        'video-windows.tjs': source,
        'movie.mp4': new Uint8Array([1, 2, 3]),
      },
      { video },
    )
  try {
    await harness.session.start()
    if (binary) {
      await harness.session.evaluate(
        'Scripts.compileStorage("video-windows.tjs","savedata/video-windows.cjs",false,true,false)',
      )
      await harness.session.evaluate('Scripts.execStorage("savedata/video-windows.cjs")')
    } else await harness.session.evaluate('Scripts.execStorage("video-windows.tjs")')
    return { ...harness, video }
  } catch (error) {
    await harness.session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: video opens and Window retirement keep native window ownership`, async () => {
    const f = await fixture(binary)
    try {
      const a = Number(await f.session.evaluate('a.__windowId')),
        b = Number(await f.session.evaluate('b.__windowId')),
        ma = Number(await f.session.evaluate('ma.__videoId')),
        mb = Number(await f.session.evaluate('mb.__videoId'))
      assert.notEqual(a, b)
      assert.deepEqual(f.video.opens, [
        { id: ma, windowId: a },
        { id: mb, windowId: b },
      ])
      await f.session.evaluate('Scripts.exec("System.exitOnWindowClose=false;invalidate a;")')
      assert.deepEqual([...f.video.movies.keys()], [mb])
      assert.deepEqual(f.video.closedIds, [ma])
      assert.equal(await f.session.evaluate('ma.status+","+mb.status'), 'unload,play')
      assert.match(
        await f.session.evaluate(
          '(function(){try{ma.open("movie.mp4");return "unexpected";}catch(e){return e.message;}})()',
        ),
        /VideoOverlay is disconnected from its Window/,
      )
      await f.session.evaluate('Scripts.exec("mb.open(\\"movie.mp4\\");mb.play();")')
      assert.deepEqual(f.video.opens.at(-1), { id: mb, windowId: b })
      assert.equal(await f.session.evaluate('mb.status'), 'play')
    } finally {
      await f.session.stop()
      assert.equal(f.video.movies.size, 0)
    }
  })
  test(`${mode}: video frame copies and layer binding stay in their owner Window`, async () => {
    const f = await fixture(binary)
    try {
      const ma = Number(await f.session.evaluate('ma.__videoId')),
        mb = Number(await f.session.evaluate('mb.__videoId'))
      await f.video.emit(ma, 'frame')
      assert.equal(
        await f.session.evaluate(
          '[la.getMainPixel(0,0),la.getMaskPixel(0,0),lb.getMainPixel(0,0),lb.getMaskPixel(0,0)].join(",")',
        ),
        '16711680,255,65280,255',
      )
      await f.video.emit(mb, 'frame')
      assert.equal(
        await f.session.evaluate(
          '[la.getMainPixel(0,0),la.getMaskPixel(0,0),lb.getMainPixel(0,0),lb.getMaskPixel(0,0)].join(",")',
        ),
        '16711680,255,16711680,255',
      )
      assert.match(
        await f.session.evaluate(
          '(function(){try{ma.layer1=lb;return "unexpected";}catch(e){return e.message;}})()',
        ),
        /Video layer must belong to its Window/,
      )
      assert.equal(await f.session.evaluate('ma.layer1===la && mb.layer1===lb'), '1')
    } finally {
      await f.session.stop()
    }
  })
}

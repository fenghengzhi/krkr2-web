import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import type { FrameLayer, Renderer } from '../../src/engine/ports/graphics.ts'
import { videoFixture, videoGate } from '../helpers/video-lifetime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

interface Attempt {
  windowId: number
  accepted: boolean
  pixels: number[][]
}

const hasVideoPixels = (attempt: Attempt) =>
  attempt.pixels.some((pixel) => pixel.join(',') === '255,0,0,255')

/** A rejected surface does not pause the VM or affect another Window's surface. */
class CheckpointRenderer implements Renderer {
  readonly opened: number[] = []
  readonly blocked = new Set<number>()
  readonly attempts: Attempt[] = []
  readonly waiters = new Set<{
    windowId: number
    accepted: boolean
    resolve(): void
  }>()
  disposals = 0

  openWindow(windowId: number): void {
    this.opened.push(windowId)
  }

  videoAttempt(windowId: number, accepted: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.add({ windowId, accepted, resolve })
    })
  }

  present(layers: FrameLayer[], _width: number, _height: number, windowId = 0): boolean {
    const attempt = {
      windowId,
      accepted: !this.blocked.has(windowId),
      pixels: layers.map((layer) => [...layer.pixels.data]),
    }
    this.attempts.push(attempt)
    for (const waiter of this.waiters) {
      if (
        waiter.windowId === windowId &&
        waiter.accepted === attempt.accepted &&
        hasVideoPixels(attempt)
      ) {
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
    return attempt.accepted
  }

  dispose(): void {
    this.disposals++
    this.waiters.clear()
  }
}

function track(work: Promise<void>) {
  let settled = false
  const promise = work.finally(() => {
    settled = true
  })
  return {
    promise,
    get settled() {
      return settled
    },
  }
}

// This only drains JavaScript continuations; it cannot run a native checkpoint,
// collect a handle, flush a backend close, or ask the Session to present a frame.
const hostTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

const definitions = String.raw`
win.visible=true;win.setInnerSize(1,1);
var videoLayer=new Layer(win,null);videoLayer.setSize(1,1);
videoLayer.fillRect(0,0,1,1,0xff0000ff);
class CheckpointMovie extends VideoOverlay {
  function CheckpointMovie(){super.VideoOverlay(win);}
  function finalize(){finalized++;Debug.message("video-finalizer");}
}
function makeCheckpointMovie(){
  global.movie=new CheckpointMovie();movie.mode=vomLayer;movie.layer1=videoLayer;
  movie.open("movie.mp4");movie.play();
}
function retainedCallback(value){calls++;completed++;Debug.message("video-callback:"+value);}
function lastReferenceCallback(value){
  calls++;delete global.movie;completed++;Debug.message("video-callback:"+value);
}
function hideCheckpointWindow(){win.visible=false;}
`

async function fixture(binary: boolean, extra = '') {
  const renderer = new CheckpointRenderer(),
    f = await videoFixture(binary, definitions + extra, { renderer })
  assert.equal(renderer.opened.length, extra ? 2 : 1)
  return { ...f, renderer, windowId: renderer.opened[0]! }
}

function assertRetired(f: Awaited<ReturnType<typeof fixture>>, id: number): void {
  // Inspect immediately after the backend listener resolves. Neither idle()
  // nor evaluate() may repair a handle or resource left behind by delivery.
  assert.deepEqual(f.session.inspectOwnership(), f.baseline)
  assert.equal(f.session.snapshot().handles, f.handles)
  assert.equal(f.session.snapshot().state, 'running')
  assert.equal(f.video.movies.size, 0)
  assert.deepEqual(f.video.closedIds, [id])
  assert.equal(f.clock.tasks.size, 0)
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: a completed video callback waits for its actual Window frame presentation`, async () => {
    const f = await fixture(binary)
    let delivery: ReturnType<typeof track> | undefined
    try {
      await f.execute(
        'makeCheckpointMovie();movie.onFrameUpdate=retainedCallback incontextof movie;',
      )
      const ownership = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles,
        start = f.renderer.attempts.length,
        rejected = f.renderer.videoAttempt(f.windowId, false)
      f.renderer.blocked.add(f.windowId)
      delivery = track(f.video.emit(f.video.onlyId(), 'frame'))
      await Promise.race([
        rejected,
        delivery.promise.then(() => {
          throw new Error('Video delivery acknowledged a frame before presentation was attempted')
        }),
      ])
      await hostTurn()
      assert.deepEqual(f.logs, ['video-callback:2'])
      assert.equal(delivery.settled, false, 'present(false) cannot acknowledge the delivered frame')
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(
        f.renderer.attempts.slice(start).some((attempt) => attempt.accepted),
        false,
      )

      f.renderer.blocked.delete(f.windowId)
      f.session.present()
      await delivery.promise
      assert.ok(
        f.renderer.attempts
          .slice(start)
          .some(
            (attempt) =>
              attempt.accepted && attempt.windowId === f.windowId && hasVideoPixels(attempt),
          ),
      )
      assert.deepEqual(f.session.inspectOwnership(), ownership)
      assert.equal(f.session.snapshot().handles, handles)
      assert.deepEqual(f.logs, ['video-callback:2'])
    } finally {
      await f.session.stop()
      await delivery?.promise
    }
  })

  test(`${mode}: hiding a Window releases its pending video presentation without losing frame pixels`, async () => {
    const f = await fixture(binary)
    let delivery: ReturnType<typeof track> | undefined
    try {
      await f.execute(
        'makeCheckpointMovie();movie.onFrameUpdate=retainedCallback incontextof movie;',
      )
      const ownership = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles,
        id = f.video.onlyId(),
        start = f.renderer.attempts.length,
        rejected = f.renderer.videoAttempt(f.windowId, false)
      f.renderer.blocked.add(f.windowId)
      delivery = track(f.video.emit(id, 'frame'))
      await Promise.race([
        rejected,
        delivery.promise.then(() => {
          throw new Error('A visible Window acknowledged its video before presenting the frame')
        }),
      ])
      await hostTurn()
      assert.equal(delivery.settled, false)
      assert.deepEqual(f.logs, ['video-callback:2'])
      assert.deepEqual(f.session.inspectOwnership(), {
        ...ownership,
        eventReceipts: ownership.eventReceipts + 1,
      })
      assert.equal(f.session.snapshot().handles, handles)

      // This is the requested visibility change, after proving the visible
      // frame was still pending. The renderer continues to reject every frame,
      // including empty frames, so no presentation can masquerade as success.
      await f.execute('hideCheckpointWindow();')
      await delivery.promise
      assert.deepEqual(f.session.inspectOwnership(), ownership)
      assert.equal(f.session.snapshot().handles, handles)
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(
        f.session.snapshot().windows?.find((window) => window.id === f.windowId)?.view.visible,
        false,
      )
      assert.deepEqual([...f.video.movies.keys()], [id])
      assert.deepEqual(f.video.closedIds, [])
      assert.deepEqual(f.logs, ['video-callback:2'])
      assert.equal(f.renderer.blocked.has(f.windowId), true)
      assert.equal(
        f.renderer.attempts.slice(start).some((attempt) => attempt.accepted),
        false,
      )

      // Read the bitmap only after the receipt and native ownership assertions;
      // a query must not supply the checkpoint under test.
      assert.equal(
        await f.session.evaluate(
          '[videoLayer.getMainPixel(0,0),videoLayer.getMaskPixel(0,0)].join(",")',
        ),
        '16711680,255',
      )
    } finally {
      await f.session.stop()
      await delivery?.promise
    }
  })

  test(`${mode}: an unrelated Window rejecting presentation cannot hold a video's frame receipt`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var other=new Window();other.visible=true;other.setInnerSize(1,1);
var otherLayer=new Layer(other,null);otherLayer.setSize(1,1);
otherLayer.fillRect(0,0,1,1,0xff00ff00);
`,
    )
    let delivery: ReturnType<typeof track> | undefined
    try {
      await f.execute(
        'makeCheckpointMovie();movie.onFrameUpdate=retainedCallback incontextof movie;',
      )
      const otherId = f.renderer.opened[1]!,
        start = f.renderer.attempts.length,
        accepted = f.renderer.videoAttempt(f.windowId, true)
      f.renderer.blocked.add(otherId)
      delivery = track(f.video.emit(f.video.onlyId(), 'frame'))
      await Promise.race([
        accepted,
        delivery.promise.then(() => {
          assert.ok(
            f.renderer.attempts
              .slice(start)
              .some(
                (attempt) =>
                  attempt.accepted && attempt.windowId === f.windowId && hasVideoPixels(attempt),
              ),
            'The video receipt must follow a successful presentation of its pixels',
          )
        }),
      ])
      await hostTurn()
      assert.equal(
        delivery.settled,
        true,
        'The successful owner Window is sufficient for its frame',
      )
      await delivery.promise
      assert.deepEqual(f.logs, ['video-callback:2'])
      assert.ok(
        f.renderer.attempts
          .slice(start)
          .some((attempt) => attempt.windowId === otherId && !attempt.accepted),
      )
      assert.equal(f.renderer.blocked.has(otherId), true)
      assert.equal(f.session.snapshot().state, 'running')
    } finally {
      await f.session.stop()
      await delivery?.promise
    }
  })

  for (const event of ['frame', 'period', 'ended'] as const)
    test(`${mode}: ${event} delivery retires its final native lease and awaits asynchronous video close`, async () => {
      const f = await fixture(binary),
        gate = videoGate(),
        member =
          event === 'frame' ? 'onFrameUpdate' : event === 'period' ? 'onPeriod' : 'onStatusChanged',
        value = event === 'frame' ? '2' : event === 'period' ? '1' : 'stop'
      let delivery: ReturnType<typeof track> | undefined
      try {
        await f.execute(
          `makeCheckpointMovie();movie.${member}=lastReferenceCallback incontextof movie;`,
        )
        const id = f.video.onlyId()
        f.video.nextClose = gate
        delivery = track(f.video.emit(id, event))
        await Promise.race([
          gate.entered,
          delivery.promise.then(() => {
            throw new Error(
              'Video delivery resolved before its last native lease closed the backend',
            )
          }),
        ])
        assert.deepEqual(f.logs, [`video-callback:${value}`, 'video-finalizer'])
        assert.equal(delivery.settled, false)
        assert.equal(f.session.inspectOwnership().videoSources, 0)
        assert.equal(f.session.inspectOwnership().pendingVideoCloses, 1)
        assert.equal(f.video.movies.size, 1)
        assert.deepEqual(f.video.closedIds, [])
        gate.release()
        await delivery.promise
        assertRetired(f, id)
        assert.deepEqual(f.logs, [`video-callback:${value}`, 'video-finalizer'])
      } finally {
        gate.release()
        await f.session.stop()
        await delivery?.promise
      }
    })

  test(`${mode}: a disabled frame drops its callback and releases its lease without a presentation acknowledgement`, async () => {
    const f = await fixture(binary)
    let delivery: ReturnType<typeof track> | undefined
    try {
      await f.execute(
        'makeCheckpointMovie();movie.onFrameUpdate=retainedCallback incontextof movie;System.eventDisabled=true;',
      )
      const ownership = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles,
        start = f.renderer.attempts.length
      f.renderer.blocked.add(f.windowId)
      delivery = track(f.video.emit(f.video.onlyId(), 'frame'))
      await delivery.promise
      assert.deepEqual(f.logs, [])
      assert.deepEqual(f.session.inspectOwnership(), ownership)
      assert.equal(f.session.snapshot().handles, handles)
      assert.equal(f.session.snapshot().eventDisabled, true)
      assert.equal(
        f.renderer.attempts.slice(start).some((attempt) => attempt.accepted),
        false,
      )
      assert.equal(f.renderer.blocked.has(f.windowId), true)
    } finally {
      await f.session.stop()
      await delivery?.promise
    }
  })

  test(`${mode}: cancelling an undelivered video event owns native cleanup without claiming presentation`, async () => {
    const f = await fixture(binary),
      gate = videoGate()
    let delivery: ReturnType<typeof track> | undefined, cancellation: Promise<string> | undefined
    try {
      await f.execute(
        'makeCheckpointMovie();movie.onStatusChanged=retainedCallback incontextof movie;System.eventDisabled=true;',
      )
      const id = f.video.onlyId(),
        start = f.renderer.attempts.length
      f.renderer.blocked.add(f.windowId)
      delivery = track(f.video.emit(id, 'ended'))
      f.video.nextClose = gate
      cancellation = f.execute('invalidate movie;delete global.movie;')
      await Promise.race([
        gate.entered,
        delivery.promise.then(() => {
          throw new Error(
            'Cancellation acknowledged before native cleanup entered its backend close',
          )
        }),
      ])
      await hostTurn()
      assert.equal(delivery.settled, false)
      assert.deepEqual(f.logs, ['video-finalizer'])
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 1)
      assert.equal(f.video.movies.size, 1)
      gate.release()
      await delivery.promise
      assertRetired(f, id)
      assert.deepEqual(f.logs, ['video-finalizer'])
      assert.equal(
        f.renderer.attempts.slice(start).some((attempt) => attempt.accepted),
        false,
      )
      assert.equal(f.renderer.blocked.has(f.windowId), true)
      await cancellation
    } finally {
      gate.release()
      await cancellation
      await f.session.stop()
      await delivery?.promise
    }
  })
}

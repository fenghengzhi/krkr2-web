import test from 'node:test'
import assert from 'node:assert/strict'
import type { VideoEvent } from '../../src/engine/ports/video.ts'
import { videoFixture } from '../helpers/video-lifetime.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: frame callback arguments remain independent of public clock snapshots`,
    { timeout: 60000 }, async () => {
      const f = await videoFixture(binary, `
var frameTrace="";
function recordFrame(value){global.frameTrace+=value+":"+this.frame+"|";}
function openFrameMovie(){
  makeMovie();movie.mode=vomLayer;movie.onFrameUpdate=recordFrame incontextof movie;
  movie.open("movie.mp4");movie.play();
}
`)
      const failures: unknown[] = []
      try {
        await f.execute('openFrameMovie();')
        const id = f.video.onlyId()
        const emit = async (clockFrame: number, callbackFrame?: number) => {
          const snapshot = { ...f.video.movies.get(id)!, frame: clockFrame }
          f.video.movies.set(id, snapshot)
          const event: VideoEvent = { type: 'frame', id, epoch: snapshot.epoch, snapshot,
            ...(callbackFrame === undefined ? {} : { callbackFrame }) }
          await Promise.all([...f.video.listeners].map((listener) => listener(event)))
        }
        await emit(10, 9)
        await emit(10)
        await emit(0, -1)
        assert.equal(await f.session.evaluate('frameTrace'), '9:10|10:10|-1:0|')
        assert.equal(await f.session.evaluate('movie.frame'), '0')
      } catch (error) { failures.push(error) }
      try { await f.session.stop(); f.stopped() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Video frame callback and cleanup failed', { cause: failures[0] })
    })

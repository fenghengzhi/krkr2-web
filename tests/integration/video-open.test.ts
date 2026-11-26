import assert from 'node:assert/strict'
import test from 'node:test'
import { videoFixture } from '../helpers/video-lifetime.ts'
import { videoOpenSource } from '../helpers/video-open.ts'

type Fixture = Awaited<ReturnType<typeof videoFixture>>
async function scenario(binary: boolean, body: (fixture: Fixture) => Promise<void>) {
  const fixture = await videoFixture(binary, videoOpenSource + '\nglobal.movie=new OpenMovie(win);'), failures: unknown[] = []
  try { await body(fixture) } catch (error) { failures.push(error) }
  try { await fixture.session.stop(); fixture.stopped() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Video open ordering or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: invalid VideoOverlay open arguments preserve a paused or playing graph and its dynamic native error messages`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");movie.loop=true;movie.audioVolume=25000;movie.audioBalance=25000;')
      for (const state of ['pause', 'play'] as const) {
        await f.execute(`movie.${state}();movie.states.clear();videoOpenHolders("${state}");`)
        const id = f.video.onlyId(), graph = f.video.movies.get(id)!, before = { ...graph },
          commands = f.video.commands.length, closed = f.video.closedIds.length, owned = f.session.inspectOwnership()
        assert.equal(await f.session.evaluate('videoOpenErrors(movie)'), `${state}-count|${state}-string`)
        assert.equal(f.video.commands.length, commands, 'Argument failures must not send close, inspect or replacement-open commands')
        assert.equal(f.video.closedIds.length, closed)
        assert.equal(f.video.movies.get(id), graph, 'The actual owned media record survives both failures')
        assert.deepEqual(graph, before)
        assert.deepEqual(f.session.inspectOwnership(), owned)
        assert.equal(await f.session.evaluate('movie.states.join(",")'), '')
        assert.equal(await f.session.evaluate('movie.status'), state)
      }
      await f.execute('movie.close();')
      const commands = f.video.commands.length
      assert.equal(await f.session.evaluate('videoOpenErrors(movie)'), 'play-count|play-string')
      assert.equal(f.video.commands.length, commands)
      assert.equal(await f.session.evaluate('movie.status'), 'unload')
    }))
  test(`${label}: converted missing names still retire the old movie, and extra arguments do not prevent a valid replacement`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('movie.open("movie.mp4");movie.play();movie.states.clear();')
      const old = f.video.onlyId(), closes = f.video.closedIds.length
      const missing = await f.session.evaluate('videoOpenMissing(movie,"absent.mp4")')
      assert.notEqual(missing, 'unexpected-success'); assert(missing.length > 0)
      assert.equal(f.video.closedIds.length, closes + 1); assert.equal(f.video.closedIds.at(-1), old)
      assert.equal(f.video.movies.size, 0)
      assert.equal(await f.session.evaluate('movie.status+"|"+movie.states.join(",")'), 'unload|unload')
      await f.execute('movie.open("movie.mp4",<%00%>,%[]);movie.play();movie.states.clear();')
      assert.equal(f.video.movies.size, 1)
      assert.equal(await f.session.evaluate('movie.status'), 'play')
      // Explicit void is a supplied parameter. Its normal string conversion
      // enters Open and therefore retires the graph before lookup fails.
      const empty = await f.session.evaluate('videoOpenMissing(movie,void)')
      assert.notEqual(empty, 'unexpected-success'); assert(empty.length > 0)
      assert.equal(f.video.movies.size, 0)
      assert.equal(await f.session.evaluate('movie.status+"|"+movie.states.join(",")'), 'unload|unload')
      await f.execute('movie.open("movie.mp4");movie.pause();')
      assert.equal(await f.session.evaluate('movie.status'), 'pause')
    }))
}

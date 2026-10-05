import test from 'node:test'
import assert from 'node:assert/strict'
import { videoFixture } from '../helpers/video-lifetime.ts'

const source = `
makeMovie();
function openAudio(){movie.open("movie.mp4");}
function readAudio(){return movie.audioVolume+","+movie.audioBalance;}
function writeAudio(v,b){movie.audioVolume=v;movie.audioBalance=b;return readAudio();}
`
type Fixture = Awaited<ReturnType<typeof videoFixture>>
async function scenario(binary: boolean, body: (f: Fixture) => Promise<void>) {
  const f = await videoFixture(binary, source), failures: unknown[] = []
  try { await body(f) } catch (error) { failures.push(error) }
  try { await f.session.stop(); f.stopped() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Video native audio controls and cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const label = binary ? 'bytecode' : 'source'
  test(`${label}: public volume readback is independent of audible graph settings and balance reads native steps`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('openAudio();')
      assert.equal(await f.session.evaluate('writeAudio(25999,-75999)'), '100000,-75000')
      let graph = f.video.movies.get(f.video.onlyId())!
      assert.equal(graph.audioVolume, 25999); assert.equal(graph.audioBalance, -75999)
      const commands = f.video.commands.length
      assert.equal(await f.session.evaluate('movie.audioVolume'), '100000')
      assert.equal(f.video.commands.length, commands, 'The fixed native getter never queries the audio device')
      assert.equal(await f.session.evaluate('readAudio()'), '100000,-75000')
      await f.execute('movie.playRate=2;movie.loop=true;movie.position=20;')
      graph = f.video.movies.get(f.video.onlyId())!
      assert.equal(graph.audioVolume, 25999, 'An unrelated settings update must retain the actual volume')
      assert.equal(graph.audioBalance, -75999)
      assert.equal(await f.session.evaluate('writeAudio(0,99999)'), '100000,100000')
      assert.equal(f.video.movies.get(f.video.onlyId())!.audioVolume, 0, 'Reading the native getter must not unmute the graph')
    }))
  test(`${label}: audio controls narrow TJS integers through signed 32 bits before applying their domain limits`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('openAudio();')
      assert.equal(await f.session.evaluate('writeAudio(4295017295,4294993295)'), '100000,25000')
      let graph = f.video.movies.get(f.video.onlyId())!
      assert.equal(graph.audioVolume, 49999); assert.equal(graph.audioBalance, 25999)
      assert.equal(await f.session.evaluate('writeAudio(2147483648,2147483648)'), '100000,-100000')
      graph = f.video.movies.get(f.video.onlyId())!
      assert.equal(graph.audioVolume, 0); assert.equal(graph.audioBalance, -100000)
      assert.equal(await f.session.evaluate('writeAudio(9223372036854775807,9223372036854775807)'), '100000,0')
      assert.equal(f.video.movies.get(f.video.onlyId())!.audioVolume, 0)
    }))
  test(`${label}: graph replacement resets audio controls and closed writes cannot become open preferences`, { timeout: 60000 },
    () => scenario(binary, async (f) => {
      await f.execute('openAudio();writeAudio(25000,-25999);movie.close();')
      assert.equal(await f.session.evaluate('writeAudio(2147483648,99999)'), '100000,0')
      await f.execute('openAudio();')
      const graph = f.video.movies.get(f.video.onlyId())!
      assert.equal(graph.audioVolume, 100000); assert.equal(graph.audioBalance, 0)
      assert.equal(await f.session.evaluate('readAudio()'), '100000,0')
    }))
}

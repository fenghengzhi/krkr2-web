import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { headless } from './headless.ts'
import { AudioClock } from './audio.ts'
import { LifetimeAudioBackend } from './sound-lifetime-audio.ts'
import { LifetimeVideoBackend } from './video-lifetime-backend.ts'
export { videoGate } from './video-lifetime-backend.ts'

export async function videoFixture(
  binary: boolean,
  definitions = '',
  overrides: Partial<SessionDependencies> = {},
) {
  const video = new LifetimeVideoBackend(),
    audio = new LifetimeAudioBackend(),
    clock = new AudioClock()
  let rendererCloses = 0
  const harness = await headless(
    {
      'startup.tjs': '',
      'movie.mp4': new Uint8Array([1, 2, 3]),
      'tone.wav': new Uint8Array([1]),
      'video-lifetime.tjs': `
var calls=0,finalized=0,completed=0,caught="",receiver="",failVideo=false,failConstruct=false;
try{throw new Exception("warm video exception");}catch(e){}
var win=new Window();
class LifetimeMovie extends VideoOverlay {
  var marker="movie-owner";
  function LifetimeMovie(){super.VideoOverlay(win);if(failConstruct){open("movie.mp4");play();throw new Exception("video-constructor");}}
  function finalize(){finalized++;if(failVideo)throw new Exception("video-finalizer");}
}
function makeMovie(){global.movie=new LifetimeMovie();}
${definitions}
`,
    },
    {
      video,
      audio,
      now: () => clock.now,
      schedule: clock.schedule,
      renderer: {
        present() {},
        dispose() {
          rendererCloses++
        },
      },
      ...overrides,
    },
  )
  const { session } = harness
  const execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("video-lifetime.tjs","savedata/video-lifetime.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/video-lifetime.cjs")')
    } else await session.evaluate('Scripts.execStorage("video-lifetime.tjs")')
    await execute(
      'var warmVideo=new VideoOverlay(win);warmVideo.status;invalidate warmVideo;delete global.warmVideo;',
    )
    assert.equal(await session.evaluate('6*7'), '42')
    const baseline = session.inspectOwnership(),
      handles = session.snapshot().handles
    const restored = async () => {
      await session.idle()
      assert.deepEqual(session.inspectOwnership(), baseline)
      assert.equal(session.snapshot().handles, handles)
      assert.equal(session.snapshot().state, 'running')
      assert.equal(video.movies.size, 0)
      assert.equal(clock.tasks.size, 0)
    }
    const stopped = () => {
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      assert.equal(session.snapshot().handles, 0)
      assert.equal(video.movies.size, 0)
      assert.equal(video.listeners.size, 0)
      assert.equal(audio.voices.size, 0)
      assert.equal(audio.listeners.size, 0)
      assert.equal(clock.tasks.size, 0)
      assert.equal(rendererCloses, 1)
    }
    return { ...harness, video, audio, clock, execute, baseline, handles, restored, stopped }
  } catch (error) {
    await session.stop()
    throw error
  }
}

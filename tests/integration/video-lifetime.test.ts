import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { videoFixture, videoGate } from '../helpers/video-lifetime.ts'
const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: displaying a returned video object releases the last native result handle`, async () => {
    const f = await videoFixture(
      binary,
      'function returnedMovie(){var result=new LifetimeMovie();result.open("movie.mp4");result.play();return result;}',
    )
    try {
      assert.equal(await f.session.evaluate('returnedMovie()'), '[TJS object]')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '1')
      assert.equal(f.video.closedIds.length, 1)
    } finally {
      await f.session.stop()
    }
  })
  test(`${mode}: displaying a returned sound object drains its native handle and resource`, async () => {
    const f = await videoFixture(
      binary,
      'class ReturnedSound extends WaveSoundBuffer {function ReturnedSound(){super.WaveSoundBuffer(null);open("tone.wav");play();}function finalize(){finalized++;}}',
    )
    try {
      assert.equal(await f.session.evaluate('new ReturnedSound()'), '[TJS object]')
      await f.restored()
      assert.equal(f.audio.voices.size, 0)
      assert.equal(await f.session.evaluate('finalized'), '1')
    } finally {
      await f.session.stop()
    }
  })
  for (const activity of ['unopened', 'opened', 'playing'])
    test(`${mode}: implicit ${activity} video release retires its native owner and media`, async () => {
      const f = await videoFixture(binary)
      try {
        await f.execute(
          'makeMovie();' +
            (activity !== 'unopened' ? 'movie.open("movie.mp4");' : '') +
            (activity === 'playing' ? 'movie.play();' : ''),
        )
        assert.equal(f.session.inspectOwnership().videoSources, 1)
        assert.equal(f.session.inspectOwnership().weakOwners, f.baseline.weakOwners + 2)
        assert.equal(await f.session.evaluate('win.__windowObjects.count'), '0')
        await f.execute('delete global.movie;')
        await f.restored()
        assert.equal(await f.session.evaluate('finalized'), '1')
        assert.equal(f.video.closedIds.length, activity === 'unopened' ? 0 : 1)
      } finally {
        await f.session.stop()
      }
    })

  test(`${mode}: direct video finalize preserves media until native invalidation`, async () => {
    const f = await videoFixture(binary)
    try {
      await f.execute('makeMovie();movie.open("movie.mp4");movie.play();movie.finalize();')
      assert.equal(await f.session.evaluate('finalized'), '1')
      assert.equal(f.video.movies.size, 1)
      assert.equal(f.session.inspectOwnership().videoSources, 1)
      await f.execute('invalidate movie;delete global.movie;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '2')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: failed video invalidation retains media and allows a real retry`, async () => {
    const f = await videoFixture(binary)
    try {
      await f.execute(
        'makeMovie();movie.open("movie.mp4");movie.play();failVideo=true;try{invalidate movie;}catch(e){caught=e.message;}',
      )
      assert.match(await f.session.evaluate('caught'), /video-finalizer/)
      assert.equal(await f.session.evaluate('isvalid movie'), '1')
      assert.equal(f.video.movies.size, 1)
      await f.execute('failVideo=false;invalidate movie;delete global.movie;')
      await f.restored()
      assert.equal(await f.session.evaluate('finalized'), '2')
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: video construction keeps its primary error while closing acquired media`, async () => {
    const f = await videoFixture(binary)
    try {
      await f.execute(
        'failVideo=true;failConstruct=true;try{makeMovie();}catch(e){caught=e.message;}',
      )
      assert.match(await f.session.evaluate('caught'), /video-constructor/)
      assert.doesNotMatch(await f.session.evaluate('caught'), /video-finalizer/)
      await f.restored()
      assert.equal(f.video.closedIds.length, 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: a queued ended event owns the last video reference and resolves its member at delivery`, async () => {
    const f = await videoFixture(
      binary,
      'function replacement(status){calls++;receiver=this.marker+":"+status;}',
    )
    let delivery: Promise<void> | undefined
    try {
      await f.execute('makeMovie();movie.open("movie.mp4");movie.play();System.eventDisabled=true;')
      delivery = f.video.emit(f.video.onlyId(), 'ended')
      await f.execute('movie.onStatusChanged=replacement incontextof movie;delete global.movie;')
      assert.equal(await f.session.evaluate('calls+","+finalized'), '0,0')
      assert.equal(f.video.movies.size, 1)
      await f.execute('System.eventDisabled=false;')
      await delivery
      await f.restored()
      assert.equal(
        await f.session.evaluate('receiver+","+calls+","+finalized'),
        'movie-owner:stop,1,1',
      )
    } finally {
      await f.session.stop()
      await delivery
    }
  })

  test(`${mode}: video invalidation removes queued events and releases their leases`, async () => {
    const f = await videoFixture(binary, 'function counted(status){calls++;}')
    let delivery: Promise<void> | undefined
    try {
      await f.execute(
        'makeMovie();movie.open("movie.mp4");movie.play();movie.onStatusChanged=counted;System.eventDisabled=true;',
      )
      delivery = f.video.emit(f.video.onlyId(), 'ended')
      await f.execute('invalidate movie;delete global.movie;')
      await delivery
      await f.restored()
      assert.equal(await f.session.evaluate('calls+","+finalized'), '0,1')
      await f.execute('System.eventDisabled=false;')
    } finally {
      await f.session.stop()
      await delivery
    }
  })

  for (const event of ['frame', 'period'] as const)
    test(`${mode}: ${event} callback can remove its last global video reference`, async () => {
      const member = event === 'frame' ? 'onFrameUpdate' : 'onPeriod'
      const f = await videoFixture(
        binary,
        'function lastEvent(value){calls++;delete global.movie;}',
      )
      try {
        await f.execute(
          `makeMovie();movie.mode=2;movie.open("movie.mp4");movie.play();movie.${member}=lastEvent incontextof movie;`,
        )
        await f.video.emit(f.video.onlyId(), event)
        await f.restored()
        assert.equal(await f.session.evaluate('calls+","+finalized'), '1,1')
      } finally {
        await f.session.stop()
      }
    })

  test(`${mode}: window invalidation disconnects media without invalidating the video object`, async () => {
    const f = await videoFixture(binary, 'function counted(status){calls++;}')
    try {
      await f.execute(
        'makeMovie();movie.open("movie.mp4");movie.play();movie.onStatusChanged=counted;System.exitOnWindowClose=false;invalidate win;',
      )
      assert.equal(f.video.movies.size, 0)
      assert.equal(f.session.inspectOwnership().videoSources, 1)
      assert.equal(
        await f.session.evaluate('(isvalid movie)+","+movie.status+","+calls+","+finalized'),
        '1,unload,0,0',
      )
      await f.execute('try{movie.open("movie.mp4");}catch(e){caught=e.message;}')
      assert.match(await f.session.evaluate('caught'), /disconnected/)
      await f.execute('invalidate movie;delete global.movie;')
      assert.equal(f.session.inspectOwnership().videoSources, 0)
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: video layer references retain identity without extra handles and expire with the layer`, async () => {
    const f = await videoFixture(binary)
    try {
      await f.execute(
        'var layer=new Layer(win,null);makeMovie();movie.layer1=layer;movie.layer2=layer;',
      )
      const handles = f.session.snapshot().handles
      assert.equal(
        await f.session.evaluate(
          '(function(){for(var i=0;i<100;i++)if(movie.layer1!==layer||movie.layer2!==layer)return 0;return 1;})()',
        ),
        '1',
      )
      assert.equal(f.session.snapshot().handles, handles)
      await f.execute('invalidate layer;delete global.layer;')
      assert.equal(await f.session.evaluate('movie.layer1===null && movie.layer2===null'), '1')
      assert.equal(f.session.inspectOwnership().weakOwners, f.baseline.weakOwners + 2)
      await f.execute('delete global.movie;')
      await f.restored()
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: execution waits for an asynchronous video resource close`, async () => {
    const f = await videoFixture(binary),
      gate = videoGate()
    let ending: Promise<string> | undefined,
      settled = false
    try {
      await f.execute('makeMovie();movie.open("movie.mp4");movie.play();')
      f.video.nextClose = gate
      ending = f.execute('delete global.movie;').then((result) => {
        settled = true
        return result
      })
      await Promise.race([
        gate.entered,
        ending.then(() => {
          throw new Error('Video close did not wait')
        }),
      ])
      assert.equal(settled, false)
      assert.equal(f.session.inspectOwnership().videoSources, 0)
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 1)
      assert.equal(f.video.movies.size, 1)
      gate.release()
      await ending
      await f.restored()
    } finally {
      gate.release()
      await ending
      await f.session.stop()
    }
  })

  test(`${mode}: failed video opening still releases a resource acquired before the failure`, async () => {
    const f = await videoFixture(binary)
    try {
      f.video.failOpen = new Error('acquired-then-failed')
      await f.execute(
        'makeMovie();try{movie.open("movie.mp4");}catch(e){caught=e.message;}delete global.movie;',
      )
      assert.match(await f.session.evaluate('caught'), /acquired-then-failed/)
      await f.restored()
      assert.equal(f.video.closedIds.length, 1)
    } finally {
      await f.session.stop()
    }
  })

  test(`${mode}: video close failure cannot replace a script primary error`, async () => {
    const f = await videoFixture(binary)
    try {
      await f.execute('makeMovie();movie.open("movie.mp4");')
      f.video.failClose = new Error('secondary-video-close')
      await assert.rejects(
        f.execute('delete global.movie;throw new Exception("video-primary");'),
        /video-primary/,
      )
      assert.equal(f.session.inspectOwnership().videoSources, 0)
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 0)
      assert.equal(f.video.movies.size, 0)
    } finally {
      await f.session.stop()
      f.stopped()
    }
  })

  test(`${mode}: failed video shutdown still disposes audio, native objects and the renderer once`, async () => {
    const f = await videoFixture(binary)
    await f.execute(
      'makeMovie();movie.open("movie.mp4");var sound=new WaveSoundBuffer(null);sound.open("tone.wav");sound.play();',
    )
    f.video.failShutdown = new Error('video-shutdown-first')
    await assert.rejects(f.session.stop(), /video-shutdown-first/)
    f.stopped()
    assert.equal(f.video.terminalCloses, 1)
    assert.equal(f.audio.terminalCloses, 1)
    await assert.rejects(f.session.stop(), /video-shutdown-first/)
    f.stopped()
    assert.equal(f.video.terminalCloses, 1)
    assert.equal(f.audio.terminalCloses, 1)
  })
}

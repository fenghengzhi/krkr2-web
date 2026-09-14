import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { headless } from '../helpers/headless.ts'
import type { FontSelectionRequest } from '../../src/engine/ports/fonts.ts'
import { FontCatalog, filterFonts, genericFonts } from '../../src/engine/graphics/font-catalog.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { cancelable } from '../../src/engine/scheduler/cancelable.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { FontSpec } from '../../src/engine/ports/graphics.ts'
const fixture = async (name: string) =>
  new Uint8Array(await readFile(new URL('../fixtures/font-selection/' + name, import.meta.url)))
const startup = 'var w=new Window(),a=new Layer(w,null);w.visible=true;a.font.height=20;'
test('getList filters discovered game fonts and returns usable family names with required arguments', async () => {
  const { session } = await headless({
    'startup.tjs': startup,
    'mono.ttf': await fixture('mono.ttf'),
    'latin.ttf': await fixture('latin.ttf'),
    'symbol.ttf': await fixture('symbol.ttf'),
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        'a.font.getList(fsfFixedPitch|fsfNoVertical|fsfIgnoreSymbol).join(",")',
      ),
      'Selection Mono,monospace',
    )
    assert.equal(
      await session.evaluate(
        'a.font.getList(fsfTrueTypeOnly|fsfNoVertical|fsfIgnoreSymbol).join(",")',
      ),
      'Selection Mono,Selection Latin',
    )
    assert.equal(
      await session.evaluate(
        '(function(){a.font.face="MONO.TTF";a.font.faceIsFileName=true;return a.font.getList(fsfSameCharSet).join(",");})()',
      ),
      'Selection Mono,@Selection Mono',
    )
    assert.equal(
      await session.evaluate('(function(){try{a.font.getList();}catch(e){return "missing";}})()'),
      'missing',
    )
  } finally {
    await session.stop()
  }
})
test('selection updates only the face, supports cancel and rejects stale or unavailable choices', async () => {
  let request: FontSelectionRequest | null = null,
    opened!: () => void
  let ready = new Promise<void>((resolve) => (opened = resolve))
  const getRequest = () => {
    assert(request)
    return request
  }
  const { session } = await headless(
    { 'startup.tjs': startup },
    {
      event: (event) => {
        if (event.type === 'font-selection') {
          request = event.request
          if (request) opened()
        }
      },
    },
  )
  try {
    await session.start()
    const pending = session.evaluate(
      '(function(){a.font.angle=300;a.font.bold=true;var r=a.font.doUserSelect(0,"Choose","Prompt","AV");return [r,a.font.face,a.font.height,a.font.bold,a.font.angle].join(",");})()',
    )
    await ready
    const current = getRequest()
    assert.deepEqual([current.caption, current.prompt, current.sample], ['Choose', 'Prompt', 'AV'])
    assert.throws(() => session.selectFont(current.id, 'not-listed'), /current selection/)
    session.selectFont(current.id + 1, 'serif')
    assert(request)
    session.selectFont(current.id, 'monospace')
    assert.equal(await pending, '1,monospace,20,1,300')
    assert.equal(request, null)
    ready = new Promise((resolve) => (opened = resolve))
    const cancel = session.evaluate('a.font.doUserSelect(0,"Choose","Prompt","AV")')
    await ready
    session.selectFont(getRequest().id, null)
    assert.equal(await cancel, '0')
    assert.equal(await session.evaluate('a.font.face'), 'monospace')
    assert.equal(
      await session.evaluate(
        '(function(){try{a.font.doUserSelect(0);}catch(e){return "missing";}})()',
      ),
      'missing',
    )
  } finally {
    await session.stop()
  }
})
test('stopping a pending selection releases its suspended VM and emits a closed request', async () => {
  let opened!: () => void,
    closed = 0
  const ready = new Promise<void>((resolve) => (opened = resolve))
  const { session } = await headless(
    {
      'startup.tjs':
        startup + 'a.font.doUserSelect(0,"Choose","Prompt","A");throw "must not resume";',
    },
    {
      event: (event) => {
        if (event.type === 'font-selection') {
          if (event.request) opened()
          else closed++
        }
      },
    },
  )
  const started = session.start(),
    rejected = assert.rejects(started, /cancelled/)
  await ready
  await session.stop()
  await rejected
  assert.equal(closed, 1)
  assert.equal(session.snapshot().handles, 0)
})
test('metadata discovery deduplicates pending work and cancels stalled reads', async () => {
  let reads = 0,
    done!: (bytes: Uint8Array) => void
  const resource = {
    name: 'font.ttf',
    size: 1,
    read: () => {
      reads++
      return new Promise<Uint8Array>((resolve) => (done = resolve))
    },
  }
  const control = new ExecutionControl(),
    catalog = new FontCatalog({
      files: () => [resource],
      resolve: () => resource,
      bind: () => {},
      warn: () => {},
      check: () => control.check(),
      yield: async () => {},
      wait: (work) => cancelable(work, control),
    })
  const a = catalog.prepare(),
    b = catalog.prepare(),
    failed = [assert.rejects(a, /cancelled/), assert.rejects(b, /cancelled/)]
  assert.equal(reads, 1)
  control.cancel()
  await Promise.all(failed)
  done(new Uint8Array(1))
  assert.deepEqual(catalog.entries(), genericFonts)
  assert.deepEqual(filterFonts([{ name: 'Unknown', source: 'system' }], 1, undefined), [])
  assert.deepEqual(filterFonts([{ name: 'Unknown', source: 'system' }], 8, undefined), [])
})
test('catalog binds each family style once, prioritizes active files and skips corrupt metadata once', async () => {
  const regular = await fixture('latin.ttf'),
    bold = await fixture('latin-bold.ttf'),
    resource = (name: string, bytes: Uint8Array) => ({
      name,
      size: bytes.length,
      read: async () => bytes,
    }),
    archived = resource('data.xp3>old.ttf', regular),
    boldFace = resource('bold.ttf', bold),
    active = resource('regular.ttf', regular),
    bad = resource('bad.ttf', new Uint8Array(20)),
    warnings: string[] = []
  const bindings: Map<string, import('../../src/engine/graphics/fonts.ts').NamedFontFace[]>[] = []
  const catalog = new FontCatalog({
    files: () => [archived, boldFace, active, bad],
    resolve: () => active,
    bind: (fonts) => {
      bindings.push(fonts)
    },
    warn: (message) => {
      warnings.push(message)
    },
    check: () => {},
    yield: async () => {},
    wait: (work) => work,
  })
  await catalog.prepare()
  await catalog.prepare()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /bad.ttf/)
  for (const bound of bindings) {
    assert.equal(bound.size, 1)
    assert.deepEqual(
      bound.get('selection latin')?.map((face) => [face.resource.name, face.bold, face.italic]),
      [
        ['bold.ttf', true, false],
        ['regular.ttf', false, false],
      ],
    )
  }
  assert.deepEqual(
    filterFonts(catalog.entries(), 8, undefined).map((font) => font.name),
    ['Selection Latin'],
  )
})
test('a finishing preview keeps its face alive while subsequent script text work waits', async () => {
  let opened!: () => void,
    release!: () => void,
    hold = true,
    loads = 0
  const started = new Promise<void>((resolve) => {
      opened = resolve
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve
    }),
    live = new Set<string>(),
    disposed: string[] = [],
    files = Array.from({ length: 33 }, (_, id) => ({
      name: String(id),
      size: 1,
      read: async () => new Uint8Array([id]),
    })),
    spec: FontSpec = {
      face: '0',
      faceIsFileName: true,
      height: 20,
      angle: 0,
      bold: false,
      italic: false,
      underline: false,
      strikeout: false,
    }
  const fonts = new FontService(
    (name) => files[Number(name)]!,
    {
      decode: async () => {
        throw new Error('unexpected image')
      },
      text: () => {
        throw new Error('unexpected text')
      },
      loadFont: async (bytes) => {
        const face = String(bytes[0])
        loads++
        assert(!live.has(face))
        live.add(face)
        return {
          face,
          dispose: () => {
            assert(live.delete(face))
            disposed.push(face)
          },
        }
      },
      measure: (_text, font) => {
        assert(live.has(font.face))
        return { width: 1, height: 20, ascent: 16 }
      },
      glyph: (_char, font) => {
        assert(live.has(font.face))
        return { width: 1, height: 1, left: 0, top: 0, coverage: new Uint8Array([255]), advance: 1 }
      },
    },
    async (work) => {
      while (true) {
        const step = work.next()
        if (step.done) return step.value
        if (hold) {
          hold = false
          opened()
          await wait
        }
      }
    },
  )
  try {
    const preview = fonts.draw('AB', spec, 0xffffff, {
      antialiased: true,
      shadowLevel: 0,
      shadowWidth: 0,
      shadowColor: 0,
      shadowX: 0,
      shadowY: 0,
    })
    await started
    const queued = files.map((file) => fonts.measure('A', { ...spec, face: file.name }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(loads, 1)
    assert.deepEqual(disposed, [])
    release()
    assert.equal((await preview).length, 2)
    assert.deepEqual(
      await Promise.all(queued),
      files.map(() => ({ width: 1, height: 20 })),
    )
    assert.equal(loads, 33)
    assert.deepEqual(disposed, ['0'])
  } finally {
    release()
    fonts.dispose()
  }
  assert.equal(live.size, 0)
  assert.equal(new Set(disposed).size, 33)
})
test('hidden pages reject font choices and cancellation resumes only after the pause gate opens', async () => {
  let opened!: () => void,
    request: FontSelectionRequest | null = null,
    settled = false
  const ready = new Promise<void>((resolve) => {
      opened = resolve
    }),
    { session } = await headless(
      { 'startup.tjs': startup },
      {
        event: (event) => {
          if (event.type === 'font-selection') {
            request = event.request
            if (request) opened()
          }
        },
      },
    )
  try {
    await session.start()
    const pending = session
      .evaluate('a.font.doUserSelect(0,"Paused","Prompt","AV")')
      .then((value) => {
        settled = true
        return value
      })
    await ready
    const current = request as FontSelectionRequest | null
    assert(current)
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: true })
    session.selectFont(current.id, 'serif')
    assert(request)
    session.selectFont(current.id, null)
    assert.equal(request, null)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false)
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: true })
    assert.equal(await pending, '0')
  } finally {
    await session.stop()
  }
})

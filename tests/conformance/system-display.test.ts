import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { EngineSession, type SessionDependencies } from '../../src/engine/session.ts'
import {
  copySystemDisplayMetrics,
  copySystemDisplayUpdate,
  type SystemDisplayMetrics,
  type SystemDisplayUpdate,
} from '../../src/engine/system/display.ts'
import { headless } from '../helpers/headless.ts'
import {
  otherSystemDisplayMetrics,
  systemDisplayExpected,
  systemDisplayFiles,
  systemDisplayMetrics,
  systemDisplayNames,
} from '../helpers/system-display-script.ts'

const test = (name: string, run: () => Promise<void> | void) =>
  nodeTest(name, { timeout: 60000 }, run)

function assertCompiledStorage(session: EngineSession, binary: boolean) {
  const saved = session.exportSaves().find(({ path }) => path === 'savedata/system-display.cjs')
  if (!binary) return assert.equal(saved, undefined)
  assert(saved, 'The actual executed bytecode must have been emitted by Scripts.compileStorage')
  assert.equal(new TextDecoder().decode(saved.bytes.subarray(0, 4)), 'TJS2')
  assert(saved.bytes.length > 16)
}

test('display configuration owns all six signed-int32 fields and rejects invalid input before runtime allocation', () => {
  const input = { ...systemDisplayMetrics },
    copied = copySystemDisplayMetrics(input)
  assert.notEqual(copied, input)
  assert.deepEqual(copied, input)
  input.desktopWidth = 17
  assert.equal(copied.desktopWidth, 901)
  assert.deepEqual(
    systemDisplayNames.map((name) => copySystemDisplayMetrics()[name]),
    [0, 0, 0, 0, 0, 0],
  )
  const invalid: [string, unknown][] = [
    ['null', null],
    ['array', []],
    ['missing field', { ...systemDisplayMetrics, screenHeight: undefined }],
    ...systemDisplayNames.flatMap((name): [string, unknown][] =>
      [NaN, Infinity, -Infinity, 1.5, 2147483648, '1'].map((value) => [
        `${name}:${String(value)}`,
        { ...systemDisplayMetrics, [name]: value },
      ]),
    ),
    ...(['screenWidth', 'screenHeight', 'desktopWidth', 'desktopHeight'] as const).map(
      (name): [string, unknown] => [name + ':negative', { ...systemDisplayMetrics, [name]: -1 }],
    ),
    ['desktopLeft:underflow', { ...systemDisplayMetrics, desktopLeft: -2147483649 }],
    ['desktopTop:underflow', { ...systemDisplayMetrics, desktopTop: -2147483649 }],
  ]
  for (const [name, value] of invalid) {
    const metrics = value as SystemDisplayMetrics
    assert.throws(() => copySystemDisplayMetrics(metrics), /System display/, name)
    let created = false
    assert.throws(
      () =>
        new EngineSession({
          systemDisplay: metrics,
          createRuntime: () => {
            created = true
            throw new Error('Invalid display reached runtime allocation')
          },
        } as unknown as SessionDependencies),
      /System display/,
      name,
    )
    assert.equal(created, false, name)
  }
  const invalidUpdates: unknown[] = [
    null,
    {},
    { revision: 1 },
    { revision: 1, metrics: null },
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((revision) => ({
      revision,
      metrics: systemDisplayMetrics,
    })),
  ]
  for (const update of invalidUpdates)
    assert.throws(() => copySystemDisplayUpdate(update as SystemDisplayUpdate), /System display/)
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`native System display entries are readonly integer properties with borrowed references and a copied injection (${mode})`, async () => {
    const supplied = { ...systemDisplayMetrics },
      { session } = await headless(systemDisplayFiles(binary), { systemDisplay: supplied })
    try {
      supplied.screenWidth = 17
      supplied.desktopLeft = 31
      supplied.desktopWidth = 45
      await session.start()
      assert.equal(await session.evaluate('sdChecks'), '6|6|6|6|6')
      assert.equal(await session.evaluate('sdInitial'), systemDisplayExpected(systemDisplayMetrics))
      assert.equal(
        await session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(systemDisplayMetrics),
      )
      assert.equal(await session.evaluate('*(&global.sdWidthReference)'), '901')
      assertCompiledStorage(session, binary)
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`display revisions replace all native property values atomically while paused, reject stale snapshots, and close with the session (${mode})`, async () => {
    const { session } = await headless(systemDisplayFiles(binary), {
        systemDisplay: systemDisplayMetrics,
      }),
      supplied = { ...otherSystemDisplayMetrics }
    try {
      await session.start()
      assert.equal(session.setSystemDisplay({ revision: 0, metrics: supplied }), false)
      assert.equal(
        await session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(systemDisplayMetrics),
      )
      session.pause()
      assert.equal(session.snapshot().state, 'paused')
      assert.equal(session.setSystemDisplay({ revision: 2, metrics: supplied }), true)
      supplied.desktopWidth = 11
      supplied.screenHeight = 12
      assert.equal(session.setSystemDisplay({ revision: 1, metrics: systemDisplayMetrics }), false)
      assert.equal(session.setSystemDisplay({ revision: 2, metrics: systemDisplayMetrics }), false)
      assert.equal(session.snapshot().state, 'paused')
      session.resume()
      assert.equal(
        await session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(otherSystemDisplayMetrics),
      )
      assert.equal(await session.evaluate('*(&global.sdWidthReference)'), '603')
      assert.equal(await session.evaluate('sdInitial'), systemDisplayExpected(systemDisplayMetrics))
      const next = { ...otherSystemDisplayMetrics, desktopWidth: 717 }
      assert.equal(session.setSystemDisplay({ revision: 3, metrics: next }), true)
      assert.equal(await session.evaluate('systemDisplayValues()'), systemDisplayExpected(next))
      assertCompiledStorage(session, binary)
    } finally {
      await session.stop()
    }
    assert.equal(session.setSystemDisplay({ revision: 4, metrics: systemDisplayMetrics }), false)
    assert.equal(session.snapshot().handles, 0)
  })

  test(`headless display defaults and update revisions belong to each fresh session (${mode})`, async () => {
    const first = await headless(systemDisplayFiles(binary)),
      second = await headless(systemDisplayFiles(binary), { systemDisplay: systemDisplayMetrics })
    try {
      await first.session.start()
      await second.session.start()
      assert.equal(await first.session.evaluate('sdChecks'), '6|6|6|6|6')
      assert.equal(await first.session.evaluate('systemDisplayValues()'), '0|0|0|0|0|0')
      assert.equal(
        first.session.setSystemDisplay({ revision: 99, metrics: otherSystemDisplayMetrics }),
        true,
      )
      assert.equal(
        await second.session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(systemDisplayMetrics),
      )
      await first.session.stop()
      assert.equal(
        second.session.setSystemDisplay({ revision: 1, metrics: otherSystemDisplayMetrics }),
        true,
      )
      assert.equal(
        await second.session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(otherSystemDisplayMetrics),
      )
      assertCompiledStorage(second.session, binary)
    } finally {
      await first.session.stop()
      await second.session.stop()
    }
    const fresh = await headless(systemDisplayFiles(binary))
    try {
      await fresh.session.start()
      assert.equal(await fresh.session.evaluate('systemDisplayValues()'), '0|0|0|0|0|0')
      assert.equal(
        fresh.session.setSystemDisplay({ revision: 1, metrics: systemDisplayMetrics }),
        true,
      )
      assert.equal(
        await fresh.session.evaluate('systemDisplayValues()'),
        systemDisplayExpected(systemDisplayMetrics),
      )
      assertCompiledStorage(fresh.session, binary)
    } finally {
      await fresh.session.stop()
    }
    assert.equal(fresh.session.snapshot().handles, 0)
  })
}

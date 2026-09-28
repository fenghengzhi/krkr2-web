import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { EngineSession, type SessionDependencies } from '../../src/engine/session.ts'
import {
  copySystemColorPalette,
  defaultSystemColorPalette,
} from '../../src/engine/graphics/system-colors.ts'
import {
  systemColorExpectedRows,
  systemColorPalette,
  systemColorsScript,
} from '../helpers/system-colors-script.ts'

const test = (name: string, run: () => Promise<void> | void) =>
  nodeTest(name, { timeout: 60000 }, run)

function files(binary: boolean, source: string) {
  return {
    'startup.tjs': binary
      ? 'Scripts.compileStorage("system-colors.tjs","savedata/system-colors.cjs",false,true,false);Scripts.execStorage("savedata/system-colors.cjs");'
      : 'Scripts.execStorage("system-colors.tjs");',
    'system-colors.tjs': source,
  }
}

function assertCompiledStorage(session: EngineSession, binary: boolean) {
  const output = session.exportSaves().find(({ path }) => path === 'savedata/system-colors.cjs')
  if (!binary) {
    assert.equal(output, undefined)
    return
  }
  assert(output, 'Scripts.compileStorage must create the bytecode actually executed by execStorage')
  assert.equal(new TextDecoder().decode(output.bytes.subarray(0, 4)), 'TJS2')
  assert(output.bytes.length > 16)
}

test('system color configuration owns and freezes a dense 31-entry RGB palette', () => {
  const input = [...systemColorPalette]
  const copied = copySystemColorPalette(input)
  assert.notEqual(copied, input)
  assert.deepEqual(copied, input)
  assert(Object.isFrozen(copied))
  input[5] = 0x010203
  input.push(0x040506)
  assert.equal(copied.length, 31)
  assert.equal(copied[5], 0x68798a)
  assert.equal(copied[25], 0)
  assert.equal(Reflect.set(copied, '5', 0x112233), false)
  assert.equal(defaultSystemColorPalette.length, 31)
  assert.equal(defaultSystemColorPalette[25], 0)
  assert(Object.isFrozen(defaultSystemColorPalette))
  assert.deepEqual(copySystemColorPalette(), defaultSystemColorPalette)
})

test('invalid system color configuration is rejected by the session constructor before runtime allocation', () => {
  const changed = (value: number, index = 5) => {
    const palette = [...systemColorPalette]
    palette[index] = value
    return palette
  }
  const sparse = [...systemColorPalette]
  delete sparse[5]
  const invalid: [string, unknown][] = [
    ['short', systemColorPalette.slice(0, 30)],
    ['long', [...systemColorPalette, 0]],
    ['empty', []],
    ['sparse', sparse],
    ['undefined entry', changed(undefined as unknown as number)],
    ['fraction', changed(1.5)],
    ['NaN', changed(NaN)],
    ['infinity', changed(Infinity)],
    ['negative infinity', changed(-Infinity)],
    ['negative', changed(-1)],
    ['ARGB', changed(0x1000000)],
    ['numeric string', changed('1193046' as unknown as number)],
    ['reserved index', changed(1, 25)],
    ['typed array', new Uint32Array(systemColorPalette)],
    ['null', null],
  ]
  for (const [name, input] of invalid) {
    const colors = input as readonly number[]
    assert.throws(() => copySystemColorPalette(colors), /System colors? /, name)
    let runtimeCreated = false
    assert.throws(
      () =>
        new EngineSession({
          systemColors: colors,
          createRuntime: () => {
            runtimeCreated = true
            throw new Error('Invalid palette reached runtime creation')
          },
          // This negative fixture intentionally omits the acquisition backends:
          // invalid palettes must be rejected before any of them are consulted.
        } as unknown as SessionDependencies),
      /System colors? /,
      name,
    )
    assert.equal(runtimeCreated, false, name)
  }
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`System colors preserve original native entry behavior, int64 narrowing and Layer color boundaries (${mode})`, async () => {
    const { session } = await headless(files(binary, systemColorsScript), {
      systemColors: systemColorPalette,
    })
    try {
      await session.start()
      const rows = (await session.evaluate('systemColorRows.join("\\n")')).split('\n')
      assert.deepEqual(
        rows,
        systemColorExpectedRows(),
        await session.evaluate('systemColorErrors.join("\\n")'),
      )
      assert.equal(await session.evaluate('System.toActualColor instanceof "Function"'), '1')
      assert.equal(
        await session.evaluate(
          '[systemColorLayer.imageWidth,systemColorLayer.imageHeight].join("|")',
        ),
        '2|2',
      )
      assertCompiledStorage(session, binary)
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`system colors are shared by System and Layer within each session and copied independently (${mode})`, async () => {
    const firstInput = [...systemColorPalette]
    const secondInput = systemColorPalette.map((color, index) =>
      index === 25 ? 0 : color ^ 0xabcdef,
    )
    const firstExpected = firstInput[5]!
    const secondExpected = secondInput[5]!
    const source = `
var window=new Window();window.visible=false;
var layer=new Layer(window,null);layer.setSize(2,2);layer.setImageSize(2,2);
layer.face=dfAlpha;layer.fillRect(0,0,2,2,0x57112233);
layer.setMainPixel(0,0,clWindow);
var colors=[System.toActualColor(clWindow),layer.getMainPixel(0,0),layer.getMaskPixel(0,0)].join("|");
`
    const first = await headless(files(binary, source), { systemColors: firstInput })
    let second: Awaited<ReturnType<typeof headless>> | undefined
    try {
      // Caller mutation after construction must not affect the session's copy.
      firstInput[5] = 0x010203
      firstInput.length = 0
      second = await headless(files(binary, source), { systemColors: secondInput })
      secondInput[5] = 0x040506
      await first.session.start()
      await second.session.start()
      assert.equal(await first.session.evaluate('colors'), `${firstExpected}|${firstExpected}|87`)
      assert.equal(
        await second.session.evaluate('colors'),
        `${secondExpected}|${secondExpected}|87`,
      )
      assert.notEqual(firstExpected, secondExpected)
      assert.equal(
        await first.session.evaluate('System.toActualColor(clWindow)'),
        String(firstExpected),
      )
      assertCompiledStorage(first.session, binary)
      assertCompiledStorage(second.session, binary)
      await first.session.stop()
      assert.equal(
        await second.session.evaluate('System.toActualColor(clWindow)'),
        String(secondExpected),
      )
    } finally {
      await first.session.stop()
      await second?.session.stop()
    }
    assert.equal(first.session.snapshot().handles, 0)
    assert.equal(second?.session.snapshot().handles, 0)
  })

  test(`headless sessions resolve absent palette configuration using the stable Web fallback (${mode})`, async () => {
    const source = `
var fallback=[];
for(var index=0;index<31;index++)fallback.add(System.toActualColor(0x80000000+index));
`
    const { session } = await headless(files(binary, source))
    try {
      await session.start()
      assert.equal(
        await session.evaluate('fallback.join("|")'),
        defaultSystemColorPalette.join('|'),
      )
      assertCompiledStorage(session, binary)
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })
}

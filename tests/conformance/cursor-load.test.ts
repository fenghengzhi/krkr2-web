import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { loadCursorAsset, loadCursorBytes, loadedCursorHotspot, windowsDesktopCursorProfile } from '../../src/formats/cursor/load.ts'
import { compositeCursor, cursorStep, decodeCursor, type CursorAsset, type CursorImage } from '../../src/formats/cursor/index.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import { animatedCursor, cursorDib, cursorFile, cursorPng } from '../helpers/cursor-fixtures.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

// No smooth-scaling golden is manufactured from the candidate implementation.
// Full native RGB/hotspot comparison lives in the hosted cursor loading probe.
function image(width: number, height: number, depth = 32, red = 37,
  hotspot: readonly [number, number] = [3, 5]): CursorImage {
  const data = new Uint8Array(width * height * 4)
  for (let at = 0; at < data.length; at += 4) data.set([red, 71, 113, 255], at)
  return { width, height, depth, data, andMask: new Uint8Array(width * height),
    hotspot: { x: hotspot[0], y: hotspot[1] }, encoding: 'dib', mode: 'and-xor',
    dibHeaderSize: 40, topDown: false, icon: false }
}
function asset(images: CursorImage[][], kind: 'cur' | 'ani' = 'cur'): CursorAsset {
  return { kind, frames: images.map((images) => ({ images })),
    sequence: images.map((_, index) => index), rates: images.map(() => 6),
    durationJiffies: images.length * 6, sourceBytes: 123,
    imageCount: images.reduce((sum, frame) => sum + frame.length, 0),
    decodedBytes: images.flat().reduce((sum, value) => sum + value.width * value.height * 5, 0) }
}
function finish<T>(work: Generator<void, T>): T {
  let result = work.next()
  while (!result.done) result = work.next()
  return result.value
}
const png = async (bytes: Uint8Array) => {
  const parser = decodePng(bytes)
  assert(parser)
  const plan = finish(parser)
  return finish(plan.decode(inflateSync(plan.compressed, { maxOutputLength: plan.expandedLength })))
}
const loadedImage = (value: CursorAsset) => value.frames[0]!.images[0]!
function encodedImage(size: number, red = 37) {
  return { width: size, height: size, payload: cursorDib({ width: size, height: size, depth: 32,
    xorRows: Array.from({ length: size }, () => Array.from({ length: size }, () => [113, 71, red, 0]).flat()) }) }
}

test('cursor load chooses the exact 32-pixel directory entry independently of source order', async () => {
  const entries = [16, 32, 48, 64].map((size) => image(size, size, 32, size, [size / 4, size / 2]))
  for (const list of [entries, [...entries].reverse()]) {
    const source = asset([list]), loaded = await loadCursorAsset(source), result = loadedImage(loaded)
    assert.equal(result.data[0], 32)
    assert.deepEqual(result.hotspot, { x: 8, y: 16 })
    assert.equal(result.width, 32)
    assert.equal(result.height, 32)
    assert.equal(loaded.imageCount, 1)
    assert.equal(loaded.decodedBytes, 5120)
    assert.equal(loaded.sourceBytes, 123)
    assert.equal(source.frames[0]!.images.length, 4)
  }
})

test('cursor load color depth precedes directory order and equal-depth ties preserve directory order', async () => {
  const entries = [1, 4, 8, 24, 32].map((depth) => image(32, 32, depth, depth, [Math.floor(depth / 2), 5]))
  for (const list of [entries, [...entries].reverse()]) {
    const selected = loadedImage(await loadCursorAsset(asset([list])))
    assert.equal(selected.depth, 32)
    assert.deepEqual(selected.hotspot, { x: 16, y: 5 })
  }
  const first = image(32, 32, 32, 111, [4, 5]), second = image(32, 32, 32, 77, [23, 5])
  for (const list of [[first, second], [second, first]]) {
    const selected = loadedImage(await loadCursorAsset(asset([list])))
    assert.equal(selected.data[0], list[0]!.data[0])
    assert.deepEqual(selected.hotspot, list[0]!.hotspot)
  }
})

test('cursor load selects the 48-pixel image over equidistant 16-pixel content', async () => {
  const entries = [16, 48, 64].map((size) => image(size, size, 32, size / 16 * 37, [size / 4, size / 2]))
  for (const list of [entries, [...entries].reverse()]) {
    const selected = loadedImage(await loadCursorAsset(asset([list])))
    // This first corner distinguishes tag3 from the 16/64-pixel candidates;
    // their proportional hotspots alone are all (8,16) after loading.
    assert.equal(selected.data[0], 111)
    assert.deepEqual(selected.hotspot, { x: 8, y: 16 })
  }
})

test('cursor load low-depth rectangular raster uses centered point samples and an independent Boolean mask', async () => {
  const source = image(8, 4, 24, 0, [2, 1])
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    source.data.set([37 + x * 3, 71 + y * 5, 113 + x + y, 255], (y * 8 + x) * 4)
    source.andMask[y * 8 + x] = y >= 2 ? 255 : 0
  }
  const selected = loadedImage(await loadCursorAsset(asset([[source]])))
  assert.deepEqual(selected.hotspot, { x: 8, y: 8 })
  assert.deepEqual(Array.from({ length: 16 }, (_, x) => selected.data[x * 4]),
    [37, 37, 37, 37, 40, 40, 40, 40, 43, 43, 43, 43, 46, 46, 46, 46])
  assert.deepEqual(Array.from({ length: 32 }, (_, y) => selected.data[y * 32 * 4 + 1]),
    [...Array(8).fill(71), ...Array(8).fill(76), ...Array(8).fill(81), ...Array(8).fill(86)])
  assert.equal(selected.andMask[15 * 32], 0)
  assert.equal(selected.andMask[16 * 32], 255)
  assert.equal(selected.mode, 'and-xor')
})

test('cursor load nonintegral point scaling and hotspot rounding follow the native 13x9 palette case', async () => {
  const source = image(13, 9, 4, 0, [12, 8])
  for (let y = 0; y < 9; y++) for (let x = 0; x < 13; x++) source.data[(y * 13 + x) * 4] = x
  const selected = loadedImage(await loadCursorAsset(asset([[source]])))
  assert.deepEqual(selected.hotspot, { x: 30, y: 28 })
  assert.deepEqual(Array.from({ length: 16 }, (_, x) => selected.data[x * 4]),
    [0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 6])
  assert.equal(selected.data[31 * 4], 12)
})

test('cursor load PNG256 centers samples before alpha composition and scales its outside-center hotspot', async () => {
  const pixels: number[] = []
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++)
    pixels.push((x * 5 + 31) & 255, (y * 7 + 61) & 255, (x + y + 127) & 255,
      x % 3 === 0 ? 0 : x % 3 === 1 ? 128 : 255)
  const raw = cursorFile([{ width: 256, height: 256, hotspot: [191, 203], payload: cursorPng(256, 256, pixels) }]),
    source = await decodeCursor(raw, { png }), loaded = await loadCursorAsset(source), selected = loadedImage(loaded)
  assert.deepEqual(selected.hotspot, { x: 24, y: 25 })
  assert.deepEqual([...selected.data.subarray(0, 12)], [51, 89, 135, 128, 91, 89, 143, 0, 131, 89, 151, 255])
  const target = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) }
  compositeCursor(selected, target, 0, 0)
  assert.deepEqual([...target.data.subarray(0, 12)], [25, 44, 67, 255, 0, 0, 0, 255, 131, 89, 151, 255])
  assert.equal(loaded.sourceBytes, raw.length)
  assert.equal(source.frames[0]!.images[0]!.width, 256)
})

test('cursor load keeps every ANI frame and step while the smooth scaling candidate awaits native pixel calibration', async () => {
  const source = asset([[image(13, 9, 32, 37, [12, 8])], [image(48, 48, 32, 111, [12, 24])],
    [image(32, 32, 32, 7, [17, 23])]], 'ani')
  source.sequence = [2, 0, 2, 1, 0]
  source.rates = [1, 4, 7, 2, 9]
  source.durationJiffies = 23
  source.animation = { width: 48, height: 64, depth: 4, planes: 1, flags: 3 }
  const loaded = await loadCursorAsset(source)
  assert.equal(loaded.frames.length, 3)
  assert(loaded.frames.every((frame) => frame.images.length === 1 && frame.images[0]!.width === 32 && frame.images[0]!.height === 32))
  assert.deepEqual(loaded.sequence, [2, 0, 2, 1, 0])
  assert.deepEqual(loaded.rates, [1, 4, 7, 2, 9])
  assert.deepEqual(loaded.frames.map((frame) => frame.images[0]!.hotspot), [{ x: 30, y: 28 }, { x: 8, y: 16 }, { x: 17, y: 23 }])
  assert.deepEqual(loaded.animation, source.animation)
  assert.equal(loaded.decodedBytes, 3 * 5120)
  assert.equal(loaded.imageCount, 3)
})

test('cursor load retains native outside hotspots and uses the loaded center for embedded icons', async () => {
  const cursor = image(32, 32, 32, 37, [33, 40]), icon = image(13, 9, 24, 37, [6, 4])
  icon.icon = true
  assert.deepEqual(loadedImage(await loadCursorAsset(asset([[cursor]]))).hotspot, { x: 33, y: 40 })
  assert.deepEqual(loadedImage(await loadCursorAsset(asset([[icon]]))).hotspot, { x: 16, y: 16 })
})

test('cursor load native DIB policy is separate from structural decoding and checks the selected image', async () => {
  const payload = cursorDib({ width: 1, height: 1, depth: 24, topDown: true, xorRows: [[30, 20, 10]] }),
    decoded = await decodeCursor(cursorFile([{ width: 1, height: 1, payload }]), { png })
  assert.equal(loadedImage(decoded).topDown, true)
  assert.equal(loadedImage(decoded).dibHeaderSize, 40)
  await assert.rejects(loadCursorAsset(decoded), /native file-loading policy/)
  for (const dibHeaderSize of [52, 56, 108, 124]) {
    const rejected = image(32, 32)
    rejected.dibHeaderSize = dibHeaderSize
    await assert.rejects(loadCursorAsset(asset([[rejected]])), /native file-loading policy/)
    const unselected = image(48, 48)
    unselected.dibHeaderSize = dibHeaderSize
    const accepted = await loadCursorAsset(asset([[image(32, 32), unselected]]))
    assert.equal(loadedImage(accepted).dibHeaderSize, 40)
  }
})

test('cursor load snapshots selected planes, metadata and the profile before suspension', async () => {
  const source = asset([[image(8, 4, 24, 37, [2, 1])], [image(32, 32)]], 'ani'), profile = { ...windowsDesktopCursorProfile }
  let resume!: () => void, entered!: () => void, calls = 0
  const waiting = new Promise<void>((resolve) => { resume = resolve }), ready = new Promise<void>((resolve) => { entered = resolve }),
    pending = loadCursorAsset(source, profile, { checkpoint: () => {
      if (++calls === 1) { entered(); return waiting }
    } })
  try {
    await Promise.race([ready, pending.then(() => { throw new Error('Loading ended before its checkpoint') })])
    source.frames[0]!.images[0]!.data.fill(0)
    source.frames[0]!.images[0]!.hotspot.x = 999
    source.frames[0]!.images.length = 0
    source.sequence[0] = 1
    source.rates[0] = 0
    source.durationJiffies = 0
    profile.width = 1
    resume()
    const loaded = await pending
    assert.equal(loadedImage(loaded).data[0], 37)
    assert.deepEqual(loadedImage(loaded).hotspot, { x: 8, y: 8 })
    assert.deepEqual(loaded.sequence, [0, 1])
    assert.deepEqual(loaded.rates, [6, 6])
    assert.equal(loaded.durationJiffies, 12)
    assert.equal(loadedImage(loaded).data.buffer.byteLength, 4096)
    assert.equal(loadedImage(loaded).andMask.buffer.byteLength, 1024)
  } finally {
    resume()
    await pending.catch(() => {})
  }
})

test('cursor load cooperatively cancels without publishing partial frames or mutating the source', async () => {
  const source = asset([[image(13, 9, 32)], [image(48, 48, 32)]], 'ani'), cancelled = new Error('stop-load')
  let calls = 0
  await assert.rejects(loadCursorAsset(source, undefined, { checkpoint: () => {
    if (++calls === 3) throw cancelled
  } }), (error) => error === cancelled)
  assert.equal(calls, 3)
  assert.equal(source.frames[0]!.images[0]!.width, 13)
  assert.equal(source.frames[1]!.images[0]!.width, 48)
  assert.equal(source.frames[0]!.images[0]!.data[0], 37)
})

test('cursor load rejects uncalibrated desktop profiles and retains zero-rate assets without inventing timing', async () => {
  const source = asset([[image(32, 32)], [image(32, 32)], [image(32, 32)]], 'ani')
  for (const profile of [{ ...windowsDesktopCursorProfile, width: 64 }, { ...windowsDesktopCursorProfile, depth: 16 },
    { ...windowsDesktopCursorProfile, dpi: 120 }])
    await assert.rejects(loadCursorAsset(source, profile), /desktop profile/)
  // Native ani-zero-rate keeps the three observed rates, unlike ani-single.
  source.rates = [0, 1, 0]
  source.durationJiffies = 1
  const loaded = await loadCursorAsset(source)
  assert.deepEqual(loaded.rates, [0, 1, 0])
  assert.equal(loaded.durationJiffies, 1)
  assert.throws(() => cursorStep(loaded, 0), /zero-rate playback timing/)
})

test('cursor load preserves raw ANI rate 9 but loads one frame and one step with native rate zero', async () => {
  // 081 run 37240240034, Windows 2022 and 2025 observations.json:
  // ani-single.ani has defaultRate 9; legal step 0 reports rateJiffies 0,
  // steps 1. These literals come from the native API, not from this loader.
  const bytes = animatedCursor([cursorFile([{ ...encodedImage(32), hotspot: [2, 3] }])], { defaultRate: 9 }),
    raw = await decodeCursor(bytes, { png })
  assert.equal(raw.kind, 'ani')
  assert.deepEqual(raw.rates, [9])
  assert.equal(raw.durationJiffies, 9)
  for (const loaded of [await loadCursorAsset(raw), await loadCursorBytes(bytes, { png })]) {
    assert.equal(loaded.kind, 'ani')
    assert.equal(loaded.frames.length, 1)
    assert.deepEqual(loaded.sequence, [0])
    assert.deepEqual(loaded.rates, [0])
    assert.equal(loaded.durationJiffies, 0)
    assert.deepEqual(loadedImage(loaded).hotspot, { x: 2, y: 3 })
    for (const elapsed of [0, 150, 987654321]) assert.equal(cursorStep(loaded, elapsed), 0)
    for (const elapsed of [-1, Infinity, NaN]) assert.throws(() => cursorStep(loaded, elapsed), /animation time/)
  }
  assert.deepEqual(raw.rates, [9])
  assert.equal(raw.durationJiffies, 9)
})

test('cursor load does not extend the single-frame single-step rate observation to other ANI shapes', async () => {
  // These unobserved shapes retain source metadata; this is a scope guard,
  // not a claim that their rates have been calibrated against native loading.
  const multiFrame = asset([[image(32, 32)], [image(32, 32)]], 'ani')
  multiFrame.sequence = [1]
  multiFrame.rates = [9]
  multiFrame.durationJiffies = 9
  const multiStep = asset([[image(32, 32)]], 'ani')
  multiStep.sequence = [0, 0]
  multiStep.rates = [3, 6]
  multiStep.durationJiffies = 9
  for (const source of [multiFrame, multiStep]) {
    const loaded = await loadCursorAsset(source)
    assert.equal(loaded.frames.length, source.frames.length)
    assert.deepEqual(loaded.sequence, source.sequence)
    assert.deepEqual(loaded.rates, source.rates)
    assert.equal(loaded.durationJiffies, 9)
  }
  assert.equal(cursorStep(await loadCursorAsset(multiFrame), 987654321), 0)
})

test('cursor byte loading skips a broken smaller alternative while generic decoding still rejects it', async () => {
  const valid = encodedImage(32), broken = { width: 16, height: 16, payload: Uint8Array.of(0, 0, 0, 0) }
  for (const entries of [[valid, broken], [broken, valid]]) {
    const bytes = cursorFile(entries)
    await assert.rejects(decodeCursor(bytes, { png }), /truncated resource/)
    const loaded = await loadCursorBytes(bytes, { png })
    assert.equal(loadedImage(loaded).data[0], 37)
    assert.equal(loaded.imageCount, 1)
    assert.equal(loaded.decodedBytes, 5120)
    assert.equal(loaded.sourceBytes, bytes.length)
  }
})

test('cursor byte loading does not fall back from a corrupt preferred image', async () => {
  const valid = encodedImage(16), broken = { width: 32, height: 32, payload: Uint8Array.of(0, 0, 0, 0) }
  for (const entries of [[valid, broken], [broken, valid]])
    await assert.rejects(loadCursorBytes(cursorFile(entries), { png }), /truncated resource/)
})

test('cursor byte loading selects before decoding in every ANI frame and preserves the full timeline', async () => {
  const broken = { width: 16, height: 16, payload: Uint8Array.of(0, 0, 0, 0) },
    bytes = animatedCursor([cursorFile([broken, encodedImage(32, 37)]),
      cursorFile([encodedImage(32, 74), broken])], { sequence: [1, 0, 1], rates: [1, 7, 3] })
  await assert.rejects(decodeCursor(bytes, { png }), /truncated resource/)
  const loaded = await loadCursorBytes(bytes, { png })
  assert.equal(loaded.frames.length, 2)
  assert.deepEqual(loaded.frames.map((frame) => frame.images[0]!.data[0]), [37, 74])
  assert.deepEqual(loaded.sequence, [1, 0, 1])
  assert.deepEqual(loaded.rates, [1, 7, 3])
  assert.equal(loaded.durationJiffies, 11)
  assert.equal(loaded.sourceBytes, bytes.length)
})

test('cursor byte loading charges only the selected pixel planes but retains the complete source charge', async () => {
  const bytes = cursorFile([encodedImage(64), encodedImage(32)]), limits = { images: 1, pixels: 1024 }
  await assert.rejects(decodeCursor(bytes, { png, limits }), /decoded image budget/)
  const loaded = await loadCursorBytes(bytes, { png, limits })
  assert.equal(loaded.sourceBytes, bytes.length)
  assert.equal(loaded.imageCount, 1)
  assert.equal(loaded.decodedBytes, 5120)
  await assert.rejects(loadCursorBytes(bytes, { png, limits: { sourceBytes: bytes.length - 1 } }), /source byte budget/)
})

test('cursor byte loading never calls PNG decoding for an unselected alternative', async () => {
  const bytes = cursorFile([encodedImage(32), { width: 16, height: 16,
    payload: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10) }])
  let calls = 0
  const loaded = await loadCursorBytes(bytes, { png: async () => { calls++; throw new Error('unselected decoder called') } })
  assert.equal(calls, 0)
  assert.equal(loadedImage(loaded).data[0], 37)
})

test('cursor byte loading snapshots bytes before its first checkpoint and cancels after selected PNG decode', async () => {
  const bytes = cursorFile([encodedImage(32)]), originalLength = bytes.length
  let once = false
  const loaded = await loadCursorBytes(bytes, { png, checkpoint: () => {
    if (!once) { once = true; bytes.fill(0) }
  } })
  assert.equal(loadedImage(loaded).data[0], 37)
  assert.equal(loaded.sourceBytes, originalLength)
  const pixels = Array.from({ length: 32 * 32 }, () => [11, 22, 33, 255]).flat(),
    encoded = cursorFile([{ width: 32, height: 32, payload: cursorPng(32, 32, pixels) }]),
    cancelled = new Error('cancel-selected-png')
  let decoded = false
  await assert.rejects(loadCursorBytes(encoded, { png: async (payload) => {
    const result = await png(payload); decoded = true; return result
  }, checkpoint: () => { if (decoded) throw cancelled } }), (error) => error === cancelled)
  assert.equal(decoded, true)
})

test('cursor load prefers covering rectangles before closer undersized alternatives and preserves ranking ties', async () => {
  const entries = [image(32, 16, 32, 37, [0, 5]), image(16, 32, 32, 74, [3, 5]),
    image(48, 40, 32, 111, [6, 5]), image(40, 48, 32, 148, [9, 5])]
  const forward = loadedImage(await loadCursorAsset(asset([entries]))),
    reverse = loadedImage(await loadCursorAsset(asset([[...entries].reverse()])))
  assert.equal(forward.data[0], 111)
  assert.deepEqual(forward.hotspot, { x: 4, y: 4 })
  assert.equal(reverse.data[0], 148)
  assert.deepEqual(reverse.hotspot, { x: 7, y: 3 })
})

test('cursor loaded hotspots preserve the native signed-SHORT rounding and DWORD result', async () => {
  const natural = image(32, 32, 32, 37, [65535, 32768]), small = image(8, 4, 24, 37, [65535, 32768])
  assert.deepEqual(loadedCursorHotspot(natural), { x: 0, y: 0xffff8001 })
  assert.deepEqual(loadedCursorHotspot(small), { x: 0xfffffffd, y: 1 })
  assert.deepEqual(loadedImage(await loadCursorAsset(asset([[natural]]))).hotspot, { x: 0, y: 0xffff8001 })
  const selected = loadedImage(await loadCursorAsset(asset([[small]])))
  assert.deepEqual(selected.hotspot, { x: 0xfffffffd, y: 1 })
  assert.equal(selected.hotspot.x | 0, -3)
  assert.deepEqual(small.hotspot, { x: 65535, y: 32768 })
})

test('cursor load uses the observed center samples for an integer-reduced 256-pixel DIB too', async () => {
  const source = image(256, 256, 32, 0, [191, 203])
  source.mode = 'alpha'
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++)
    source.data.set([(37 + x * 3) & 255, (71 + y * 5) & 255, (113 + x + y) & 255, x], (y * 256 + x) * 4)
  const loaded = loadedImage(await loadCursorAsset(asset([[source]])))
  assert.deepEqual([...loaded.data.subarray(0, 12)], [49, 91, 121, 4, 73, 91, 129, 12, 97, 91, 137, 20])
  assert.deepEqual(loaded.hotspot, { x: 24, y: 25 })
})

test('cursor smooth scaling keeps the byte stages observed in native raw color planes', async () => {
  // 081 run 37240240034, both Windows versions:
  // dib-alpha-small-root-color.bgra, top-down 32x32 BGRA, stride 128.
  // These are sampled native bytes, not values computed by this loader.
  const source = image(13, 9, 32, 0, [12, 8])
  source.mode = 'alpha'
  for (let y = 0; y < 9; y++) for (let x = 0; x < 13; x++)
    source.data.set([37 + x * 3, 71 + y * 5, 113 + x + y, x + y * 13], (y * 13 + x) * 4)
  const loaded = loadedImage(await loadCursorAsset(asset([[source]])))
  for (const [x, y, rgba] of [
    [0, 0, [37, 71, 113, 0]], [1, 1, [37, 71, 113, 3]], [2, 1, [38, 71, 113, 3]],
    [1, 2, [37, 72, 113, 6]], [10, 10, [47, 82, 118, 36]],
    [1, 30, [37, 108, 120, 99]], [2, 30, [38, 108, 120, 100]],
    [1, 31, [38, 111, 121, 104]], [0, 30, [37, 109, 120, 100]], [31, 31, [72, 111, 132, 115]],
  ] as const) {
    const at = (y * 32 + x) * 4
    assert.deepEqual([...loaded.data.subarray(at, at + 4)], rgba, `native pixel (${x},${y})`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fontGeometry } from '../../src/engine/graphics/font.ts'
const reference = JSON.parse(
  readFileSync(new URL('../fixtures/font-geometry/reference.json', import.meta.url), 'utf8'),
) as { coordinates: number[][] }
test('font ascent offsets and advances match 25200 extracted native coordinate cases', () => {
  assert.equal(reference.coordinates.length, 25200)
  for (const [angle, ascent, width, ...expected] of reference.coordinates) {
    const transform = fontGeometry(angle!, ascent!),
      advance = transform.advance(width!)
    assert.deepEqual(
      [transform.ascentX, transform.ascentY, advance.x, advance.y],
      expected,
      `angle=${angle},ascent=${ascent},width=${width}`,
    )
  }
})

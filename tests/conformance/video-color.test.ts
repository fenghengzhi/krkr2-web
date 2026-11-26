import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultVideoColors, videoColorMatrix, videoColorSetting, type VideoColorValues } from '../../src/engine/media/video-color.ts'

function pixel(settings: Partial<VideoColorValues>, rgb: number[]): number[] {
  const matrix = videoColorMatrix({ ...defaultVideoColors, ...settings })
  if (!matrix) return rgb
  return [0, 1, 2].map((channel) => {
    const row = channel * 5
    const value = rgb.reduce((sum, sample, column) => sum + sample * matrix[row + column]!, 255 * matrix[row + 4]!)
    return Math.round(Math.max(0, Math.min(255, value)))
  })
}

test('video color controls adjust luma and chroma independently in a single pass', () => {
  assert.equal(videoColorMatrix(defaultVideoColors), undefined)
  assert.deepEqual(pixel({ saturation: 0 }, [255, 0, 0]), [76, 76, 76])
  assert.deepEqual(pixel({ contrast: .5 }, [100, 100, 100]), [50, 50, 50])
  assert.deepEqual(pixel({ brightness: 20 }, [100, 100, 100]), [151, 151, 151])
  assert.deepEqual(pixel({ hue: 180 }, [50, 50, 50]), [50, 50, 50])
  // Opposite chroma at equal luma gives 2*Y minus the original channel.
  assert.deepEqual(pixel({ hue: 180 }, [100, 110, 120]), [116, 106, 96])
  // Amplify luma beyond white, then offset it before the final clamp.
  assert.deepEqual(pixel({ contrast: 2, brightness: -40 }, [190, 190, 190]), [255, 255, 255])
  assert.deepEqual(pixel({ contrast: 2, brightness: -40 }, [150, 150, 150]), [198, 198, 198])
})

test('mixer setting readback follows the advertised step and native float precision', () => {
  assert.equal(videoColorSetting('saturation', 1.254), 1.25)
  assert.equal(videoColorSetting('saturation', 1.257), Math.fround(1.26))
  assert.equal(videoColorSetting('hue', -45.8), -46)
  for (const value of [NaN, Infinity, -101, 101])
    assert.throws(() => videoColorSetting('brightness', value), /outside the mixer range/)
})

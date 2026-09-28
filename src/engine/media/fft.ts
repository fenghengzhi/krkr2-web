/**
 * Project-owned radix-2 complex FFT. Forward uses exp(+i angle), matching
 * KRKR2's real-DFT convention; inverse uses exp(-i angle) and divides by N.
 * Tables and scratch storage belong to the caller/instance, never a render call.
 */
export class Radix2Fft {
  private readonly reversed: Uint32Array
  private readonly cosine: Float64Array
  private readonly sine: Float64Array

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 2 || size > 32768 || size & (size - 1)) {
      throw new RangeError('FFT size must be a power of two between 2 and 32768')
    }
    this.reversed = new Uint32Array(size)
    this.cosine = new Float64Array(size / 2)
    this.sine = new Float64Array(size / 2)
    for (let i = 0, reversed = 0; i < size; i++) {
      this.reversed[i] = reversed
      let bit = size >>> 1
      while (reversed & bit) {
        reversed ^= bit
        bit >>>= 1
      }
      reversed ^= bit
    }
    for (let i = 0; i < size / 2; i++) {
      const angle = (2 * Math.PI * i) / size
      this.cosine[i] = Math.cos(angle)
      this.sine[i] = Math.sin(angle)
    }
  }

  transform(real: Float64Array, imaginary: Float64Array, inverse = false) {
    const n = this.size
    if (real.length !== n || imaginary.length !== n || real === imaginary) {
      throw new RangeError('FFT requires separate real and imaginary arrays of its size')
    }
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i]!
      if (j > i) {
        const r = real[i]!,
          im = imaginary[i]!
        real[i] = real[j]!
        imaginary[i] = imaginary[j]!
        real[j] = r
        imaginary[j] = im
      }
    }
    for (let width = 2; width <= n; width *= 2) {
      const half = width / 2,
        stride = n / width
      for (let start = 0; start < n; start += width) {
        for (let k = 0; k < half; k++) {
          const at = k * stride,
            cosine = this.cosine[at]!,
            sine = inverse ? -this.sine[at]! : this.sine[at]!,
            a = start + k,
            b = a + half,
            r = real[b]! * cosine - imaginary[b]! * sine,
            im = real[b]! * sine + imaginary[b]! * cosine,
            ar = real[a]!,
            ai = imaginary[a]!
          real[a] = ar + r
          imaginary[a] = ai + im
          real[b] = ar - r
          imaginary[b] = ai - im
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] = real[i]! / n
        imaginary[i] = imaginary[i]! / n
      }
    }
  }
}

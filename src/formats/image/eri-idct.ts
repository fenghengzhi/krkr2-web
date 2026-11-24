// ERINA-Library 1.0A, cpp/erimatrixb.cpp. Copyright (C) 2000-2002 Leshade
// Entis, Entis-soft. See docs/decisions/119-eri-png-and-hosted-codecs.md.
const pi = 3.141592653589, f32 = Math.fround, cosQuarter = f32(Math.cos(pi / 4))

/** Each stage owns the intermediate REAL32 arrays used by the two half-size
 * transforms. One instance is reused across rows, columns and image blocks. */
class DctStage {
  private readonly child?: DctStage
  private readonly k: Float32Array
  private readonly evenInput: Float32Array
  private readonly oddInput: Float32Array
  private readonly even: Float32Array
  private readonly odd: Float32Array
  constructor(private readonly size: number) {
    const half = size / 2
    this.k = Float32Array.from({ length: half }, (_, i) => Math.cos((2 * i + 1) * pi / (2 * size)))
    this.evenInput = new Float32Array(half)
    this.oddInput = new Float32Array(half)
    this.even = new Float32Array(half)
    this.odd = new Float32Array(half)
    if (size > 4) this.child = new DctStage(half)
  }

  private oddTransform(): void {
    this.child!.forward(this.oddInput, this.odd)
    let previous = 0
    for (let i = 0; i < this.odd.length; i++) {
      this.odd[i] = 2 * this.odd[i]! - previous
      previous = this.odd[i]!
    }
  }

  private forward(input: Float32Array, output: Float32Array): void {
    const half = this.size / 2
    for (let i = 0; i < half; i++) {
      const left = input[i]!, right = input[this.size - i - 1]!
      this.evenInput[i] = left + right
      this.oddInput[i] = f32(left - right) * this.k[i]!
    }
    if (!this.child) {
      const a = this.evenInput[0]!, b = this.evenInput[1]!, c = this.oddInput[0]!, d = this.oddInput[1]!
      output[0] = 0.5 * (a + b)
      output[2] = cosQuarter * f32(a - b)
      output[1] = c + d
      output[3] = f32(2 * cosQuarter * f32(c - d)) - output[1]!
      return
    }
    this.child.forward(this.evenInput, this.even)
    this.oddTransform()
    for (let i = 0; i < half; i++) {
      output[2 * i] = this.even[i]!
      output[2 * i + 1] = this.odd[i]!
    }
  }

  inverse(input: Float32Array, output: Float32Array): void {
    const half = this.size / 2
    for (let i = 0; i < half; i++) {
      this.evenInput[i] = input[2 * i]!
      this.oddInput[i] = input[2 * i + 1]! * this.k[i]!
    }
    if (this.child) {
      this.child.inverse(this.evenInput, this.even)
      this.oddTransform()
    } else {
      const a = this.evenInput[0]!, b = f32(this.evenInput[1]! * cosQuarter)
      this.even[0] = a + b
      this.even[1] = a - b
      const c = this.oddInput[0]!, d = this.oddInput[1]!
      this.odd[0] = c + d
      this.odd[1] = f32(2 * cosQuarter * f32(c - d)) - this.odd[0]!
    }
    for (let i = 0; i < half; i++) {
      output[i] = this.even[i]! + this.odd[i]!
      output[this.size - i - 1] = this.even[i]! - this.odd[i]!
    }
  }
}

export class EriInverseDct {
  private readonly stage: DctStage
  private readonly input: Float32Array
  private readonly output: Float32Array
  constructor(private readonly size: number) {
    this.stage = new DctStage(size)
    this.input = new Float32Array(size)
    this.output = new Float32Array(size)
  }

  transform(plane: Float32Array): void {
    const { size, input, output, stage } = this
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) input[y] = plane[y * size + x]!
      stage.inverse(input, output)
      for (let y = 0; y < size; y++) plane[y * size + x] = output[y]!
    }
    for (let y = 0; y < size; y++) {
      input.set(plane.subarray(y * size, (y + 1) * size))
      stage.inverse(input, output)
      plane.set(output, y * size)
    }
  }
}

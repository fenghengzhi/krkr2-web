export function wave(samples: number[], rate = 1000, channels = 1): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2),
    view = new DataView(bytes.buffer)
  const text = (at: number, value: string) =>
    [...value].forEach((ch, i) => {
      bytes[at + i] = ch.charCodeAt(0)
    })
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) =>
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true),
  )
  return bytes
}
export function midi(tracks: number[][], division = 480): Uint8Array {
  const bytes = new Uint8Array(14 + tracks.reduce((sum, track) => sum + track.length + 8, 0)),
    view = new DataView(bytes.buffer)
  bytes.set([77, 84, 104, 100])
  view.setUint32(4, 6)
  view.setUint16(8, tracks.length === 1 ? 0 : 1)
  view.setUint16(10, tracks.length)
  view.setUint16(12, division)
  let at = 14
  for (const track of tracks) {
    bytes.set([77, 84, 114, 107], at)
    view.setUint32(at + 4, track.length)
    bytes.set(track, at + 8)
    at += 8 + track.length
  }
  return bytes
}
export class AudioClock {
  now = 0
  tasks = new Set<{ at: number; callback: () => void }>()
  schedule = (callback: () => void, delay: number) => {
    const task = { at: this.now + delay, callback }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number): void {
    this.now += ms
    for (let guard = 0; guard < 10000; guard++) {
      const task = [...this.tasks].find((task) => task.at <= this.now)
      if (!task) return
      this.tasks.delete(task)
      task.callback()
    }
    throw new Error('Audio clock failed to settle')
  }
}

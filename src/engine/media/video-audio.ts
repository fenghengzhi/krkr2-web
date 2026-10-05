/** Fixed KRKR2 2.32stable WaveImpl.cpp:515–568. The public 0..100000
 * controls address a 101-entry integer attenuation table, not linear gain. */
const attenuationTable = Array.from({ length: 101 }, (_, index) =>
  index === 0 ? -10000 : Math.trunc(Math.log10(index / 100) * 5000))

export function videoVolumeAttenuation(volume: number): number {
  return attenuationTable[Math.max(0, Math.min(100, Math.trunc(volume / 1000)))]!
}

export function videoBalanceAttenuation(balance: number): number {
  const step = Math.max(-100, Math.min(100, Math.trunc(balance / 1000)))
  return step === 0 ? 0 : step < 0 ? attenuationTable[100 + step]! : -attenuationTable[100 - step]!
}

/** Preserve the original inverse's integer truncation. Public balance is a
 * graph readback, distinct from the last script assignment. */
export function videoBalanceReadback(balance: number): number {
  const attenuation = videoBalanceAttenuation(balance)
  if (attenuation <= -10000) return -100000
  if (attenuation >= 10000) return 100000
  return (100 - Math.trunc(10 ** (-Math.abs(attenuation) / 5000) * 100)) *
    (attenuation < 0 ? -1000 : 1000)
}

/** IBasicAudio attenuation is in hundredths of a decibel. One balance side
 * keeps full amplitude; the other side is attenuated, without cross-feed. */
export function videoAudioGains(volume: number, balance: number): { left: number; right: number } {
  const amplitude = (attenuation: number) => attenuation <= -10000 ? 0 : 10 ** (attenuation / 2000),
    gain = amplitude(videoVolumeAttenuation(volume)), pan = videoBalanceAttenuation(balance)
  return { left: gain * (pan > 0 ? amplitude(-pan) : 1),
    right: gain * (pan < 0 ? amplitude(pan) : 1) }
}

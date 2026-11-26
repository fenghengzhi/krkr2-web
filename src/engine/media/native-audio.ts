/** KRKR2 2.32stable WaveImpl.cpp:515–568; shared by Wave and VideoOverlay. */
const attenuationTable = Array.from({ length: 101 }, (_, index) =>
  index === 0 ? -10000 : Math.trunc(Math.log10(index / 100) * 5000))
const amplitudes = attenuationTable.map((attenuation) => attenuation <= -10000 ? 0 : 10 ** (attenuation / 2000))
const step = (volume: number) => Math.max(0, Math.min(100, Math.trunc(volume / 1000)))

export function nativeVolumeAttenuation(volume: number): number { return attenuationTable[step(volume)]! }
export function nativePanAttenuation(balance: number): number {
  const value = Math.max(-100, Math.min(100, Math.trunc(balance / 1000)))
  return value === 0 ? 0 : value < 0 ? attenuationTable[100 + value]! : -attenuationTable[100 - value]!
}
/** DirectSound/IBasicAudio hundredths of a decibel. One pan side remains at
 * full amplitude; the other is attenuated cumulatively with volume. */
export function nativeAudioGains(volume: number, balance: number): { left: number; right: number } {
  const gain = amplitudes[step(volume)]!, pan = Math.max(-100, Math.min(100, Math.trunc(balance / 1000))),
    side = amplitudes[100 - Math.abs(pan)]!
  return { left: gain * (pan > 0 ? side : 1), right: gain * (pan < 0 ? side : 1) }
}

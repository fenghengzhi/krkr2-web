import { nativePanAttenuation } from './native-audio.ts'
export { nativeVolumeAttenuation as videoVolumeAttenuation, nativePanAttenuation as videoBalanceAttenuation,
  nativeAudioGains as videoAudioGains } from './native-audio.ts'

/** Preserve the original inverse's integer truncation. Public balance is a
 * graph readback, distinct from the last script assignment. */
export function videoBalanceReadback(balance: number): number {
  const attenuation = nativePanAttenuation(balance)
  if (attenuation <= -10000) return -100000
  if (attenuation >= 10000) return 100000
  return (100 - Math.trunc(10 ** (-Math.abs(attenuation) / 5000) * 100)) *
    (attenuation < 0 ? -1000 : 1000)
}

import { nativeAudioGains } from './native-audio.ts'

const combine = (first: number, second: number) => Math.trunc(Math.trunc(first / 10) * Math.trunc(second / 10) / 1000)

/** WaveImpl::SetVolumeToSoundBuffer truncates each integer division before
 * combining the next control. Quantizing only the final float product can
 * choose a different one-percent attenuation-table entry. Inputs are the
 * already narrowed/clamped public controls. */
export function waveCombinedVolume(volume: number, volume2: number, globalVolume: number, muted = false): number {
  let value = combine(volume, volume2)
  value = combine(value, globalVolume)
  return combine(value, muted ? 0 : 100000)
}
export function waveAudioGains(volume: number, volume2: number, globalVolume: number, pan: number, muted = false) {
  return nativeAudioGains(waveCombinedVolume(volume, volume2, globalVolume, muted), pan)
}

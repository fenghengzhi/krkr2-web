import type { AudioAsset, SoundKind, SoundSettings } from '../ports/audio.ts'

/** WaveImpl.cpp:143 and 2090: only an explicit "no" disables a supplied
 * option; declared speaker layouts and >=3 channels cannot be 3D sources. */
export const waveUse3dOption = (value: string | undefined): boolean => value !== undefined && value !== 'no'
export const waveSpatialSource = (kind: SoundKind, settings: SoundSettings, asset: AudioAsset): boolean =>
  kind === 'wave' && !!settings.waveUse3d && asset.kind !== 'midi' && !asset.speakerMask && asset.channels <= 2

export function wavePosition(value: readonly number[] = [0, 0, 0]): [number, number, number] | undefined {
  if (value.length !== 3 || value.some((coordinate) => !Number.isFinite(coordinate) || !Number.isFinite(Math.fround(coordinate))))
    return
  return [Math.fround(value[0]!), Math.fround(value[1]!), Math.fround(value[2]!)]
}

/** Stereo compatibility rendering, not a physical DirectSound/HRTF claim.
 * KRKR leaves the listener at (0,0,0), front +Z/up +Y, and the default
 * min/max distances 1/1e9 and rolloff 1. Microsoft documents amplitude
 * halving when distance doubles (ee418662). The stereo direction uses the
 * two-speaker angular power interpolation also described by Wine 10.0
 * dsound/sound3d.c and dsound.c:1055 (speakers at -90/+90 degrees).
 * Elevation participates in the direction: native pan places Y at .001.
 * Front/back share stereo gains; no cone, velocity or listener controls are
 * exposed by WaveSoundBuffer. Compute only when coordinates change. */
export function waveSpatialGains(position: readonly number[]): readonly [number, number] {
  const [x, y, z] = position as readonly [number, number, number], distance = Math.hypot(x, y, z),
    direction = distance ? Math.asin(Math.max(-1, Math.min(1, x / distance))) / Math.PI : 0,
    gain = 1 / Math.max(1, Math.min(1e9, distance))
  return [Math.sqrt(.5 - direction) * gain, Math.sqrt(.5 + direction) * gain]
}

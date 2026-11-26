import type { AudioCommand, PcmEncoding, WaveConversion } from '../ports/audio.ts'

export const waveConversionOption = (value: string | undefined): WaveConversion | undefined =>
  value === 'i16' || value === 'i16m' ? value : undefined

/** With no intermediate signal processing, narrowing directly from RIFF's
 * original integer bytes preserves the low-bit boundary Float32 would lose.
 * Connected filters and Smooth need the original normalized input instead. */
export const waveNarrowS32 = (command: Extract<AudioCommand, { op: 'open' | 'openSource' }>): boolean =>
  command.kind === 'wave' && !!command.settings.waveConversion && !command.filters?.length &&
  !command.loops.links.some((link) => link.smooth)

const normalized = (value: number) => value === 0 ? 0 : value / 32768

/** WaveIntf::TVPConvertPCMTo16bits / WaveImpl::ReadL2Buffer, KRKR2 2.32.
 * Copyright (C) 2000 W.Dee and contributors; original license is distributed
 * in public/licenses/phase-vocoder/. Conversion occurs after SLI and filters.
 * Integer containers through 24 bits remain exact in the normalized planes;
 * direct s32 RIFF decoding narrows before normalization where safe; filters,
 * Smooth and pre-normalized custom sources retain their Float32 precision.
 * Float conversion uses
 * the original scalar nearest/away-from-zero rule, not the x86 SSE block's
 * alignment-dependent ties-to-even. Undeclared normalized inputs use float. */
export function convertWaveOutput(data: readonly Float32Array[], frames: number,
  mode: WaveConversion, encoding: PcmEncoding | undefined): void {
  const channels = data.length, mono = mode === 'i16m' && channels > 1,
    integer = encoding === 'u8' || encoding?.startsWith('s'),
    clip = (value: number) => Math.max(-32768, Math.min(32767, value)),
    rounded = (value: number) => clip(Math.trunc(value + (value > 0 ? .5 : -.5)))
  for (let frame = 0; frame < frames; frame++) {
    if (mono) {
      let sum = 0
      if (integer) {
        // Native integer downmix narrows every channel before integer division.
        for (let channel = 0; channel < channels; channel++) sum += clip(Math.floor(data[channel]![frame]! * 32768))
        data[0]![frame] = normalized(Math.trunc(sum / channels))
      } else {
        const scale = Math.fround(32768 / channels)
        for (let channel = 0; channel < channels; channel++)
          sum = Math.fround(sum + Math.fround(data[channel]![frame]! * scale))
        data[0]![frame] = normalized(rounded(sum))
      }
    } else for (let channel = 0; channel < channels; channel++) {
      const value = data[channel]![frame]! * 32768
      data[channel]![frame] = normalized(integer ? clip(Math.floor(value)) : rounded(value))
    }
  }
}

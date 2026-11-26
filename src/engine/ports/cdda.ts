/** Web virtual disc bindings; cue paths address imported game storage only. */
export interface CddaDisc { readonly drive: string; readonly cue: string; readonly volumeLabel?: string }
export function copyCddaDiscs(value?: readonly CddaDisc[]): readonly CddaDisc[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 26) throw new Error('Invalid virtual CDDA disc bindings')
  const drives = new Set<string>()
  return Object.freeze(value.map((disc) => {
    if (!disc || typeof disc.drive !== 'string' || !/^[a-z]$/i.test(disc.drive) ||
        typeof disc.cue !== 'string' || !disc.cue || disc.cue.length > 4096 || disc.cue.includes('\0'))
      throw new Error('Invalid virtual CDDA disc binding')
    const drive = disc.drive.toUpperCase()
    if (drives.has(drive)) throw new Error('Duplicate virtual CDDA drive')
    const { volumeLabel } = disc
    if (volumeLabel !== undefined && (typeof volumeLabel !== 'string' || volumeLabel.length > 255 || /[\0\r\n]/.test(volumeLabel)))
      throw new Error('Invalid virtual CD volume label')
    drives.add(drive)
    return Object.freeze({ drive, cue: disc.cue, ...(volumeLabel !== undefined && { volumeLabel }) })
  }))
}
/** Local decoder metadata; ByteSource and these ranges never cross a worklet. */
export type CddaPcmPart = { kind: 'silence'; frames: number } | {
  kind: 'file'; offset: number; size: number; encoding: 'encoded' | 's16le' | 's16be'
  startFrame: number; endFrame?: number
}
export interface CddaPcmTrack { readonly parts: readonly CddaPcmPart[] }

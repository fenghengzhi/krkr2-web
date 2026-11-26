/** Public 2.32 Layer arguments use a four-bit filter and stRefNoClip=0x10.
 * The embedding's direct TypeScript raster API retains its modern 0..19
 * filter IDs and 0x10000 flag. Keep that translation at the script boundary.
 * Gaussian/Blackman script names use an unambiguous extension namespace. */
export function scriptStretchMode(mode: number): number {
  if (!Number.isSafeInteger(mode) || mode < 0) return mode
  const neighbors = (mode & 0x10) !== 0
  const base = neighbors ? mode - 0x10 : mode
  const rasterFlag = neighbors ? 0x10000 : 0
  if (base >= 0x20000 && base <= 0x20003)
    return (16 + base - 0x20000) | rasterFlag
  if (mode <= 0x1f || (mode >= 0x10000 && mode <= 0x1001f))
    // The historical Web flag is not a stock flag. In a script it is ignored,
    // as in the original SDK; ambiguous saved integers are never guessed.
    return (mode & 15) | rasterFlag
  return mode // Preserve invalid-argument handling in the drawing operation.
}

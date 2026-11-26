/** SysInitImpl's -gclim system ceiling, not an instruction to enable the cache.
 * Native narrows the option to signed32 MiB, reserves -1 for automatic choice,
 * and stores the product as uint32 bytes. The default auto value is the Web
 * host's declared high-memory tier; it is not a physical-memory measurement. */
export function graphicCacheSystemLimit(
  option: string | undefined,
  parseInteger: ((value: string) => number) | undefined,
  autoBytes = 64 * 1024 * 1024,
): number {
  if (!Number.isInteger(autoBytes) || autoBytes < 0 || autoBytes > 0xffffffff)
    throw new Error('Invalid automatic graphic cache limit')
  if (option === undefined) return autoBytes
  // Native ttstr is NUL-terminated, including the exact "auto" comparison.
  const nul = option.indexOf('\0'), value = nul < 0 ? option : option.slice(0, nul)
  if (value === 'auto') return autoBytes
  if (!parseInteger) throw new Error('Script runtime does not support native startup integer conversion')
  const megabytes = parseInteger(value)
  if (!Number.isInteger(megabytes) || megabytes < -0x80000000 || megabytes > 0x7fffffff)
    throw new Error('Invalid native startup integer result')
  return megabytes === -1 ? autoBytes : (megabytes * 0x100000) >>> 0
}

import { TvpError } from '../system/tvp-error.ts'

/** Public game storage addresses are names in one session, never network URLs. */
const publicRoot = 'game://./'
const fileRoot = 'file://./'
const scheme = /^[a-z][a-z0-9+.-]*:/i

/** Strict relative input for imports and persistence. Public media are not accepted here. */
export function normalizeResourcePath(input: string, allowRoot = false): string {
  if (input.includes('\0') || scheme.test(input) || /^[\\/]/.test(input))
    throw new Error(`Invalid resource path: ${input}`)
  const components: string[] = []
  for (const component of input.replaceAll('\\', '/').split('/')) {
    if (!component || component === '.') continue
    if (component === '..') {
      if (!components.length) throw new Error('Resource path escapes game root')
      components.pop()
    } else components.push(component)
  }
  const normalized = components.join('/')
  // Dot elimination must not reveal a new media/drive prefix. This also makes
  // a validated internal key safe to pass through the boundary a second time.
  if (scheme.test(normalized)) throw new Error(`Invalid resource path: ${input}`)
  if (!allowRoot && !normalized) throw new Error('Empty resource path')
  return normalized
}

function relativeInput(input: string): string {
  const slashes = input.replaceAll('\\', '/')
  if (/^game:\/\/\.\//i.test(slashes)) return slashes.slice(publicRoot.length)
  if (/^game:\/\/\//i.test(slashes)) return slashes.slice('game:///'.length)
  if (scheme.test(slashes)) throw new TvpError('TVPUnsupportedMediaName',
    [slashes.slice(0, slashes.indexOf(':')).toLowerCase()], `Unsupported storage media: ${input}`)
  if (slashes.startsWith('//./')) return slashes.slice(4)
  if (slashes.startsWith('///')) return slashes.slice(3)
  if (slashes.startsWith('//')) throw new Error(`Unsupported storage domain: ${input}`)
  if (slashes.startsWith('/')) return slashes.slice(1)
  return slashes
}

function directoryEnding(path: string): boolean {
  return /\/$/.test(path) || /(?:^|\/)\.{1,2}$/.test(path)
}

/** Decode either a public name or a legacy relative name into a logical address.
 * Directory delimiters survive; archives and members have separate root bounds.
 * Percent escapes, # and ? have no URL semantics. Paths preserve their spelling.
 */
function normalizeComponents(path: string): string {
  const delimiter = path.indexOf('>')
  if (delimiter < 0) {
    const normalized = normalizeResourcePath(path, true)
    return normalized + (normalized && directoryEnding(path) ? '/' : '')
  }
  if (path.indexOf('>', delimiter + 1) >= 0)
    throw new Error('Nested archive addresses are not supported')
  const archive = normalizeResourcePath(path.slice(0, delimiter))
  const member = path.slice(delimiter + 1)
  const normalized = normalizeResourcePath(member, true)
  return archive + '>' + normalized + (normalized && directoryEnding(member) ? '/' : '')
}

/** Only an explicitly bound virtual drive can translate an OS-style input.
 * Canonical file-medium names also serve as logical keys, disjoint from imports. */
export function discAddress(input: string): { drive: string; path: string } | undefined {
  const slashes = input.replaceAll('\\', '/')
  const match = /^file:\/\/\.\/([a-z])\/(.*)$/is.exec(slashes)
  return match ? { drive: match[1]!.toUpperCase(), path: match[2]! } : undefined
}
export function discStoragePath(drive: string, relative: string): string {
  return fileRoot + drive.toLowerCase() + '/' + normalizeComponents(relative).replace(/[A-Z]/g, (c) => c.toLowerCase())
}
export function nativeDiscPath(input: string): string | undefined {
  const match = /^([a-z]):\/(.*)$/is.exec(input.replaceAll('\\', '/'))
  return match ? discStoragePath(match[1]!, match[2]!) : undefined
}
export function parseStoragePath(input: string, currentDirectory = ''): string {
  const disc = discAddress(input)
  if (disc) return discStoragePath(disc.drive, disc.path)
  const absolute = /^(?:game:\/\/(?:\.\/|\/)|\/)/i.test(input.replaceAll('\\', '/'))
  const relative = relativeInput(input)
  const base = !absolute && discAddress(currentDirectory)
  if (base) return discStoragePath(base.drive, base.path + relative)
  return normalizeComponents((absolute ? '' : currentDirectory) + relative)
}

export function toPublicStoragePath(logical: string, currentDirectory = ''): string {
  const path = parseStoragePath(logical, currentDirectory)
  return discAddress(path) ? path : publicRoot + path
}

export function getFullStoragePath(input: string, currentDirectory = ''): string {
  return input === '' ? '' : toPublicStoragePath(input, currentDirectory)
}

/** Validate a file operation without accidentally writing a directory or root. */
export function storageFilePath(input: string, currentDirectory = ''): string {
  const path = parseStoragePath(input, currentDirectory)
  if (!path || path.endsWith('/') || path.endsWith('>'))
    throw new Error('Expected a storage file path')
  return path
}

/** Registration checks the caller's delimiter before any normalization. */
export function storageDirectoryPath(input: string, currentDirectory = ''): string {
  if (!/[\\/>]$/.test(input)) throw new TvpError('TVPMissingPathDelimiterAtLast', [], 'Missing storage directory delimiter at end')
  const path = parseStoragePath(input, currentDirectory)
  return path && !/[/>]$/.test(path) ? path + '/' : path
}

export function storageWritePath(input: string, currentDirectory = ''): string {
  const path = storageFilePath(input, currentDirectory)
  if (path.includes('>')) throw new TvpError('TVPCannotWriteToArchive', [], 'Archive storage is read-only')
  if (discAddress(path)) throw new TvpError('TVPCannotOpenStorage', [input], 'CD storage is read-only')
  return path
}

function separator(character: string | undefined): boolean {
  return character === '/' || character === '\\' || character === '>'
}
function basenameStart(path: string): number {
  for (let i = path.length - 1; i >= 0; i--) if (separator(path[i])) return i + 1
  return 0
}
function extensionStart(path: string): number {
  for (let i = path.length - 1; i >= 0; i--) {
    if (separator(path[i])) break
    if (path[i] === '.') return i
  }
  return path.length
}

// These are lexical TJS operations, deliberately independent of media validation.
export function extractStorageExt(path: string): string {
  return path.slice(extensionStart(path))
}
export function extractStorageName(path: string): string {
  return path.slice(basenameStart(path))
}
export function extractStoragePath(path: string): string {
  return path.slice(0, basenameStart(path))
}
export function chopStorageExt(path: string): string {
  return path.slice(0, extensionStart(path))
}

/** Public game storage addresses are names in one session, never network URLs. */
const publicRoot = 'game://./'
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
  if (scheme.test(slashes)) throw new Error(`Unsupported storage media: ${input}`)
  return slashes
}

function directoryEnding(path: string): boolean {
  return /\/$/.test(path) || /(?:^|\/)\.{1,2}$/.test(path)
}

/** Decode either a public name or a legacy relative name into a logical address.
 * Directory delimiters survive; archives and members have separate root bounds.
 * Percent escapes, # and ? have no URL semantics. Paths preserve their spelling.
 */
export function parseStoragePath(input: string): string {
  const path = relativeInput(input)
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

export function toPublicStoragePath(logical: string): string {
  return publicRoot + parseStoragePath(logical)
}

export function getFullStoragePath(input: string): string {
  return input === '' ? '' : publicRoot + parseStoragePath(input)
}

/** Validate a file operation without accidentally writing a directory or root. */
export function storageFilePath(input: string): string {
  const path = parseStoragePath(input)
  if (!path || path.endsWith('/') || path.endsWith('>'))
    throw new Error('Expected a storage file path')
  return path
}

/** Registration checks the caller's delimiter before any normalization. */
export function storageDirectoryPath(input: string): string {
  if (!/[\\/>]$/.test(input)) throw new Error('Missing storage directory delimiter at end')
  const path = parseStoragePath(input)
  return path && !/[/>]$/.test(path) ? path + '/' : path
}

export function storageWritePath(input: string): string {
  const path = storageFilePath(input)
  if (path.includes('>')) throw new Error('Archive storage is read-only')
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

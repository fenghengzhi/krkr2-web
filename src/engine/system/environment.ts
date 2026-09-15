import packageInfo from '../../../package.json' with { type: 'json' }
import { normalizePath } from '../storage/resolver.ts'

const packageVersion = packageInfo.version
if (!/^\d+\.\d+\.\d+$/.test(packageVersion))
  throw new Error('System version requires a numeric project package version')

/** Validate before player/worker resources are opened as well as at engine init. */
export function normalizeSystemDataPath(input?: string): string {
  if (input !== undefined && typeof input !== 'string')
    throw new Error('Invalid System dataPath: expected text')
  const template = input || '$(exepath)/savedata'
  // A dot represents the virtual root while expanding separators. Replacing
  // $(exepath) with an empty string would turn its following slash absolute.
  const prefixes: Record<string, string> = {
    exepath: '.',
    personalpath: 'savedata',
    appdatapath: 'savedata',
    vistapath: 'savedata',
  }
  const expanded = template.replace(/\$\(([^)]+)\)/g, (macro, name: string) =>
    Object.hasOwn(prefixes, name) ? prefixes[name]! : macro,
  )
  const scheme = /^[a-z][a-z0-9+.-]*:/i
  if (scheme.test(expanded)) throw new Error('Invalid System dataPath: absolute URL or drive')
  if (expanded.includes('$(') || expanded.includes('>'))
    throw new Error('Invalid System dataPath: unknown macro or archive directory')
  // A final component lets normalizePath validate root directories as well
  // as nonempty ones. No such file is created or added to the resource list.
  const marker = '.krkr-directory'
  const normalized = normalizePath(expanded + '/' + marker)
  // Dot segments can expose a drive/scheme prefix that was not at the start
  // of the input (for example ./C:\\save). Reject it before creating the VM.
  if (scheme.test(normalized)) throw new Error('Invalid System dataPath: absolute URL or drive')
  const dataPath = normalizePath(normalized).slice(0, -marker.length)
  if (dataPath.length > 4096) throw new Error('System dataPath exceeds 4096 characters')
  return dataPath
}

/** Paths are prefixes in the mounted game's VFS, never host filesystem paths. */
export class SystemEnvironment {
  readonly exePath = ''
  readonly exeName = 'krkr2-web'
  readonly personalPath = 'savedata/'
  readonly appDataPath = 'savedata/'
  readonly dataPath: string
  readonly platformName = 'Web'
  readonly osName = 'Web'
  readonly versionString = packageVersion + '.0'
  title = 'krkr2-web'

  constructor(
    arguments_: ReadonlyMap<string, string> | undefined,
    private readonly fillRandomBytes?: (bytes: Uint8Array) => void,
  ) {
    this.dataPath = normalizeSystemDataPath(arguments_?.get('-datapath'))
  }

  versionInformation(languageVersion: string | undefined): string {
    if (!languageVersion || !/^\d+\.\d+\.\d+$/.test(languageVersion))
      throw new Error('Native TJS version information is unavailable')
    return `krkr2-web/${this.versionString} TJS2/${languageVersion} (Web)`
  }

  createUUID(): string {
    if (!this.fillRandomBytes) throw new Error('Web Crypto random bytes are unavailable')
    const bytes = new Uint8Array(16)
    this.fillRandomBytes(bytes)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

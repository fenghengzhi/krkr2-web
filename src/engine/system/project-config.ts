import { MAX_RESOURCE_BYTES, type Resource } from '../ports/storage.ts'
import { projectExecutableResource, type GameProject } from '../storage/project.ts'
import { chopStorageExt, extractStorageName, extractStoragePath } from '../storage/public-path.ts'
import { parseEngineConfig } from './config-file.ts'
import { readEmbeddedConfig } from './embedded-config.ts'
import { normalizeSystemDataPath } from './environment.ts'

interface ConfigReader {
  saved(name: string): Resource | undefined
  decode(bytes: Uint8Array): Promise<string>
  check(): void | Promise<void>
  warn(message: string): void
}

/** SysInitImpl reads the default file before locating the per-user file.
 * Only the final argument lookup includes the user file's -datapath. */
export async function readProjectConfig(
  project: GameProject,
  files: readonly Resource[],
  host: ReadonlyMap<string, string>,
  { saved, decode, check, warn }: ConfigReader,
) {
  const launcher = projectExecutableResource(files, project)
  if (!launcher) return
  const executable = launcher.name
  const options = async (name: string) => {
    await check()
    let file = saved(name)
    if (!file) {
      const folded = name.toLowerCase()
      const matches = files.filter((entry) => !entry.aliasOf && entry.name.toLowerCase() === folded)
      file = matches.find((entry) => entry.name === name)
      if (!file && matches.length > 1) throw new Error('Ambiguous engine configuration: ' + name)
      file ??= matches[0]
    }
    if (!file) return new Map<string, string>()
    let text: string
    try {
      if (file.size > MAX_RESOURCE_BYTES) throw new Error('Configuration exceeds 64 MiB')
      const bytes = await file.read()
      if (bytes.length !== file.size) throw new Error('Incomplete configuration read')
      // SysInitImpl uses a Windows ANSI reader independent of TJS encoding.
      text = await decode(bytes)
    } catch (error) {
      await check()
      warn(`Unable to read engine configuration ${file.name}: ${String(error)}`)
      return new Map<string, string>()
    }
    await check()
    return parseEngineConfig(text)
  }
  const embedded = await readEmbeddedConfig(launcher, { decode, checkpoint: check, warn })
  const stem = chopStorageExt(executable), defaults = await options(stem + '.cf')
  const dataDirectory = normalizeSystemDataPath(host.get('-datapath') ?? defaults.get('-datapath') ?? embedded.get('-datapath'),
    extractStoragePath(executable))
  const user = await options(dataDirectory + extractStorageName(stem) + '.cfu')
  return { executable, dataDirectory, arguments: new Map([...embedded, ...defaults, ...user, ...host]) }
}

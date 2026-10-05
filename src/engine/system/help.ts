import type { Resource } from '../ports/storage.ts'
import {
  helpByteLimit,
  helpPathLimit,
  helpTextLimit,
  type HelpPort,
} from '../ports/help.ts'
import { ExecutionControl } from '../scheduler/control.ts'
import { cancelable } from '../scheduler/cancelable.ts'
import {
  extractStorageName,
  parseStoragePath,
  storageFilePath,
  toPublicStoragePath,
} from '../storage/public-path.ts'

/** Browser-local means this game's VFS, not an OS path. Conversion applies the
 * frozen current directory but never performs an auto-path search. */
export function getWebLocalName(input: string, currentDirectory = ''): string {
  const path = parseStoragePath(input, currentDirectory)
  if (path.includes('>')) throw new Error('Archive members do not have a local name')
  const name = toPublicStoragePath(path)
  if (name.length > helpPathLimit) throw new Error('Local storage name exceeds 4096 characters')
  return name
}

/** The Web shell opens bounded VFS text documents. Unsupported targets return
 * false; read/decode/presentation failures preserve their real error. */
export async function openHelpDocument(
  target: string,
  parameters: string,
  options: {
    find(name: string): Resource | undefined
    decode(bytes: Uint8Array): Promise<string>
    host: HelpPort
    control: ExecutionControl
    currentDirectory?: string
  },
): Promise<boolean> {
  const { control } = options
  control.check()
  if (parameters !== '' || target.length > helpPathLimit) return false
  let path: string
  try {
    path = storageFilePath(target, options.currentDirectory)
  } catch {
    return false
  }
  if (path.includes('>') || !/\.(txt|md|log)$/i.test(path)) return false
  const resource = options.find(toPublicStoragePath(path))
  if (!resource || resource.name.includes('>') || resource.size > helpByteLimit) return false
  const name = toPublicStoragePath(resource.name)
  if (name.length > helpPathLimit) return false
  const bytes = await cancelable(resource.read(), control)
  control.check()
  if (bytes.length > helpByteLimit) return false
  const text = await cancelable(options.decode(bytes), control)
  control.check()
  if (text.length > helpTextLimit) return false
  const shown = await cancelable(
    options.host.show({ path: name, title: extractStorageName(resource.name), text }),
    control,
  )
  control.check()
  if (typeof shown !== 'boolean') throw new Error('Invalid help presentation result')
  return shown
}

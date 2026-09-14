import type { LibraryGame } from '../../protocol/library.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'

export const LIBRARY_DIRECTORY = 'krkr2-library-v1'
export const LIBRARY_DATABASE = 'krkr2-library'
export const LIBRARY_WRITE_LOCK = 'krkr2-library:v1:write'
export const LIBRARY_BLOCK_BYTES = 1024 * 1024
export const MAX_LIBRARY_GAMES = 256
export const MAX_LIBRARY_BYTES = 64 * 1024 ** 3
export interface LibraryFile {
  path: string
  size: number
  hashes: string[]
  remoteIdentity?: string
}
export interface LibraryRecord extends LibraryGame {
  version: 1
  files: LibraryFile[]
}
export function libraryId(id: string): string {
  if (!/^entry-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
    throw new Error('Invalid library entry identifier')
  return id
}
export function libraryReadLock(id: string): string {
  return 'krkr2-library:v1:' + libraryId(id)
}
export function gameSettings(
  value: Pick<LibraryGame, 'title' | 'entry' | 'backend'>,
): Pick<LibraryGame, 'title' | 'entry' | 'backend'> {
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200)
    throw new Error('Game name must contain 1–200 characters')
  if (typeof value.entry !== 'string' || value.entry.length > 1024)
    throw new Error('Invalid game entry script')
  const entry = normalizePath(value.entry)
  if (entry.includes('>') || !['auto', 'asyncify', 'jspi'].includes(value.backend))
    throw new Error('Invalid game startup settings')
  return { title: value.title.trim(), entry, backend: value.backend }
}
export function validateRecord(value: unknown): LibraryRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid library record')
  const record = value as LibraryRecord
  libraryId(record.id)
  gameSettings(record)
  if (
    record.version !== 1 ||
    !/^game-[a-f0-9]{64}$/.test(record.gameId) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Array.isArray(record.files) ||
    !record.files.length ||
    record.files.length > 10000 ||
    record.fileCount !== record.files.length
  )
    throw new Error('Invalid library record metadata')
  let total = 0,
    hashes = 0
  for (const file of record.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length > 1024 ||
      normalizePath(file.path).includes('>') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Array.isArray(file.hashes) ||
      file.hashes.length !== Math.ceil(file.size / LIBRARY_BLOCK_BYTES)
    )
      throw new Error('Invalid library file metadata')
    if (file.hashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
      throw new Error('Invalid library file digest')
    if (
      file.remoteIdentity !== undefined &&
      (typeof file.remoteIdentity !== 'string' || file.remoteIdentity.length > 16384)
    )
      throw new Error('Invalid library remote identity')
    total += file.size
    hashes += file.hashes.length
    if (total > MAX_LIBRARY_BYTES || hashes > 65536)
      throw new Error('Library entry exceeds its storage or manifest budget')
  }
  if (
    record.size !== total ||
    new TextEncoder().encode(JSON.stringify(record)).length > 8 * 1024 * 1024
  )
    throw new Error('Invalid library total size or manifest budget')
  return record
}
export function validateSummary(value: unknown): LibraryGame {
  if (!value || typeof value !== 'object') throw new Error('Invalid library catalog entry')
  const game = value as LibraryGame
  libraryId(game.id)
  gameSettings(game)
  if (
    !/^game-[a-f0-9]{64}$/.test(game.gameId) ||
    !Number.isSafeInteger(game.createdAt) ||
    game.createdAt < 0 ||
    !Number.isSafeInteger(game.size) ||
    game.size < 0 ||
    game.size > MAX_LIBRARY_BYTES ||
    !Number.isInteger(game.fileCount) ||
    game.fileCount < 1 ||
    game.fileCount > 10000
  )
    throw new Error('Invalid library catalog metadata')
  return summary(game)
}
export function summary({
  id,
  gameId,
  title,
  entry,
  backend,
  createdAt,
  size,
  fileCount,
}: LibraryGame): LibraryGame {
  return { id, gameId, title, entry, backend, createdAt, size, fileCount }
}

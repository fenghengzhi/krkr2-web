import type { BackendPreference, GameFile } from './session.ts'
import type { GameEncodings, GameProject } from '../engine/storage/project.ts'
import type { CddaDisc } from '../engine/ports/cdda.ts'

export interface LibraryGame extends GameEncodings {
  id: string
  gameId: string
  title: string
  entry: string
  backend: BackendPreference
  createdAt: number
  size: number
  fileCount: number
  /** Absent in legacy collection records. */
  project?: GameProject
  sourceGameId?: string
  /** Absent retains automatic single-disc discovery. Order selects the default disc. */
  cddaDiscs?: readonly CddaDisc[]
}
export interface LibraryStatus {
  available: boolean
  reason?: string
  games: LibraryGame[]
  downloads?: LibraryDownload[]
  usage?: number
  quota?: number
  persisted: boolean
}
export interface LibraryDownload {
  id: string
  gameId: string
  title: string
  size: number
  reopenable: boolean
}
export interface LibraryImport extends GameEncodings {
  operation: string
  files: GameFile[]
  title: string
  entry: string
  backend: BackendPreference
  expectedGameId: string
  project?: GameProject
  cddaDiscs?: readonly CddaDisc[]
}
export type LibraryImportRequest = LibraryImport | { download: string; operation: string }
export interface LibraryProgress {
  operation: string
  phase: 'preparing' | 'copying' | 'committing'
  completed: number
  reused?: number
  total: number
  file: string
}
export interface LibraryApi {
  connect(events: MessagePort): Promise<LibraryStatus>
  list(): Promise<LibraryStatus>
  importGame(request: LibraryImportRequest): Promise<LibraryGame>
  cancel(operation: string): Promise<void>
  remove(id: string, unfinishedOnly?: boolean): Promise<void>
  update(id: string, settings: Pick<LibraryGame, 'title' | 'entry' | 'backend' | 'cddaDiscs'>): Promise<void>
}

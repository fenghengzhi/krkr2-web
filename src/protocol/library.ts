import type { BackendPreference, GameFile } from './session.ts'

export interface LibraryGame {
  id: string
  gameId: string
  title: string
  entry: string
  backend: BackendPreference
  createdAt: number
  size: number
  fileCount: number
}
export interface LibraryStatus {
  available: boolean
  reason?: string
  games: LibraryGame[]
  usage?: number
  quota?: number
  persisted: boolean
}
export interface LibraryImport {
  operation: string
  files: GameFile[]
  title: string
  entry: string
  backend: BackendPreference
  expectedGameId: string
}
export interface LibraryProgress {
  operation: string
  phase: 'preparing' | 'copying' | 'committing'
  completed: number
  total: number
  file: string
}
export interface LibraryApi {
  connect(events: MessagePort): Promise<LibraryStatus>
  list(): Promise<LibraryStatus>
  importGame(request: LibraryImport): Promise<LibraryGame>
  cancel(operation: string): Promise<void>
  remove(id: string): Promise<void>
  update(id: string, settings: Pick<LibraryGame, 'title' | 'entry' | 'backend'>): Promise<void>
}

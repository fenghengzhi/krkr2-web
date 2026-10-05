/** File names belong to the current virtual game, never to the browser's host OS. */
export interface StorageSelectorEntry {
  readonly name: string
  readonly size: number
  readonly archive: boolean
}

export interface StorageSelectorFilter {
  readonly label: string
  readonly pattern: string
}

/** One directory's canonical public names. Archive contents are opened only
 * when this directory is requested, never by the initial root listing. */
export interface StorageSelectorDirectory {
  readonly name: string
  readonly entries: readonly StorageSelectorEntry[]
  readonly directories: readonly string[]
}

export interface StorageSelectorPresentation {
  readonly save: boolean
  readonly name: string
  readonly initialDirectory: string
  readonly defaultExtension: string
  readonly filters: readonly StorageSelectorFilter[]
  /** One based when filters exist, otherwise zero. */
  readonly filterIndex: number
  readonly entries: readonly StorageSelectorEntry[]
  readonly directories: readonly string[]
}

/** The engine checks this again after the UI's overwrite confirmation. */
export interface StorageSelectorChoice {
  readonly name: string
  readonly filterIndex: number
  readonly overwrite: boolean
}

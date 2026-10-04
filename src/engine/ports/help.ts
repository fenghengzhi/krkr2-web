/** Bounded, already decoded VFS text; never markup or an OS command. */
export interface HelpDocument {
  path: string
  title: string
  text: string
}
export const helpByteLimit = 4 * 1024 * 1024
export const helpTextLimit = 1_048_576
export const helpPathLimit = 4096

export function isHelpDocument(value: unknown): value is HelpDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<HelpDocument>
  return (
    typeof doc.path === 'string' && doc.path.length > 0 && doc.path.length <= helpPathLimit &&
    typeof doc.title === 'string' && doc.title.length > 0 && doc.title.length <= helpPathLimit &&
    typeof doc.text === 'string' && doc.text.length <= helpTextLimit
  )
}

/** Resolves after presentation is installed, without waiting for dismissal. */
export interface HelpPort {
  show(document: HelpDocument): Promise<boolean>
  close(): void
}

export const unavailableHelp = (): HelpPort => ({
  show: async () => false,
  close() {},
})

import type { StorageSelectorPresentation } from './storage-selector.ts'

/** A structured-clone-safe dialog presentation, scoped to one Session generation. */
interface DialogRequest {
  readonly id: number
  readonly caption: string
  readonly text: string
  readonly value: string
}
export type SystemDialogRequest = DialogRequest &
  (
    | { readonly kind: 'inform' | 'input-string' }
    | { readonly kind: 'storage-selector'; readonly selector: StorageSelectorPresentation }
  )

/** A primitive-only dialog presentation, scoped to one Session generation. */
export interface SystemDialogRequest {
  readonly id: number
  readonly kind: 'inform' | 'input-string'
  readonly caption: string
  readonly text: string
  readonly value: string
}

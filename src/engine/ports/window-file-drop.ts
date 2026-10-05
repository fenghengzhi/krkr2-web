/** A host drop belongs to one Window surface, independent of input focus. */
export interface WindowFileDropIdentity {
  readonly windowId: number
  readonly surfaceEpoch: number
  readonly sequence: number
}

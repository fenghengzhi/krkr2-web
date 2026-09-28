import type { PadAck, PadMessage, PadPresentation } from '../protocol/pad.ts'

export interface PadHostClient {
  readonly generation: number
  send(message: PadMessage): Promise<PadAck>
  stop(): Promise<void>
  /** Exact game font resource selected for this Pad, or a host font fallback. */
  font?(
    id: number,
    epoch: number,
  ): Promise<{ family: string; bold: boolean; italic: boolean; bytes: Uint8Array } | null>
}

/** The DOM adapter owns editor surfaces, never script objects or game Windows. */
export interface PadHost {
  attach(client: PadHostClient): void
  update(presentation: PadPresentation): void
  /** Wait for observed UI edits before a host-side script read or save action. */
  flush(): Promise<void>
  dispose(): void
}

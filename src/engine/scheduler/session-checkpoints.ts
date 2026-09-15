import type { ScriptObject } from '../script/runtime.ts'
import type { WindowRecord } from '../scene/windows.ts'
import type { EventOutcome } from './system-events.ts'

/** Session-private completion state. Admission and scheduler body completion
 * remain separate from these native and presentation obligations. */
export interface SessionEventReceipt {
  readonly id: number
  readonly completion: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  outcome?: EventOutcome
  round?: number
  epilogueDone: boolean
  checkpoint?: number
  nativeDone: boolean
  tailDone: boolean
  terminal: boolean
  failed: boolean
  error?: unknown
  /** An unentered video event already owns its callback; other admissions do not. */
  deferredSettlement?: () => void
  frameWindows: WindowRecord[]
  frameAfter: Map<number, number>
}

export interface SessionCheckpoint {
  readonly id: number
  readonly receipts: readonly number[]
  readonly tailReceipts: readonly number[]
  readonly tail: boolean
  readonly paint: boolean
  phase: 'issued' | 'entered' | 'publishing' | 'committing' | 'parked'
  paintBlocked: boolean
  savedPainted?: Set<number>
  paintStarted: boolean
  frameRan: boolean
}

export interface CheckpointCallbacks {
  pump: ScriptObject
  publish: ScriptObject
  commit: ScriptObject
}

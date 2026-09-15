/** A surface identity belongs to one session and one attachment attempt. */
export interface WindowSurfaceIdentity {
  generation: number
  windowId: number
  surfaceEpoch: number
}

/** Worker -> page. This port is independent of the serial script RPC queue. */
export type WindowSurfaceRequest = WindowSurfaceIdentity & { type: 'request' | 'detach' }

/** Page -> Worker. The canvas is transferred, never shared with the page. */
export type WindowSurfaceReply = WindowSurfaceIdentity &
  ({ type: 'attach'; canvas: OffscreenCanvas } | { type: 'failed'; message: string })

export function hasWindowSurfaceIdentity(value: unknown): value is WindowSurfaceIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<WindowSurfaceIdentity>
  return [identity.generation, identity.windowId, identity.surfaceEpoch].every(
    (part) => typeof part === 'number' && Number.isSafeInteger(part) && part > 0,
  )
}

export function windowSurfaceIdentity(value: WindowSurfaceIdentity): WindowSurfaceIdentity {
  return {
    generation: value.generation,
    windowId: value.windowId,
    surfaceEpoch: value.surfaceEpoch,
  }
}

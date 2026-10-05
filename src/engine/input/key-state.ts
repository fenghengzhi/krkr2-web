const padAny = 0x1df
const padKey = (key: number) =>
  (key >= 0x1b5 && key <= 0x1b8) || (key >= 0x1c0 && key <= 0x1c9)
const queryable = (key: number) =>
  Number.isInteger(key) && ((key > 0 && key <= 0xff) || padKey(key))

/** Session-local physical observations, not the desktop's global Win32 state.
 * Browser snapshots contain admitted Pad keys, never the PADANY query alias.
 * A repeated snapshot/keyDown cannot create a second press edge while held. */
export class ObservedKeyState {
  private held = new Set<number>()
  private readonly pushed = new Set<number>()

  get current(): ReadonlySet<number> { return this.held }

  replace(keys: Iterable<number>): void {
    const next = new Set(keys)
    for (const key of next)
      if (queryable(key) && !this.held.has(key)) this.pushed.add(key)
    this.held = next
  }

  query(code: number | bigint, current = true): boolean {
    // SystemImpl converts through tjs_int then tjs_uint. Keep the low 32 bits
    // before converting a TJS int64 to Number, including large script values.
    const key = typeof code === 'bigint' ? Number(BigInt.asUintN(32, code)) : code >>> 0
    if (key === padAny) {
      let result = false
      for (const candidate of current ? this.held : this.pushed) {
        if (!padKey(candidate)) continue
        result = true
        if (!current) this.pushed.delete(candidate)
      }
      return result
    }
    if (!queryable(key)) return false
    if (padKey(key)) {
      // DInputMgn GetAsyncState keeps the push flag on a current-state read.
      return current ? this.held.has(key) : this.pushed.delete(key)
    }
    // SystemImpl calls GetAsyncKeyState for either result bit: even a current
    // read consumes that key's since-previous-call flag. Browser observations
    // cannot reproduce other applications consuming Win32's unreliable bit.
    const pressed = this.pushed.delete(key)
    return current ? this.held.has(key) : pressed
  }

  /** Releasing focus/device admission does not consume an unqueried press. */
  release(): void { this.held.clear() }

  /** Only terminal Session retirement discards both current and past input. */
  reset(): void {
    this.held.clear()
    this.pushed.clear()
  }
}

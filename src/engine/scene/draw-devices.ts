/** Script-visible passthrough devices own Window presentation choices, not OS
 * pointers. Windows-only backends map to the supported Web CPU/WebGL paths. */
export class DrawDevices {
  private next = 1
  private disposed = false
  private devices = new Map<number, { identity: string; preferred: number; drawer: number; window?: number; size?: string; unobserve?: () => void }>()
  private windows = new Map<number, number>()
  constructor(private readonly reset: (window: number, recreate: boolean) => void) {}
  create(identity: string, observe?: (retire: () => void) => () => void): number {
    if (this.disposed) throw new Error('Draw device service has been disposed')
    if (!Number.isSafeInteger(this.next)) throw new Error('Draw device identities are exhausted')
    const id = this.next++
    this.devices.set(id, { identity, preferred: 0, drawer: 0 })
    try {
      const unobserve = observe?.(() => this.destroy(id))
      const device = this.devices.get(id)
      if (device) device.unobserve = unobserve
      else unobserve?.()
    } catch (error) { this.devices.delete(id); throw error }
    return id
  }
  private get(id: number) {
    const device = this.devices.get(id)
    if (!device) throw new Error('Draw device has been invalidated')
    return device
  }
  preferred(id: number): number { return this.get(id).preferred }
  setPreferred(id: number, value: number): void { this.get(id).preferred = value | 0 }
  drawer(id: number): number { return this.get(id).drawer }
  attach(window: number, id: number, identity: string): void {
    const device = this.get(id)
    if (device.identity !== identity) throw new Error('Draw device interface is not owned by this object')
    if (device.window !== undefined && device.window !== window)
      throw new Error('A draw device cannot be shared by multiple Web windows')
    const previousId = this.windows.get(window)
    if (previousId === id) return
    const previous = previousId === undefined ? undefined : this.devices.get(previousId)
    if (previous) { previous.window = undefined; previous.drawer = 0; previous.size = undefined }
    device.window = window
    device.drawer = 0
    device.size = undefined
    this.windows.set(window, id)
    // Publish the complete ownership change before calling the output backend:
    // disposal/status callbacks may synchronously retire this Window.
    this.reset(window, previousId !== undefined)
  }
  attached(window: number): boolean { return this.windows.has(window) }
  detach(window: number): void {
    const id = this.windows.get(window)
    if (id === undefined) return
    this.windows.delete(window)
    const device = this.devices.get(id)
    if (device?.window === window) { device.window = undefined; device.drawer = 0; device.size = undefined }
    this.reset(window, true)
  }
  recreate(id: number): void {
    const device = this.get(id)
    device.drawer = 0
    device.size = undefined
    if (device.window !== undefined) this.reset(device.window, true)
  }
  /** Selection is deferred until actual drawing, or a source/destination size
   * change. Assigning preferredDrawer alone does not replace an active drawer. */
  prepare(window: number, width: number, height: number, sourceWidth: number, sourceHeight: number): number {
    const id = this.windows.get(window)
    if (id === undefined) return 0
    const device = this.get(id), size = `${width}:${height}:${sourceWidth}:${sourceHeight}`
    if (!device.drawer || device.size !== size) {
      device.drawer = device.preferred === 1 || device.preferred === 2 ? 1 : 4
      device.size = size
    }
    return device.drawer
  }
  destroy(id: number): void {
    const device = this.devices.get(id)
    if (!device) return
    const window = device.window
    this.devices.delete(id)
    const errors: unknown[] = []
    try { device.unobserve?.() } catch (error) { errors.push(error) }
    if (window !== undefined && this.windows.get(window) === id) {
      this.windows.delete(window)
      try { this.reset(window, true) } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Draw device retirement failed')
  }
  closeWindow(window: number): void {
    const id = this.windows.get(window)
    if (id === undefined) return
    this.windows.delete(window)
    const device = this.devices.get(id)
    if (device) { device.window = undefined; device.drawer = 0; device.size = undefined }
  }
  dispose(): void {
    this.disposed = true
    this.windows.clear()
    const errors: unknown[] = []
    for (const id of [...this.devices.keys()]) try { this.destroy(id) } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Draw device cleanup failed')
  }
}

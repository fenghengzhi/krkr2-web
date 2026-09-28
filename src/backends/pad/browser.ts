/** Browser-only Pad export. A completed call means handed to the download UI,
 * never that the user has saved bytes to disk. */
export class BrowserPadDownloads {
  private readonly urls = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly document: Document) {}

  download(fileName: string, text: string): void {
    if (this.disposed) throw new DOMException('Pad downloads are closed', 'AbortError')
    if (this.urls.size >= 32)
      throw new DOMException('Too many pending Pad downloads', 'QuotaExceededError')
    const browser = this.document.defaultView
    if (!browser) throw new DOMException('Pad document has no browser window', 'InvalidStateError')
    // The worker supplies the validated name and CRLF snapshot. Do not read
    // live textarea content here: it may have changed while the dialog was open.
    const anchor = this.document.createElement('a'),
      blob = new Blob([text], { type: 'text/plain;charset=utf-8' }),
      url = URL.createObjectURL(blob)
    // Install ownership before calling the embedding document: append/click
    // may synchronously Stop the player and dispose this download host.
    this.urls.set(
      url,
      setTimeout(() => {
        URL.revokeObjectURL(url)
        this.urls.delete(url)
      }, 30_000),
    )
    try {
      anchor.href = url
      anchor.download = fileName
      anchor.hidden = true
      this.document.body.append(anchor)
      if (!this.disposed) anchor.click()
    } catch (error) {
      const timer = this.urls.get(url)
      if (timer !== undefined) clearTimeout(timer)
      this.urls.delete(url)
      URL.revokeObjectURL(url)
      throw error
    } finally {
      anchor.remove()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [url, timer] of this.urls) {
      clearTimeout(timer)
      URL.revokeObjectURL(url)
    }
    this.urls.clear()
  }
}

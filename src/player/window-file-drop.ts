import { captureDrop, enumerateDrop } from './drop-files.ts'
import type { BrowserInputCoordinator } from '../backends/input/coordinator.ts'

/** Own only file drops on this exact live Window DOM surface. Page editors and
 * menu controls do not become game input merely because their Window exists. */
export function attachWindowFileDrop(element: HTMLElement, windowId: number, epoch: number,
  input: BrowserInputCoordinator, error: (reason: unknown) => void): () => void {
  const abort = new AbortController(), files = (event: DragEvent) =>
    !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'),
    target = (event: DragEvent) => event.target instanceof Element && element.contains(event.target) &&
      !event.target.closest('.game-window-menu, .game-menu-overlay, .game-clipboard, .game-help, input, textarea, [contenteditable="true"]'),
    available = (event: DragEvent) => !abort.signal.aborted && target(event) && input.canDropFiles(windowId, epoch)
  element.addEventListener('dragover', (event) => {
    if (!files(event)) return
    // Rejected file drops must not navigate the browser away from the game.
    event.preventDefault()
    event.dataTransfer!.dropEffect = available(event) ? 'copy' : 'none'
  }, { signal: abort.signal })
  element.addEventListener('drop', (event) => {
    if (!files(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!available(event)) return
    try {
      // Entry/handle capabilities must be captured while DataTransfer is live;
      // enumeration itself waits in the ordinary input FIFO.
      const captured = captureDrop(event.dataTransfer!)
      input.queueFileDrop(windowId, epoch, (signal) => enumerateDrop(captured, { signal }))
    } catch (reason) { error(reason) }
  }, { signal: abort.signal })
  return () => abort.abort()
}

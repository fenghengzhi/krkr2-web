import { exposeRpc } from 'vite-plugin-worker-rpc/runtime'
import { createSession } from '../player/create-session.ts'
import { importSources } from '../backends/files/import-resources.ts'
import { resolveFiles, type SourceFile } from '../backends/files/source-files.ts'
import { HttpRangePool } from '../backends/files/http-range.ts'
import { gameIdentity } from '../player/game-identity.ts'
import { PROTOCOL_VERSION, type InputAdmissionAck, type SessionApi } from '../protocol/session.ts'
import type { EngineSession, SessionAdmission } from '../engine/session.ts'
import { LibraryService, type LibraryLease } from '../player/library/service.ts'

let session: EngineSession | undefined
const sources = new HttpRangePool()
let prepared: SourceFile[] | undefined
let gameId: string | undefined
let preparing = false
let libraryLease: LibraryLease | undefined
let frameTimer: ReturnType<typeof setInterval> | undefined
let frameDelay = 0
function syncFrames() {
  const snapshot = session?.snapshot()
  const activity =
    snapshot && !['stopping', 'stopped', 'failed'].includes(snapshot.state)
      ? snapshot.activity.state
      : undefined
  const delay = activity === 'visible' ? 16 : activity === 'hidden' ? 250 : 0
  if (delay === frameDelay) return
  if (frameTimer) clearInterval(frameTimer)
  frameTimer = undefined
  frameDelay = delay
  if (delay)
    frameTimer = setInterval(() => {
      try {
        session?.present()
      } catch (error) {
        if (frameTimer) clearInterval(frameTimer)
        frameTimer = undefined
        frameDelay = 0
        session?.fail(error)
      }
    }, delay)
}
let mounting = false
let pendingClicks = 0
function active(): EngineSession {
  if (!session) throw new Error('Session has not been initialized')
  return session
}
function reserveInput(): void {
  if (pendingClicks >= 64) throw new Error('Input queue is full; wait for the current script')
  pendingClicks++
}
function admitInput(accept: (target: EngineSession) => SessionAdmission): InputAdmissionAck {
  const target = active()
  reserveInput()
  let admission: SessionAdmission
  try {
    admission = accept(target)
  } catch (error) {
    pendingClicks--
    throw error
  }
  // The page owns only the admission ACK. Keep the slot and the captured
  // Session until this particular callback operation settles, including when
  // a newer UI action or shutdown has overtaken its acknowledgment.
  void admission.completion.then(
    () => {
      pendingClicks--
    },
    (error: unknown) => {
      pendingClicks--
      if (target.control.cancelled) return
      try {
        target.fail(error)
      } catch (failure) {
        // Failure reporting may itself lose a disposed event port. The
        // detached completion must never become an unhandled rejection.
        console.error('Unable to report an admitted input failure', failure)
      }
    },
  )
  return { status: admission.status }
}
async function completeInput(operation: (target: EngineSession) => Promise<void>): Promise<void> {
  const target = active()
  reserveInput()
  try {
    await operation(target)
  } finally {
    pendingClicks--
  }
}
const api: SessionApi = {
  async prepare(files) {
    sources.signal.throwIfAborted()
    if (session || preparing || prepared) throw new Error('Worker already owns a game source')
    preparing = true
    let deadline = performance.now() + 8
    const checkpoint = async () => {
      sources.signal.throwIfAborted()
      if (performance.now() >= deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        deadline = performance.now() + 8
      }
      sources.signal.throwIfAborted()
    }
    try {
      let filesReady: SourceFile[], identity: string
      if (!Array.isArray(files)) {
        libraryLease = await (await LibraryService.open()).acquire(files.libraryId, sources.signal)
        filesReady = libraryLease.files
        identity = libraryLease.record.gameId
      } else {
        filesReady = await resolveFiles(files, checkpoint, sources)
        identity = await gameIdentity(filesReady, checkpoint)
      }
      sources.signal.throwIfAborted()
      prepared = filesReady
      gameId = identity
      return identity
    } catch (error) {
      sources.close()
      await libraryLease?.close()
      throw error
    } finally {
      preparing = false
    }
  },
  async initialize(request) {
    sources.signal.throwIfAborted()
    if (session) throw new Error('Worker already owns a session')
    if (request.version !== PROTOCOL_VERSION) throw new Error('Worker protocol mismatch')
    if (request.clipboard !== undefined && !(request.clipboard instanceof MessagePort))
      throw new Error('Invalid clipboard channel')
    if (!prepared || request.gameId !== gameId)
      throw new Error('Prepare the game sources before initializing')
    session = createSession(request)
    session.control.onCancel(() => sources.close())
    await session.initialize()
    sources.signal.throwIfAborted()
    syncFrames()
    return session.snapshot()
  },
  async mount() {
    if (mounting) throw new Error('A mount operation is already in progress')
    const target = active()
    if (target.snapshot().state !== 'ready') throw new Error('Session is not ready for mounting')
    if (!prepared) throw new Error('Game sources are not prepared')
    mounting = true
    try {
      let deadline = performance.now() + 8
      const resources = await importSources(prepared, async () => {
        target.control.check()
        if (performance.now() >= deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          deadline = performance.now() + 8
        }
        await target.control.wait()
        target.control.check()
      })
      target.control.check()
      target.mount(resources)
      prepared = undefined
      return target.snapshot()
    } finally {
      mounting = false
    }
  },
  async start(entry) {
    if (mounting) throw new Error('Wait for file import to finish')
    await active().start(entry)
    return active().snapshot()
  },
  async evaluate(source) {
    return active().evaluate(source)
  },
  async pause() {
    active().pause()
    return active().snapshot()
  },
  async resume() {
    active().resume()
    return active().snapshot()
  },
  async retryGraphics() {
    active().retryGraphics()
    return active().snapshot()
  },
  async setActivity(activity) {
    active().setActivity(activity)
    syncFrames()
    return active().snapshot()
  },
  async click(x, y) {
    await completeInput((target) => target.click(x, y))
  },
  async inspect() {
    return active().snapshot()
  },
  async pointerMove(x, y) {
    await completeInput((target) => target.pointerMove(x, y))
  },
  async pointerState(x, y, windowId) {
    active().pointerState(x, y, windowId)
  },
  async input(packet) {
    return admitInput((target) => target.acceptInput(packet, false))
  },
  async keyState(keys) {
    active().keyState(keys)
  },
  async exitFullScreen(windowId) {
    active().exitFullScreen(windowId)
  },
  async activateWindow(windowId) {
    return admitInput((target) => target.acceptActivateWindow(windowId))
  },
  async closeWindow(windowId) {
    return admitInput((target) => target.acceptCloseWindow(windowId))
  },
  async moveWindow(windowId, left, top) {
    active().moveWindow(windowId, left, top)
  },
  async resizeWindow(windowId, width, height) {
    active().resizeWindow(windowId, width, height)
  },
  async menuClick(id, popup) {
    return admitInput((target) => target.acceptMenuClick(id, popup))
  },
  async menuDismiss(popup) {
    active().menuDismiss(popup)
  },
  async setDebugVisibility(panel, visible) {
    active().setDebugVisibility(panel, visible)
    return active().snapshot()
  },
  async setSystemFonts(fonts) {
    active().setSystemFonts(fonts)
  },
  async selectFont(id, face) {
    active().selectFont(id, face)
  },
  async selectSystemDialog(id, value) {
    return active().selectSystemDialog(id, value)
  },
  async previewFont(id, face, kind) {
    return active().previewFont(id, face, kind)
  },
  async stop() {
    sources.close()
    prepared = undefined
    if (frameTimer) clearInterval(frameTimer)
    frameTimer = undefined
    frameDelay = 0
    await session?.stop()
    await libraryLease?.close()
    libraryLease = undefined
  },
  async exportSaves() {
    return active().exportSaves()
  },
  async importSaves(files) {
    await active().importSaves(files)
  },
}
exposeRpc(api, self)

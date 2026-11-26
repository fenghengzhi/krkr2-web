import { LibraryClient } from '../../src/player/library-client.ts'
import { gameIdentity } from '../../src/player/game-identity.ts'
import type { LibraryImport } from '../../src/protocol/library.ts'
import type {} from './client-stop-embedding.ts'

async function request(operation: string): Promise<LibraryImport> {
  const blob = new Blob(['var value=7;']), files = [{ path: 'startup.tjs', blob }],
    expectedGameId = await gameIdentity([{ path: 'startup.tjs', source: { size: blob.size,
      read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) } }])
  return { operation, files, expectedGameId, title: 'Actual client import', entry: 'startup.tjs', backend: 'asyncify' }
}
async function held(operation: 'importGame' | 'cancel' | 'connect', error: () => string) {
  const deadline = performance.now() + 15000
  while (!window.clientStopBoundary.read().workers.some((worker) => worker.held.some((reply) => reply.operation === operation))) {
    if (error()) throw new Error(error())
    if (performance.now() >= deadline) throw new Error(`Missing actual ${operation} reply`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Complete a real tiny OPFS import, then hold its real success reply and the
 * matching cancel reply. This tests transport settlement, not rollback of an
 * already committed game. No unused-operation shortcut or invented response. */
export async function exerciseLibraryCancellation(mode: 'forced' | 'healthy') {
  const client = new LibraryClient(() => {}), input = await request('watchdog-' + mode)
  try {
    const before = await client.call('list')
    if (!before.available) throw new Error(before.reason ?? 'Library unavailable')
    window.clientStopBoundary.arm('importGame', 'cancel')
    let error = ''
    const imported = client.call('importGame', input).then((game) => ({ game, error: '' }), (failure: unknown) => {
      error = failure instanceof Error ? failure.name + ':' + failure.message : String(failure)
      return { game: undefined, error }
    })
    await held('importGame', () => error)
    const cancellation = client.cancel(input.operation)
    await held('cancel', () => error)
    if (mode === 'healthy') window.clientStopBoundary.release('importGame')
    await cancellation
    const outcome = await imported, afterTimeout = window.clientStopBoundary.read(),
      recovered = await client.call('list')
    // A late cancel reply after healthy completion must not stop the usable
    // connection. The original payload is delivered unchanged exactly once.
    if (mode === 'healthy') window.clientStopBoundary.release('cancel')
    for (const game of recovered.games) await client.call('remove', game.id)
    client.close()
    return { before, recovered, outcome, expectedGameId: input.expectedGameId,
      afterTimeout, afterRecovery: window.clientStopBoundary.read() }
  } finally { client.close() }
}

/** Ordinary construction/transport failures at connect must release the
 * attempted import and the failed RPC so this same client can import again. */
export async function exerciseLibraryConnectRetry(phase: 'construction' | 'post') {
  const client = new LibraryClient(() => {}), input = await request('retry-' + phase),
    before = window.clientStopBoundary.read()
  try {
    window.clientStopBoundary.failConnect(phase)
    let error = ''
    try { await client.call('importGame', input) }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
    const failed = window.clientStopBoundary.read(), game = await client.call('importGame', input),
      recovered = await client.call('list')
    await client.call('remove', game.id)
    client.close()
    return { phase, before, error, failed, game, recovered, after: window.clientStopBoundary.read() }
  } finally { client.close() }
}

export async function exerciseLibraryRetiredConnection() {
  const client = new LibraryClient(() => {}), before = window.clientStopBoundary.read()
  try {
    window.clientStopBoundary.arm('connect')
    let error = ''
    const prior = client.call('list').then(() => '', (failure: unknown) => {
      error = failure instanceof Error ? failure.message : String(failure)
      return error
    })
    await held('connect', () => error)
    // dispose rejects the old handshake. Start its replacement in this same
    // turn, before the old rejection continuation gets a chance to clean up.
    client.close()
    const retry = client.call('list'), rejected = await prior, recovered = await retry
    client.close()
    return { before, rejected, recovered, after: window.clientStopBoundary.read() }
  } finally { client.close() }
}

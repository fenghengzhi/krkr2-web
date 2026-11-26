import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { kagIntroSource } from './kag-intro-observation.ts'

let packageRequest: Promise<Buffer> | undefined
/** Both routes import the identical pinned distribution, without a scenario
 * patch, extra startup script or replacement system class. Hosted only. */
export function originalIntroduction(): Promise<Buffer> {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Original KAG introduction acquisition and verification require a GitHub-hosted runner')
  return packageRequest ??= (async () => {
    const response = await fetch(kagIntroSource.url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('Original introduction download returned HTTP ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, kagIntroSource.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), kagIntroSource.sha256)
    return bytes
  })()
}

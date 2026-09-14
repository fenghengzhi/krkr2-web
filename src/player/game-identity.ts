import type { SourceFile } from '../backends/files/source-files.ts'
export async function gameIdentity(
  files: SourceFile[],
  checkpoint: () => Promise<void> = async () => {},
): Promise<string> {
  const digests: { path: string; size: number; sample: string; remote?: string }[] = []
  const hash = async (data: ArrayBuffer) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    await checkpoint()
    if (file.remoteIdentity !== undefined) {
      digests.push({
        path: file.path.replaceAll('\\', '/'),
        size: file.source.size,
        sample: '',
        remote: file.remoteIdentity,
      })
      continue
    }
    const first = await file.source.read(0, Math.min(file.source.size, 65536))
    await checkpoint()
    const last =
      file.source.size > 65536
        ? await file.source.read(
            Math.max(65536, file.source.size - 65536),
            Math.min(65536, file.source.size - 65536),
          )
        : new Uint8Array()
    const samples = new Uint8Array(first.length + last.length)
    samples.set(first)
    samples.set(last, first.length)
    digests.push({
      path: file.path.replaceAll('\\', '/'),
      size: file.source.size,
      sample: await hash(samples.buffer),
    })
  }
  const identity = 'game-' + (await hash(new TextEncoder().encode(JSON.stringify(digests)).buffer))
  await checkpoint()
  return identity
}

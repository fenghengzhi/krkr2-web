export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => {}
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Runs in the session Worker; no UI permission or main-thread round trip. */
export function fillWebRandomBytes(bytes: Uint8Array): void {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function')
    throw new Error('Web Crypto random bytes are unavailable')
  crypto.getRandomValues(bytes)
}

export const backgroundPreferenceKey = 'krkr2-web:pause-when-hidden'
export function readPauseWhenHidden(): boolean {
  try {
    return localStorage.getItem(backgroundPreferenceKey) !== 'continue'
  } catch {
    return true
  }
}
export function writePauseWhenHidden(paused: boolean): boolean {
  try {
    localStorage.setItem(backgroundPreferenceKey, paused ? 'pause' : 'continue')
    return true
  } catch {
    return false
  }
}

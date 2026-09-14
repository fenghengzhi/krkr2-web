const generic = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])
export function cssFontFamily(name: string): string {
  const plain = name.trim().replace(/^@/, '')
  return generic.has(plain.toLowerCase()) ? plain.toLowerCase() : JSON.stringify(plain)
}

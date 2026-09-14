import type { Resource } from '../ports/storage.ts'

export function normalizePath(input: string): string {
  if (input.includes('\0') || /^[a-z]+:/i.test(input) || /^[\\/]/.test(input))
    throw new Error(`Invalid resource path: ${input}`)
  const components: string[] = []
  for (const component of input.replaceAll('\\', '/').split('/')) {
    if (!component || component === '.') continue
    if (component === '..') {
      if (!components.length) throw new Error('Resource path escapes game root')
      components.pop()
    } else components.push(component)
  }
  if (!components.length) throw new Error('Empty resource path')
  return components.join('/')
}

export function normalizeStorageName(input: string, directory = false): string {
  const delimiter = input.indexOf('>')
  if (delimiter < 0) return normalizePath(input)
  if (input.indexOf('>', delimiter + 1) >= 0)
    throw new Error('Nested archive addresses are not supported')
  const archive = normalizePath(input.slice(0, delimiter))
  const entry = input.slice(delimiter + 1)
  return archive + '>' + (directory && !entry ? '' : normalizePath(entry))
}

export class StorageResolver {
  private files = new Map<string, Resource>()
  private folded = new Map<string, Set<string>>()
  private autoPaths: string[] = []
  mount(resources: Resource[]): void {
    // Validate the entire mount before mutating the active namespace.
    const prepared = resources.map((resource) => ({
      resource,
      name: normalizeStorageName(resource.name),
    }))
    for (const { resource, name } of prepared) {
      this.files.set(name, { ...resource, name, cacheToken: {} })
      const folded = name.toLowerCase()
      const names = this.folded.get(folded) ?? new Set<string>()
      names.add(name)
      this.folded.set(folded, names)
    }
  }
  addAutoPath(path: string): void {
    const normalized = normalizeStorageName(path.replace(/\/$/, ''), true)
    if (!this.autoPaths.includes(normalized)) this.autoPaths.push(normalized)
  }
  removeAutoPath(path: string): void {
    const normalized = normalizeStorageName(path.replace(/\/$/, ''), true)
    this.autoPaths = this.autoPaths.filter((path) => path !== normalized)
  }
  candidates(path: string): string[] {
    const normalized = normalizeStorageName(path)
    const basename = normalized.split(/[/>]/).at(-1)!
    return [
      normalized,
      ...this.autoPaths
        .slice()
        .reverse()
        .map((prefix) => prefix + (prefix.endsWith('>') ? '' : '/') + basename),
    ]
  }
  find(path: string): Resource | undefined {
    const exact = this.files.get(path)
    if (exact) return exact
    const names = this.folded.get(path.toLowerCase())
    if (names?.size === 1) return this.files.get(names.values().next().value!)!
    if (names && names.size > 1) throw new Error(`Ambiguous resource name: ${path}`)
    return undefined
  }
  resolve(path: string): Resource {
    for (const candidate of this.candidates(path)) {
      const resource = this.find(candidate)
      if (resource) return resource
    }
    throw new Error(`Resource not found: ${path}`)
  }
  exists(path: string): boolean {
    try {
      this.resolve(path)
      return true
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Resource not found:')) return false
      throw error
    }
  }
  list(): { name: string; size: number }[] {
    return [...this.files.values()].map(({ name, size }) => ({ name, size }))
  }
  get count(): number {
    return this.files.size
  }
  clear(): void {
    this.files.clear()
    this.folded.clear()
    this.autoPaths = []
  }
}

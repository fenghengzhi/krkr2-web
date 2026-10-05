import type { Resource } from '../ports/storage.ts'

import { normalizeResourcePath, parseStoragePath, storageDirectoryPath } from './public-path.ts'

// Kept as the strict relative import/key boundary for existing callers.
export const normalizePath = normalizeResourcePath

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
  private aliases = new Map<string, string>()
  private foldedAliases = new Map<string, Set<string>>()
  private autoPaths: string[] = []
  mount(resources: Resource[]): void {
    // Validate the entire mount before mutating the active namespace.
    const prepared = resources.map((resource) => ({
      resource,
      name: normalizeStorageName(resource.name),
      aliasOf: resource.aliasOf === undefined ? undefined : normalizeStorageName(resource.aliasOf),
    }))
    const available = new Set([...this.files.keys(), ...prepared.filter((entry) => entry.aliasOf === undefined).map((entry) => entry.name)])
    for (const { name, aliasOf } of prepared) {
      if (aliasOf !== undefined && (!aliasOf.includes('>') || name.includes('>') ||
          name !== aliasOf.slice(aliasOf.indexOf('>') + 1) || !available.has(aliasOf)))
        throw new Error(`Invalid archive compatibility alias: ${name}`)
    }
    for (const { resource, name, aliasOf } of prepared) {
      if (aliasOf === undefined) this.files.set(name, { ...resource, name, cacheToken: {} })
      else this.aliases.set(name, aliasOf)
      const table = aliasOf === undefined ? this.folded : this.foldedAliases,
        folded = name.toLowerCase(), names = table.get(folded) ?? new Set<string>()
      names.add(name)
      table.set(folded, names)
    }
  }
  addAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path)
    if (!this.autoPaths.includes(normalized)) this.autoPaths.push(normalized)
  }
  removeAutoPath(path: string): void {
    const normalized = storageDirectoryPath(path)
    this.autoPaths = this.autoPaths.filter((path) => path !== normalized)
  }
  candidates(path: string): string[] {
    const normalized = parseStoragePath(path)
    if (!normalized || /[/>]$/.test(normalized)) return [normalized]
    const basename = normalized.split(/[/>]/).at(-1)!
    return [
      normalized,
      ...this.autoPaths
        .slice()
        .reverse()
        .map((prefix) => prefix + basename),
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
  private fallback(path: string): Resource | undefined {
    const exact = this.aliases.get(path)
    if (exact !== undefined) return this.files.get(exact)
    const names = this.foldedAliases.get(path.toLowerCase())
    if (names?.size === 1) return this.files.get(this.aliases.get(names.values().next().value!)!)
    if (names && names.size > 1) throw new Error(`Ambiguous archive compatibility alias: ${path}`)
    return undefined
  }
  /** A package's bare import aliases are a Web startup convenience, not files
   * in the real current directory. They must not preempt KAG's patch paths.
   * Folder auto paths can still address the imported package's virtual root. */
  lookup(path: string, overlay?: (name: string) => Resource | undefined): Resource | undefined {
    const [direct, ...searched] = this.candidates(path),
      current = overlay?.(direct!) ?? this.find(direct!)
    if (current) return current
    for (const candidate of searched) {
      const resource = overlay?.(candidate) ?? this.find(candidate) ?? this.fallback(candidate)
      if (resource) return resource
    }
    return this.fallback(direct!)
  }
  resolve(path: string): Resource {
    const resource = this.lookup(path)
    if (resource) return resource
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
    return this.files.size + this.aliases.size
  }
  clear(): void {
    this.files.clear()
    this.folded.clear()
    this.aliases.clear()
    this.foldedAliases.clear()
    this.autoPaths = []
  }
}

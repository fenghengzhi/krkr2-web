import type {
  StorageSelectorChoice,
  StorageSelectorDirectory,
  StorageSelectorPresentation,
} from '../engine/ports/storage-selector.ts'
import {
  extractStorageExt,
  extractStorageName,
  extractStoragePath,
  getFullStoragePath,
} from '../engine/storage/public-path.ts'

interface SelectorActions {
  browse?(directory: string): Promise<StorageSelectorDirectory | null>
  available(): boolean
  choose(value: string): void
  status(value: string): void
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}
const folded = (value: string) => value.toLowerCase()
const filterLimitMessage = '筛选过于复杂，请缩短文件类型模式或直接输入文件名。'

function compileFilter(pattern: string) {
  // Compilation and every filename share one render budget. Greedy globs
  // avoid regex backtracking, but long repeated prefixes still need a bound.
  let remaining = 2_000_000
  const spend = (count = 1) => {
    remaining -= count
    if (remaining < 0) throw new Error(filterLimitMessage)
  }
  spend(pattern.length)
  const patterns = pattern.split(';').flatMap((part) => {
      const glob = part.trim()
      if (!glob) return []
      return [glob === '*' || glob === '*.*' ? null : [...folded(glob)]]
    }),
    allFiles = patterns.includes(null)
  return (name: string) => {
    spend()
    if (allFiles) return true
    spend(name.length)
    const characters = [...folded(name)]
    return patterns.some((tokens) => {
      spend()
      if (!tokens) return true
      let character = 0,
        token = 0,
        star = -1,
        retry = 0
      while (character < characters.length) {
        spend(3)
        if (tokens[token] === '?' || tokens[token] === characters[character]) {
          character++
          token++
        } else if (tokens[token] === '*') {
          star = token++
          retry = character
        } else if (star >= 0) {
          token = star + 1
          character = ++retry
        } else return false
      }
      while (tokens[token] === '*') {
        spend()
        token++
      }
      return token === tokens.length
    })
  }
}

/** A retained view inside the existing System dialog and its modal lifetime. */
export function createStorageSelectorView(
  id: number,
  presentation: StorageSelectorPresentation,
  actions: SelectorActions,
) {
  const root = element('div'),
    directoryLabel = element('label', '目录'),
    directory = element('select'),
    list = element('div'),
    filenameLabel = element('label', '文件名'),
    input = element('input'),
    filterLabel = element('label', '文件类型'),
    filter = element('select'),
    overwrite = element('div'),
    overwriteText = element('p'),
    overwriteActions = element('div'),
    replace = element('button', '覆盖'),
    back = element('button', '返回')
  let enabled = true, browsing = false, disposed = false, navigation = 0,
    listing: StorageSelectorDirectory = { name: presentation.initialDirectory,
      entries: presentation.entries, directories: presentation.directories },
    pendingOverwrite: StorageSelectorChoice | undefined,
    submitted: StorageSelectorChoice | undefined
  root.className = 'storage-selector'
  directory.id = `storage-selector-directory-${id}`
  directoryLabel.htmlFor = directory.id
  directory.dataset.action = 'directory'
  const directoryOptions = () => {
    directory.replaceChildren()
    for (const name of listing.directories) {
      const option = element('option', name)
      option.value = name
      directory.append(option)
    }
    directory.value = listing.name
  }
  directoryOptions()
  list.className = 'storage-selector-entries'
  list.setAttribute('role', 'group')
  list.setAttribute('aria-label', '目录内容')
  input.id = `storage-selector-name-${id}`
  input.type = 'text'
  input.maxLength = 4096
  input.value = extractStorageName(presentation.name)
  input.autocomplete = 'off'
  input.spellcheck = false
  filenameLabel.htmlFor = input.id
  filter.id = `storage-selector-filter-${id}`
  filterLabel.htmlFor = filter.id
  if (presentation.filters.length) {
    presentation.filters.forEach((item, index) => {
      const option = element('option', `${item.label} (${item.pattern})`)
      option.value = String(index + 1)
      filter.append(option)
    })
    filter.value = String(presentation.filterIndex)
  } else {
    const option = element('option', '全部文件')
    option.value = '0'
    filter.append(option)
  }
  overwrite.className = 'storage-selector-overwrite'
  overwrite.hidden = true
  overwrite.setAttribute('role', 'group')
  overwrite.setAttribute('aria-label', '确认覆盖')
  overwriteActions.className = 'system-dialog-actions'
  replace.type = back.type = 'button'
  replace.dataset.action = 'overwrite'
  back.dataset.action = 'back'
  overwriteActions.append(back, replace)
  overwrite.append(overwriteText, overwriteActions)
  root.append(directoryLabel, directory, list, filenameLabel, input, filterLabel, filter, overwrite)

  const clearOverwrite = () => {
    pendingOverwrite = undefined
    submitted = undefined
    overwrite.hidden = true
    actions.status('')
  }
  const applyEnabled = () => {
    const disabled = !enabled || browsing || disposed
    root.setAttribute('aria-busy', String(browsing))
    directory.disabled = filter.disabled = replace.disabled = back.disabled = disabled
    input.readOnly = disabled
    for (const button of list.querySelectorAll('button')) button.disabled = disabled
  }
  const effectiveName = (name: string) => {
    if (name.endsWith('.')) return name.slice(0, -1)
    return !extractStorageExt(name) && presentation.defaultExtension
      ? name + '.' + presentation.defaultExtension
      : name
  }
  const confirmOverwrite = (choice: StorageSelectorChoice) => {
    pendingOverwrite = { ...choice, overwrite: true }
    overwriteText.textContent = `“${effectiveName(choice.name)}”已经存在。要覆盖此文件吗？`
    overwrite.hidden = false
    actions.status('请确认是否覆盖现有文件。')
    if (actions.available()) replace.focus({ preventScroll: true })
  }
  const navigate = async (name: string) => {
    if (disposed || browsing || !actions.available()) { directory.value = listing.name; return }
    clearOverwrite()
    const version = ++navigation
    browsing = true
    applyEnabled()
    actions.status('正在读取目录…')
    try {
      const next = actions.browse ? await actions.browse(name)
        : { name, entries: presentation.entries, directories: presentation.directories }
      if (disposed || version !== navigation || !actions.available()) return
      if (next) { listing = next; directoryOptions(); render() }
      actions.status('')
    } catch (reason) {
      if (!disposed && version === navigation)
        actions.status(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!disposed && version === navigation) {
        browsing = false
        directory.value = listing.name
        applyEnabled()
        if (actions.available()) input.focus({ preventScroll: true })
      }
    }
  }
  const render = () => {
    list.replaceChildren()
    const current = directory.value,
      pattern = presentation.filters[Number(filter.value) - 1]?.pattern ?? '*'
    for (const name of listing.directories) {
      if (name === current || name === 'game://./') continue
      const path = name.slice(0, -1)
      if (extractStoragePath(path) !== current) continue
      const button = element(
        'button',
        extractStorageName(path) + (name.endsWith('>') ? ' ›（只读）' : '/'),
      )
      button.type = 'button'
      button.className = 'storage-selector-directory'
      button.dataset.directory = name
      button.addEventListener('click', () => void navigate(name))
      list.append(button)
    }
    try {
      const matches = compileFilter(pattern),
        files = document.createDocumentFragment()
      for (const entry of listing.entries) {
        if (extractStoragePath(entry.name) !== current) continue
        const basename = extractStorageName(entry.name)
        if (!matches(basename)) continue
        const button = element('button'),
          label = element('span', basename),
          detail = element('span', `${entry.size} B${entry.archive ? ' · 只读' : ''}`)
        button.type = 'button'
        button.className = 'storage-selector-file'
        button.dataset.entryName = entry.name
        button.setAttribute('aria-label', basename)
        detail.className = 'storage-selector-detail'
        button.append(label, detail)
        button.addEventListener('click', () => {
          if (!actions.available()) return
          clearOverwrite()
          input.value = basename
          input.focus({ preventScroll: true })
          input.select()
        })
        files.append(button)
      }
      // Do not expose an incomplete subset when the filter budget is spent.
      list.append(files)
    } catch (reason) {
      if (!(reason instanceof Error) || reason.message !== filterLimitMessage) throw reason
      list.append(element('p', filterLimitMessage))
      actions.status(filterLimitMessage)
    }
    if (!list.childElementCount) {
      const empty = element('p', '此目录没有符合类型的文件。')
      empty.className = 'storage-selector-empty'
      list.append(empty)
    }
    applyEnabled()
  }
  directory.addEventListener('change', () => {
    void navigate(directory.value)
  })
  filter.addEventListener('change', () => {
    if (!actions.available()) return
    clearOverwrite()
    render()
  })
  input.addEventListener('input', clearOverwrite)
  replace.addEventListener('click', () => {
    if (!actions.available() || !pendingOverwrite) return
    submitted = pendingOverwrite
    actions.choose(JSON.stringify(pendingOverwrite))
  })
  back.addEventListener('click', () => {
    if (!actions.available()) return
    clearOverwrite()
    input.focus({ preventScroll: true })
  })
  render()

  return {
    element: root,
    input,
    dispose() { disposed = true; navigation++; browsing = false },
    enabled(value: boolean) {
      enabled = value
      applyEnabled()
    },
    rejected(reason: unknown): boolean {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (message !== '文件已存在，请确认覆盖。' || !submitted) return false
      // A Timer may have created the chosen file after this snapshot opened.
      // A fresh, explicit click still owns permission to overwrite that file.
      confirmOverwrite(submitted)
      return true
    },
    selection(): string | undefined {
      if (disposed || browsing || !actions.available()) return undefined
      try {
        const raw = input.value.replaceAll('\\', '/')
        if (!raw) throw new Error('请输入文件名。')
        if (raw.length > 4096) throw new Error('文件路径不能超过 4096 个字符。')
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^game:\/\/\.\//i.test(raw))
          throw new Error('请选择当前游戏中的文件。')
        if (raw.startsWith('/')) throw new Error('请选择当前游戏中的文件。')
        const name = getFullStoragePath(/^game:\/\/\.\//i.test(raw) ? raw : directory.value + raw)
        if (name.endsWith('/') || name.endsWith('>')) throw new Error('请选择文件，而不是目录。')
        // Keep the unextended name on the wire. The engine applies the rule
        // exactly once, including a trailing dot that suppresses the default.
        const choice: StorageSelectorChoice = {
          name,
          filterIndex: Number(filter.value),
          overwrite: false,
        }
        // This is only the presentation snapshot. The engine repeats existence,
        // ambiguity, archive and collision checks against the current storage.
        const selectedName = effectiveName(name),
          exists = listing.entries.some((entry) => folded(entry.name) === folded(selectedName))
        if (presentation.save && exists) {
          confirmOverwrite(choice)
          return undefined
        }
        clearOverwrite()
        submitted = choice
        return JSON.stringify(choice)
      } catch (reason) {
        clearOverwrite()
        actions.status(reason instanceof Error ? reason.message : String(reason))
        return undefined
      }
    },
  }
}

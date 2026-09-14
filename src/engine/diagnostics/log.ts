import type { SaveOverlay } from '../storage/save-overlay.ts'
import { normalizePath } from '../storage/resolver.ts'

export interface LogEntry {
  text: string
  time: string
  line: string
  level: 'info' | 'error'
}
interface PendingFile {
  base: Uint8Array
  parts: string[]
  size: number
}
const filename = 'krkr.console.log',
  separator = '-'.repeat(78),
  maxLine = 256 * 1024,
  maxHistory = 8 * 1024 * 1024,
  maxImportant = 4 * 1024 * 1024,
  maxFile = 16 * 1024 * 1024,
  maxPending = 32 * 1024 * 1024

/** Engine-owned history and batched UTF-16LE files; independent of DOM and VM. */
export class DebugLog {
  logToFileOnError = true
  clearLogFileOnError = false
  private history: LogEntry[] = []
  private historyBytes = 0
  private important: string[] = []
  private importantBytes = 0
  private directory = 'savedata/'
  private writing = false
  private opened = false
  private fileDisabled = false
  private files = new Map<string, PendingFile>()
  private pendingBytes = 0

  constructor(
    private readonly saves: SaveOverlay,
    private readonly now: () => number,
    private readonly emit: (entry: LogEntry) => void,
  ) {}

  begin(text: string, important = false, level: 'info' | 'error' = 'info'): LogEntry {
    if (text.length > maxLine) throw new Error('Debug message exceeds 256 Ki UTF-16 units')
    const date = new Date(this.now()),
      time = [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':'),
      line = time + ' ' + text,
      entry = { text, time, line, level },
      bytes = (line.length + 2) * 2,
      notice = time + ' ! ' + text + '\r\n'
    if (important && this.importantBytes + notice.length * 2 > maxImportant)
      throw new Error('Important Debug history exceeds 4 MiB')
    this.history.push(entry)
    this.historyBytes += bytes
    if (this.history.length >= 2148) {
      for (const old of this.history.splice(0, 100)) this.historyBytes -= (old.line.length + 2) * 2
    }
    while (this.historyBytes > maxHistory) {
      const old = this.history.shift()!
      this.historyBytes -= (old.line.length + 2) * 2
    }
    if (important) {
      this.important.push(notice)
      this.importantBytes += notice.length * 2
    }
    return entry
  }
  /** Called after synchronous script logging handlers have returned successfully. */
  finish(entry: LogEntry): void {
    this.emit(entry)
    if (this.writing) this.append([entry.line + '\r\n'])
  }
  capture(text: string, level: 'info' | 'error' = 'info'): LogEntry {
    const entry = this.begin(text, false, level)
    this.finish(entry)
    return entry
  }
  last(lines = 2148): string {
    const count = Math.min(lines >>> 0, this.history.length)
    return count
      ? this.history
          .slice(-count)
          .map((entry) => entry.line + '\r\n')
          .join('')
      : ''
  }
  start(clear = false): void {
    if (this.writing) return
    this.append(
      [this.important.join('') + '\r\n', '\r\n' + separator + '\r\n\r\n', this.last(100) + '\r\n'],
      clear,
      true,
    )
    this.writing = true
  }
  error(): void {
    if (this.logToFileOnError) this.start(this.clearLogFileOnError)
  }
  get location(): string {
    return this.directory
  }
  setLocation(value: string, options: ReadonlyMap<string, string>): void {
    if (value.length > 4096 || value.includes('>')) throw new Error('Invalid Debug log directory')
    const trimmed = value.replace(/[/\\]*$/, ''),
      path = normalizePath((trimmed ? trimmed + '/' : '') + filename)
    try {
      this.flush()
    } catch (error) {
      this.disableFileOutput(error)
    }
    this.directory = path.slice(0, -filename.length)
    this.opened = false
    this.fileDisabled = false
    const force = options.get('-forcelog')
    if (force === 'yes' || force === 'clear') {
      this.writing = false
      this.start(force === 'clear')
    }
    const error = options.get('-logerror')
    if (error === 'no' || error === 'clear') {
      this.logToFileOnError = error === 'clear'
      this.clearLogFileOnError = error === 'clear'
    }
  }
  private append(parts: string[], clear = false, forceOpen = false): void {
    if (this.fileDisabled) return
    const requested = this.directory + filename,
      path = this.saves.locate(requested) ?? requested,
      previous = this.files.get(path),
      base = clear
        ? new Uint8Array()
        : (previous?.base ?? this.saves.get(path) ?? new Uint8Array()),
      originalSize = clear ? 0 : (previous?.size ?? base.length),
      opening = forceOpen || !this.opened,
      prefix = opening
        ? [
            ...(originalSize ? [] : ['\ufeff']),
            separator + '\r\n',
            'Logging to ' +
              requested +
              ' started on ' +
              new Date(this.now()).toISOString() +
              '\r\n',
          ]
        : [],
      additions = [...prefix, ...parts],
      size = originalSize + additions.reduce((n, text) => n + text.length * 2, 0),
      total = this.pendingBytes - (previous?.size ?? 0) + size
    if (size > maxFile || total > maxPending || (!previous && this.files.size >= 32)) {
      this.disableFileOutput(
        new Error('Debug file budget exceeded (16 MiB/file, 32 MiB pending, 32 files)'),
      )
      return
    }
    const file = !clear && previous ? previous : { base, parts: [], size: base.length }
    file.parts.push(...additions)
    file.size = size
    this.files.set(path, file)
    this.pendingBytes = total
    this.opened = true
  }
  /** Native file output also stops after an I/O error until its location resets.
   * History and game saves remain usable; unmaterialized file fragments are lost. */
  get fileOutputDisabled(): boolean {
    return this.fileDisabled
  }
  disableFileOutput(error: unknown, materialized = false): void {
    if (this.fileDisabled) return
    this.fileDisabled = true
    this.files.clear()
    this.pendingBytes = 0
    this.capture(
      materialized
        ? `日志提交失败：${String(error).slice(0, 4096)}；日志仍可导出，已暂停继续写入，停止时会重试提交。`
        : `日志文件无法写入：${String(error).slice(0, 4096)}；已停止该目录的文件输出，游戏存档仍保留。`,
      'error',
    )
  }
  /** Materialize before script file access, export, lifecycle flush and commit. */
  flush(): void {
    for (const [path, file] of this.files) {
      const bytes = new Uint8Array(file.size)
      bytes.set(file.base)
      let offset = file.base.length
      for (const part of file.parts)
        for (let i = 0; i < part.length; i++) {
          const code = part.charCodeAt(i)
          bytes[offset++] = code & 255
          bytes[offset++] = code >>> 8
        }
      this.saves.writeDiagnostic(path, bytes)
      this.pendingBytes -= file.size
      this.files.delete(path)
    }
  }
}

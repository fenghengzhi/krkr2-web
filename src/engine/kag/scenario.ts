import { TvpError } from '../system/tvp-error.ts'

export class Scenario {
  readonly lines: string[]
  private labels?: Map<string, number>
  private aliases: string[] = []
  constructor(
    readonly name: string,
    source: string,
    fromCallback = false,
  ) {
    // KAG consumes UTF-16 code units, strips leading tabs, and does not add a
    // phantom blank line for the final CR/LF. NUL terminates the native stream.
    const errorName = fromCallback ? source : name
    source = source.split('\0', 1)[0]!
    if (!source.length) throw new TvpError('TVPKAGNoLine', [errorName])
    this.lines = source.split(/\r\n|\r|\n/).map((line) => line.replace(/^\t+/, ''))
    if (this.lines.at(-1) === '') this.lines.pop()
  }
  private index(): void {
    if (this.labels) return
    const labels = new Map<string, number>(), counts = new Map<string, number>()
    let previous = ''
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!
      if (line.length < 2 || line[0] !== '*') continue
      let label = line.split('|', 1)[0]!
      if (label === '*') {
        if (!previous) throw new TvpError('TVPKAGCannotOmmitFirstLabelName')
        label = previous
      }
      previous = label
      const count = (counts.get(label) ?? 0) + 1
      counts.set(label, count)
      if (count > 1) label += `:${count}`
      counts.set(label, 1)
      labels.set(label, i)
      this.aliases[i] = label
    }
    this.labels = labels
  }
  label(line: number): string {
    this.index()
    return this.aliases[line] ?? ''
  }
  find(label: string): number {
    this.index()
    const line = this.labels!.get(label)
    if (line === undefined) throw new TvpError('TVPKAGLabelNotFound', [this.name, label])
    return line
  }
}

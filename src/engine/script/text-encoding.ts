export const scriptEncodings = ['auto', 'shift_jis', 'gbk', 'big5', 'windows-1252', 'utf-8'] as const
export type ScriptEncoding = typeof scriptEncodings[number]

export function scriptEncoding(value: unknown): ScriptEncoding {
  if (value === undefined) return 'auto'
  for (const name of scriptEncodings) if (value === name) return name
  throw new Error('未知的脚本与剧情编码')
}

/** Scripts.textEncoding selects the decoder for subsequent BOM-less reads. */
export class ScriptTextEncoding {
  label = 'UTF-8'
  readonly initial: ScriptEncoding
  codec: Exclude<ScriptEncoding, 'auto'> | undefined
  constructor(initial?: ScriptEncoding) {
    this.initial = scriptEncoding(initial)
    // The player supplies the fallback before startup.tjs can set a converter.
    // The script-visible property still records assignments made by the game.
    this.codec = this.initial === 'auto' ? undefined : this.initial
  }
  set(value: string): void {
    // The reference publishes the label before validating its converter. An
    // unsupported assignment throws but keeps the previously selected decoder.
    this.label = value
    switch (value.toLowerCase()) {
      case 'utf8':
      case 'utf-8':
        this.codec = 'utf-8'
        break
      case 'gbk':
        this.codec = 'gbk'
        break
      case 'sjis':
      case 'shiftjis':
      case 'shift_jis':
      case 'shift-jis':
        this.codec = 'shift_jis'
        break
      default:
        throw new Error('Unsupported text encoding: ' + value)
    }
  }
}

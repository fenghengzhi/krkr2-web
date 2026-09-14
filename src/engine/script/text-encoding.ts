/** Scripts.textEncoding selects the decoder for subsequent BOM-less reads. */
export class ScriptTextEncoding {
  label = 'UTF-8'
  codec: 'utf-8' | 'shift_jis' | 'gbk' | undefined
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

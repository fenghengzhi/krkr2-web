import type { FontSpec, Pixels } from './graphics.ts'

export type FontCharset = number | 'unicode'
export interface FontDescriptor {
  name: string
  source: 'generic' | 'game' | 'system'
  fixedPitch?: boolean
  outline?: boolean
  charsets?: FontCharset[]
  vertical?: boolean
}
export interface FontSelectionRequest {
  id: number
  revision: number
  flags: number
  caption: string
  prompt: string
  sample: string
  font: FontSpec
  choices: FontDescriptor[]
}
export interface FontPreview extends Pixels {
  requestId: number
  face: string
}

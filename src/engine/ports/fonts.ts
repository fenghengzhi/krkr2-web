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
export function fontPreviewSize(kind: 'sample' | 'label', height: number) {
  return kind === 'label'
    ? { width: 360, height: 40 }
    : { width: 640, height: Math.max(96, Math.min(64, Math.abs(height)) * 2 + 32) }
}

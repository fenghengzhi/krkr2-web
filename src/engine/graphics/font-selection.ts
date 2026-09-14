import type { FontDescriptor, FontSelectionRequest } from '../ports/fonts.ts'
import type { FontSpec } from '../ports/graphics.ts'
import type { FontCatalog } from './font-catalog.ts'
import { validFontName } from '../../formats/font/metadata.ts'

export class FontSelection {
  private nextId = 1
  private pending?: { request: FontSelectionRequest; resolve(face: string | null): void }
  constructor(
    private readonly catalog: FontCatalog,
    private readonly changed: (request: FontSelectionRequest | null) => void,
  ) {}
  open(
    flags: number,
    caption: string,
    prompt: string,
    sample: string,
    font: FontSpec,
  ): Promise<string | null> {
    if ([caption, prompt, sample].some((text) => text.length > 8192))
      throw new Error('Font selection text exceeds budget')
    this.cancel()
    const request: FontSelectionRequest = {
      id: this.nextId++,
      revision: 0,
      flags,
      caption,
      prompt,
      sample,
      font: { ...font },
      choices: this.catalog.list(flags, font),
    }
    return new Promise((resolve) => {
      this.pending = { request, resolve }
      this.emit()
    })
  }
  refresh() {
    if (!this.pending) return
    const r = this.pending.request
    r.choices = this.catalog.list(r.flags, r.font)
    r.revision++
    this.emit()
  }
  private emit() {
    const r = this.pending?.request
    this.changed(
      r
        ? {
            ...r,
            font: { ...r.font },
            choices: r.choices.map((font) => ({ ...font, charsets: font.charsets?.slice() })),
          }
        : null,
    )
  }
  choose(id: number, face: string): boolean {
    if (!this.pending || this.pending.request.id !== id) return false
    if (!validFontName(face) || !this.pending.request.choices.some((item) => item.name === face))
      throw new Error('Font is not in the current selection')
    const pending = this.pending
    this.pending = undefined
    this.emit()
    pending.resolve(face)
    return true
  }
  preview(
    id: number,
    face: string,
  ): { font: FontSpec; sample: string; choice: FontDescriptor } | undefined {
    const r = this.pending?.request,
      choice = r?.choices.find((item) => item.name === face)
    if (!r || r.id !== id || !choice) return undefined
    return {
      font: { ...r.font, face, faceIsFileName: false, verticalFace: false, angle: 0 },
      sample: r.sample.slice(0, 256),
      choice,
    }
  }
  cancel(id?: number) {
    if (!this.pending || (id !== undefined && this.pending.request.id !== id)) return
    const pending = this.pending
    this.pending = undefined
    this.emit()
    pending.resolve(null)
  }
  get active() {
    return !!this.pending
  }
}

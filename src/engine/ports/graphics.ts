export interface Pixels {
  width: number
  height: number
  data: Uint8Array
}
export interface DecodedImage extends Pixels {
  metadata?: Map<string, string>
  /** Original palette indices, independent of palette colors/transparency. */
  indices?: Uint8Array
  /** An unpaletted grayscale source that can serve as an 8-bit province map. */
  grayscale?: boolean
}
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface FrameLayer extends Rect {
  id: number
  pixels: Pixels
  revision: number
  opacity: number
  clip: Rect
  source: Rect
  type: number
}
export interface Renderer {
  /** Registers a Window surface before its first frame, when surfaces are dynamic. */
  openWindow?(windowId: number): void
  /** Retires a Window surface and its resources. */
  closeWindow?(windowId: number): void
  /** false means the frame was not presented and must remain dirty. */
  present(layers: FrameLayer[], width: number, height: number, windowId?: number): void | boolean
  /** Delivers the current status immediately, then any changes. */
  subscribe?(listener: (status: RendererStatus) => void): () => void
  retry?(): void
  dispose(): void
}
export interface RendererStatus {
  state: 'ready' | 'lost' | 'restoring' | 'failed'
  generation: number
  message?: string
  /**
   * Initial surface attachment, before its first successful presentation and
   * without a graphics failure. Only meaningful with state='restoring'. This
   * keeps the Window dirty without pausing script execution or shared media.
   * Recovery after a loss/failure must never use this exemption.
   */
  pending?: boolean
}
export interface GraphicsDecoder {
  decode(bytes: Uint8Array): Promise<DecodedImage>
  text(
    text: string,
    size: number,
    color: number,
    font?: FontSpec,
    options?: TextOptions,
  ): TextPixels
  measure?(text: string, font: FontSpec): { width: number; height: number; ascent?: number }
  loadFont?(bytes: Uint8Array): Promise<LoadedFont>
  measureGlyph?(character: string, font: FontSpec): GlyphMetrics
  glyph?(character: string, font: FontSpec, antialiased: boolean): RasterGlyph | undefined
  dispose?(): void
}
export interface RasterGlyph {
  width: number
  height: number
  left: number
  top: number
  coverage: Uint8Array
  advance: number
}
export interface GlyphMetrics {
  left: number
  top: number
  right: number
  bottom: number
  advance: number
  rasterSamples?: number
}
export interface LoadedFont {
  face: string
  dispose(): void
}
export interface FontSpec {
  height: number
  face: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  angle: number
  faceIsFileName?: boolean
  /** Internal logical-face orientation, retained when a family becomes a backend handle. */
  verticalFace?: boolean
}
export interface TextOptions {
  antialiased: boolean
  shadowLevel: number
  shadowColor: number
  shadowWidth: number
  shadowX: number
  shadowY: number
}
export interface TextPixels extends Pixels {
  left?: number
  top?: number
}

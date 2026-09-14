import type { FrameLayer, Renderer, RendererStatus } from '../../../engine/ports/graphics.ts'
import { createProgram, type GpuProgram } from './program.ts'

export class WebGLRenderer implements Renderer {
  private readonly gl: WebGL2RenderingContext
  private program?: GpuProgram
  private status: RendererStatus = { state: 'lost', generation: 0 }
  private disposed = false
  private readonly listeners = new Set<(status: RendererStatus) => void>()
  private readonly textures = new Map<number, { texture: WebGLTexture; revision: number }>()
  private readonly lost = (event: Event) => {
    if (this.disposed) return
    event.preventDefault()
    this.markLost()
  }
  private readonly restored = () => {
    if (!this.disposed) this.rebuild()
  }
  constructor(private readonly canvas: OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })
    if (!gl) throw new Error('WebGL2 in OffscreenCanvas is required')
    this.gl = gl
    canvas.addEventListener('webglcontextlost', this.lost)
    canvas.addEventListener('webglcontextrestored', this.restored)
    this.rebuild()
  }
  subscribe(listener: (status: RendererStatus) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    listener({ ...this.status })
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(state: RendererStatus['state'], message?: string): void {
    if (state === this.status.state && message === this.status.message && state !== 'ready') return
    this.status = {
      state,
      generation: this.status.generation + (state === 'ready' ? 1 : 0),
      ...(message ? { message } : {}),
    }
    for (const listener of this.listeners) listener({ ...this.status })
  }
  private markLost(): void {
    // Browser-invalidated handles and uniform locations can never be reused.
    this.textures.clear()
    this.program = undefined
    this.publish('lost')
  }
  private release(): void {
    if (!this.gl.isContextLost()) {
      for (const cached of this.textures.values()) this.gl.deleteTexture(cached.texture)
      if (this.program) this.gl.deleteProgram(this.program.handle)
    }
    this.textures.clear()
    this.program = undefined
  }
  private failed(error: unknown): void {
    if (this.gl.isContextLost()) this.markLost()
    else {
      this.release()
      this.publish('failed', error instanceof Error ? error.message : String(error))
    }
  }
  private rebuild(): void {
    const gl = this.gl
    if (gl.isContextLost()) {
      this.markLost()
      return
    }
    this.release()
    try {
      // A failed allocation may have left an error flag. Retry checks only work
      // belonging to the rebuilt resources, not the previous failed attempt.
      for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) {}
      this.program = createProgram(gl)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindVertexArray(null)
      gl.activeTexture(gl.TEXTURE0)
      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.disable(gl.STENCIL_TEST)
      gl.enable(gl.BLEND)
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.colorMask(true, true, true, true)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      this.checkError()
      this.publish('restoring')
    } catch (error) {
      this.failed(error)
    }
  }
  retry(): void {
    if (!this.disposed && this.status.state !== 'ready') this.rebuild()
  }
  private checkError(): void {
    const error = this.gl.getError()
    if (error !== this.gl.NO_ERROR)
      throw new Error(`WebGL operation failed (0x${error.toString(16)})`)
    if (this.gl.isContextLost()) throw new Error('WebGL context was lost during rendering')
  }
  present(layers: FrameLayer[], width: number, height: number): boolean {
    if (this.disposed) return false
    if (this.gl.isContextLost()) {
      this.markLost()
      return false
    }
    if (!['ready', 'restoring'].includes(this.status.state) || !this.program) return false
    try {
      this.draw(layers, width, height)
      this.checkError()
      if (this.status.state === 'restoring') this.publish('ready')
      return true
    } catch (error) {
      this.failed(error)
      return false
    }
  }
  private draw(layers: FrameLayer[], width: number, height: number): void {
    const gl = this.gl,
      program = this.program!
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0.03, 0.04, 0.06, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program.handle)
    gl.uniform2f(program.resolution, width, height)
    const live = new Set(layers.map((layer) => layer.id))
    for (const [id, cached] of this.textures)
      if (!live.has(id)) {
        gl.deleteTexture(cached.texture)
        this.textures.delete(id)
      }
    gl.enable(gl.SCISSOR_TEST)
    for (const layer of layers) {
      let cached = this.textures.get(layer.id)
      if (!cached) {
        const texture = gl.createTexture()
        if (!texture) throw new Error('Could not allocate a WebGL texture')
        cached = { texture, revision: -1 }
        this.textures.set(layer.id, cached)
      }
      gl.bindTexture(gl.TEXTURE_2D, cached.texture)
      if (cached.revision !== layer.revision) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          layer.pixels.width,
          layer.pixels.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          layer.pixels.data,
        )
        cached.revision = layer.revision
      }
      gl.scissor(
        Math.floor(layer.clip.x),
        Math.floor(height - layer.clip.y - layer.clip.height),
        Math.ceil(layer.clip.x + layer.clip.width) - Math.floor(layer.clip.x),
        Math.ceil(layer.clip.y + layer.clip.height) - Math.floor(layer.clip.y),
      )
      gl.uniform4f(program.rectangle, layer.x, layer.y, layer.width, layer.height)
      gl.uniform1f(program.opacity, layer.opacity)
      gl.uniform4f(
        program.sourceUV,
        layer.source.x / layer.pixels.width,
        layer.source.y / layer.pixels.height,
        layer.source.width / layer.pixels.width,
        layer.source.height / layer.pixels.height,
      )
      gl.uniform1i(program.layerType, layer.type)
      gl.blendFuncSeparate(
        layer.type === 12 ? gl.ONE : gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      )
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.disable(gl.SCISSOR_TEST)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    this.canvas.removeEventListener('webglcontextrestored', this.restored)
    this.listeners.clear()
    this.release()
    if (!this.gl.isContextLost()) this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

export interface GpuProgram {
  handle: WebGLProgram
  resolution: WebGLUniformLocation
  rectangle: WebGLUniformLocation
  sourceUV: WebGLUniformLocation
  opacity: WebGLUniformLocation
  layerType: WebGLUniformLocation
}

/** All locations belong to this program and must be rebuilt after context restoration. */
export function createProgram(gl: WebGL2RenderingContext): GpuProgram {
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Could not allocate a WebGL shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(`Shader compilation failed: ${gl.getShaderInfoLog(shader)}`)
      return shader
    }
    const vertex = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
      uniform vec4 rectangle; uniform vec4 sourceUV; uniform vec2 resolution; out vec2 uv;
      void main() { vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
        uv = sourceUV.xy + corner * sourceUV.zw;
        vec2 p = rectangle.xy + corner * rectangle.zw;
        gl_Position = vec4(p / resolution * vec2(2., -2.) + vec2(-1., 1.), 0., 1.); }`,
    )
    const fragment = compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float; uniform sampler2D image; uniform float opacity; uniform int layerType; in vec2 uv; out vec4 color;
      void main() { color = texture(image, uv); if(layerType==1) color.a=1.; if(layerType==12)color.rgb*=opacity; color.a *= opacity; }`,
    )
    program = gl.createProgram()
    if (!program) throw new Error('Could not allocate a WebGL program')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`)
    const uniform = (name: string) => {
      const location = gl.getUniformLocation(program!, name)
      if (location === null) throw new Error(`WebGL uniform unavailable: ${name}`)
      return location
    }
    const result = {
      handle: program,
      resolution: uniform('resolution'),
      rectangle: uniform('rectangle'),
      sourceUV: uniform('sourceUV'),
      opacity: uniform('opacity'),
      layerType: uniform('layerType'),
    }
    gl.useProgram(program)
    gl.uniform1i(uniform('image'), 0)
    return result
  } catch (error) {
    if (program) gl.deleteProgram(program)
    throw error
  } finally {
    for (const shader of shaders) gl.deleteShader(shader)
  }
}

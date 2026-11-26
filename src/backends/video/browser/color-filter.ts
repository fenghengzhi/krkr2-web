import { videoColorMatrix, type VideoColorValues } from '../../../engine/media/video-color.ts'

const svg = 'http://www.w3.org/2000/svg'
let sequence = 0
export interface MovieColorFilter {
  definition: SVGSVGElement
  operation: SVGFEColorMatrixElement
  matrix: number[]
}

/** The definition belongs to the same graph as the video. Removing the
 * container also releases the definition on close, discard or track switch. */
export function setMovieColorFilter(video: HTMLVideoElement, container: HTMLElement, colors: VideoColorValues,
  previous?: MovieColorFilter): MovieColorFilter | undefined {
  const matrix = videoColorMatrix(colors)
  if (!matrix) {
    if (previous) { video.style.filter = ''; previous.definition.remove() }
    return
  }
  if (previous) {
    previous.operation.setAttribute('values', matrix.join(' '))
    return { ...previous, matrix }
  }
  const definition = document.createElementNS(svg, 'svg'), filter = document.createElementNS(svg, 'filter'),
    operation = document.createElementNS(svg, 'feColorMatrix')
  do { filter.id = 'krkr-movie-color-' + ++sequence } while (document.getElementById(filter.id))
  definition.setAttribute('aria-hidden', 'true')
  definition.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none'
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  filter.setAttribute('x', '0%'); filter.setAttribute('y', '0%')
  filter.setAttribute('width', '100%'); filter.setAttribute('height', '100%')
  operation.setAttribute('type', 'matrix')
  operation.setAttribute('values', matrix.join(' '))
  filter.append(operation); definition.append(filter); container.append(definition)
  video.style.filter = 'url("#' + filter.id + '")'
  return { definition, operation, matrix }
}

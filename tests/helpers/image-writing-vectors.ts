import { tlgCases } from './tlg-vectors.ts'
export const writingTags = new Map([
  ['mode', 'addalpha'],
  ['offs_x', '12'],
  ['offs_y', '-7'],
  ['offs_unit', 'pixel'],
  ['题😀', 'あ,=:文😀'],
])
export function* writingCases() {
  for (const image of tlgCases())
    if (
      image.version === 5 &&
      image.colors === 4 &&
      image.filter < 0 &&
      [1, 7, 9, 17, 67, 129].includes(image.width)
    )
      for (const type of ['png', 'png24', 'tlg5', 'tlg524', 'tlg6', 'tlg624'])
        yield { id: `${image.id}-${type}`, image, type }
}

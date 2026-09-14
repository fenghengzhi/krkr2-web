const sinc = (x: number) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
export function filter(
  type: number,
  coefficient: number,
): { radius: number; weight: (x: number) => number } {
  if ([1, 2, 4].includes(type)) return { radius: 1, weight: (x) => Math.max(0, 1 - Math.abs(x)) }
  if (type === 3 || type === 5)
    return {
      radius: 2,
      weight: (value) => {
        const x = Math.abs(value),
          a = coefficient
        return x <= 1
          ? 1 - (a + 3) * x * x + (a + 2) * x * x * x
          : x < 2
            ? a * (x * x * x - 5 * x * x + 8 * x - 4)
            : 0
      },
    }
  if ([6, 7, 8, 9].includes(type)) {
    const radius = type < 8 ? 2 : 3
    return { radius, weight: (x) => (Math.abs(x) >= radius ? 0 : sinc(x) * sinc(x / radius)) }
  }
  if (type === 10 || type === 11)
    return {
      radius: 2,
      weight: (value) => {
        const x = Math.abs(value)
        return x <= 1
          ? x * x * x - (9 * x * x) / 5 - x / 5 + 1
          : x <= 2
            ? (-x * x * x) / 3 + (9 * x * x) / 5 - (46 * x) / 15 + 8 / 5
            : 0
      },
    }
  if (type === 12 || type === 13)
    return {
      radius: 3,
      weight: (value) => {
        const x = Math.abs(value)
        return x <= 1
          ? (13 * x * x * x) / 11 - (453 * x * x) / 209 - (3 * x) / 209 + 1
          : x <= 2
            ? (-6 * x * x * x) / 11 + (612 * x * x) / 209 - (1038 * x) / 209 + 540 / 209
            : x <= 3
              ? (x * x * x) / 11 - (159 * x * x) / 209 + (434 * x) / 209 - 384 / 209
              : 0
      },
    }
  if (type === 16 || type === 17)
    return { radius: 2, weight: (x) => Math.exp(-2 * x * x) * Math.sqrt(2 / Math.PI) }
  if (type === 18 || type === 19)
    return {
      radius: 4,
      weight: (x) =>
        sinc(x) * (0.42 + 0.5 * Math.cos((Math.PI * x) / 4) + 0.08 * Math.cos((Math.PI * x) / 2)),
    }
  throw new Error(`Unknown stretch filter: ${type}`)
}

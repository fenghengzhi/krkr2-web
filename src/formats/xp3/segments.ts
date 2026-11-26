import type { DeflateRange } from '../binary/deflate-ranges.ts'

export { DeflateRangePool as Xp3SegmentPool } from '../binary/deflate-ranges.ts'

export interface Xp3Segment extends DeflateRange {
  offset: number
  compressed: boolean
  logical: number
}

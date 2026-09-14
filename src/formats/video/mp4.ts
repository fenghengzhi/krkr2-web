import type { VideoTimeline } from '../../engine/ports/video.ts'
const MAX_SAMPLES = 1000000
/** MP4Box supplies DTS/CTS and fragmented sample tables; this adapter applies
 * edit lists and exposes presentation order instead of decoding order. */
export async function readVideoTimeline(bytes: Uint8Array): Promise<VideoTimeline | undefined> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 8 || !['ftyp', 'moov', 'free', 'wide', 'mdat'].includes(text(4))) return
  let boxes = 0,
    totalSamples = 0
  const inspect = (start: number, end: number, depth = 0) => {
    if (depth > 16) throw new Error('MP4 nesting limit exceeded')
    for (let at = start; at < end;) {
      if (++boxes > 100000 || at + 8 > end) throw new Error('Invalid MP4 box structure')
      let size = view.getUint32(at),
        header = 8
      const kind = text(at + 4)
      if (size === 1) {
        if (at + 16 > end) throw new Error('Truncated extended MP4 box')
        const value = view.getBigUint64(at + 8)
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 box size is too large')
        size = Number(value)
        header = 16
      }
      if (size === 0) size = end - at
      if (size < header || at + size > end) throw new Error('Truncated MP4 box')
      const body = at + header,
        limit = at + size
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'moof', 'traf', 'mvex'].includes(kind))
        inspect(body, limit, depth + 1)
      if (['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'trun'].includes(kind)) {
        if (body + 8 > limit || view.getUint32(body + 4) > MAX_SAMPLES)
          throw new Error('MP4 sample table budget exceeded')
        if (kind === 'stts' || kind === 'ctts') {
          const count = view.getUint32(body + 4)
          if (body + 8 + count * 8 > limit) throw new Error('Truncated MP4 timing table')
          let samples = 0
          for (let i = 0; i < count; i++) samples += view.getUint32(body + 8 + i * 8)
          if (samples > MAX_SAMPLES) throw new Error('MP4 sample count budget exceeded')
          if (kind === 'stts') totalSamples += samples
        }
        if (kind === 'trun') totalSamples += view.getUint32(body + 4)
        if (totalSamples > MAX_SAMPLES * 2) throw new Error('MP4 aggregate sample budget exceeded')
      }
      if (kind === 'elst' && (body + 8 > limit || view.getUint32(body + 4) > 4096))
        throw new Error('MP4 edit list budget exceeded')
      if (kind === 'stsz' && (body + 12 > limit || view.getUint32(body + 8) > MAX_SAMPLES))
        throw new Error('MP4 sample count budget exceeded')
      at = limit
    }
  }
  inspect(0, bytes.length)
  const { createFile, MP4BoxBuffer } = await import('mp4box')
  const file = createFile(false)
  file.onError = (message) => {
    throw new Error(`MP4 metadata: ${message}`)
  }
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(Uint8Array.from(bytes).buffer, 0))
  file.flush()
  const info = file.getInfo(),
    track = info.videoTracks[0]
  if (!track) return
  const samples = file.getTrackSamplesInfo(track.id)
  if (samples.length > MAX_SAMPLES || !track.timescale)
    throw new Error('Invalid MP4 video sample table')
  const raw = samples
    .map((sample) => ({
      time: (sample.cts * 1000) / track.timescale,
      end: ((sample.cts + sample.duration) * 1000) / track.timescale,
    }))
    .sort((a, b) => a.time - b.time)
  const times: number[] = []
  let duration = 0
  if (track.edits?.length) {
    for (const edit of track.edits) {
      if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0)
        throw new Error('MP4 edit playback rates are not supported')
      const length = (edit.segment_duration * 1000) / info.timescale,
        start = (edit.media_time * 1000) / track.timescale
      if (start >= 0)
        for (const sample of raw)
          if (sample.end > start && sample.time < start + length)
            times.push(duration + Math.max(0, sample.time - start))
      duration += length
    }
  } else {
    for (const sample of raw) {
      times.push(Math.max(0, sample.time))
      duration = Math.max(duration, sample.end)
    }
  }
  if (times.some((time) => !Number.isFinite(time)) || !Number.isFinite(duration) || duration < 0)
    throw new Error('Invalid MP4 presentation time')
  if (times.length > MAX_SAMPLES) throw new Error('MP4 edited frame count budget exceeded')
  return {
    times,
    duration,
    audioStreams: info.audioTracks.length,
    videoStreams: info.videoTracks.length,
  }
}

import type { VideoTimeline, VideoTrackTimeline } from '../../engine/ports/video.ts'
import { readAvcFrameDuration } from './avc-timing.ts'
const MAX_SAMPLES = 1000000
/** Retain the original catalog while projecting one selected video timeline. */
export function selectVideoTimeline(original: VideoTimeline, index: number): VideoTimeline {
  if (!Number.isSafeInteger(index) || index < 0 || index >= original.videoStreams)
    throw new Error('Video stream index is outside the original track range')
  const catalog = original.videoTracks
  if (!catalog) {
    if (index === 0 && original.videoStreams === 1) return { ...original, selectedVideoStream: 0 }
    throw new Error('Video stream catalog is unavailable')
  }
  const selected = catalog[index]
  if (!Array.isArray(catalog) || catalog.length !== original.videoStreams || !selected)
    throw new Error('Video stream catalog disagrees with the original track count')
  if (catalog.length > 256) throw new Error('Video stream catalog track budget exceeded')
  let frames = 0
  const ids = new Set<number>()
  for (const track of catalog) {
    if (!track || !Number.isSafeInteger(track.id) || track.id <= 0 || ids.has(track.id) ||
        !Number.isInteger(track.width) || !Number.isInteger(track.height) ||
        track.width <= 0 || track.height <= 0 || track.width > 4096 || track.height > 4096 ||
        !Array.isArray(track.times) || !Number.isFinite(track.duration) || track.duration < 0 ||
        !Number.isFinite(track.frameDuration) || track.frameDuration < 0 || (track.times.length && !track.frameDuration))
      throw new Error('Invalid video stream catalog metadata')
    ids.add(track.id)
    if (track.times.length > MAX_SAMPLES || (frames += track.times.length) > MAX_SAMPLES * 2)
      throw new Error('Video stream catalog frame budget exceeded')
  }
  for (const track of catalog) {
    let previous = -1
    for (const time of track.times) {
      if (!Number.isFinite(time) || time < 0 || time < previous || time > track.duration)
        throw new Error('Invalid video stream catalog presentation time')
      previous = time
    }
  }
  return { ...original, times: selected.times, duration: selected.duration,
    frameDuration: selected.frameDuration, selectedVideoStream: index }
}
/** MP4Box supplies DTS/CTS and fragmented sample tables; this adapter applies
 * edit lists and exposes presentation order instead of decoding order. */
export async function readVideoTimeline(input: Uint8Array): Promise<VideoTimeline | undefined> {
  if (input.length < 8 || !['ftyp', 'moov', 'free', 'wide', 'mdat'].includes(
    String.fromCharCode(...input.subarray(4, 8)))) return
  // Own the complete source before the parser import can suspend. All video
  // catalogs refer to this same immutable observation, not a later caller view.
  const bytes = Uint8Array.from(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
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
  const { createFile } = await import('mp4box')
  const file = createFile(false)
  file.onError = (message) => {
    throw new Error(`MP4 metadata: ${message}`)
  }
  file.appendBuffer(Object.assign(bytes.buffer, { fileStart: 0, usedBytes: 0 }))
  file.flush()
  const info = file.getInfo(), catalog: VideoTrackTimeline[] = [], ids = new Set<number>()
  if (!info.videoTracks.length) return
  if (info.videoTracks.length > 256) throw new Error('MP4 video track budget exceeded')
  let videoSamples = 0, editedSamples = 0, editWork = 0
  const avcBudget = { remaining: 1024 * 1024 }, descriptionDurations = new Map<unknown, number | undefined>()
  for (const track of info.videoTracks) {
    const samples = file.getTrackSamplesInfo(track.id),
      width = track.video?.width ?? track.track_width, height = track.video?.height ?? track.track_height
    if (!Number.isSafeInteger(track.id) || track.id <= 0 || ids.has(track.id) ||
        !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096)
      throw new Error('Invalid MP4 video track identity or dimensions')
    ids.add(track.id)
    if (samples.length > MAX_SAMPLES || (videoSamples += samples.length) > MAX_SAMPLES * 2 ||
        !Number.isSafeInteger(track.timescale) || track.timescale <= 0)
      throw new Error('Invalid MP4 video sample table')
    // Container timing may stretch the initial sample to account for mux/audio
    // priming. Codec nominal timing is separate from those real CTS intervals.
    // Use it only when every used description has one consistent AVC cadence;
    // other codecs/configuration changes retain the container-derived estimate.
    let sampleDuration = 0
    const descriptions = new Set<unknown>()
    for (const sample of samples) {
      if (!Number.isSafeInteger(sample.duration) || sample.duration < 0 || !Number.isSafeInteger(sample.cts))
        throw new Error('Invalid MP4 video sample duration or timestamp')
      sampleDuration += sample.duration
      descriptions.add(sample.description)
      if (descriptions.size > 256) throw new Error('MP4 sample description budget exceeded')
    }
    if (!Number.isSafeInteger(sampleDuration) || (samples.length && sampleDuration <= 0))
      throw new Error('Invalid MP4 video sample duration')
    let codecDuration: number | undefined, codecAvailable = descriptions.size > 0
    for (const description of descriptions) {
      if (!descriptionDurations.has(description))
        descriptionDurations.set(description, readAvcFrameDuration(description, avcBudget))
      const value = descriptionDurations.get(description)
      if (value === undefined || (codecDuration !== undefined && value !== codecDuration)) codecAvailable = false
      codecDuration ??= value
    }
    const frameDuration = codecAvailable ? codecDuration! : samples.length ? (sampleDuration * 1000) / track.timescale / samples.length : 0
    const raw = samples
      .map((sample) => ({ time: (sample.cts * 1000) / track.timescale,
        end: ((sample.cts + sample.duration) * 1000) / track.timescale }))
      .sort((a, b) => a.time - b.time)
    const times: number[] = []
    const append = (time: number) => {
      if (times.length >= MAX_SAMPLES || ++editedSamples > MAX_SAMPLES * 2)
        throw new Error('MP4 edited frame count budget exceeded')
      times.push(time)
    }
    let duration = 0
    if (track.edits?.length) {
      for (const edit of track.edits) {
        if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0)
          throw new Error('MP4 edit playback rates are not supported')
        const length = (edit.segment_duration * 1000) / info.timescale,
          start = (edit.media_time * 1000) / track.timescale
        if (start >= 0)
          for (const sample of raw) {
            if (++editWork > MAX_SAMPLES * 8) throw new Error('MP4 edit evaluation budget exceeded')
            if (sample.end > start && sample.time < start + length)
              append(duration + Math.max(0, sample.time - start))
          }
        duration += length
      }
    } else {
      for (const sample of raw) {
        append(Math.max(0, sample.time))
        duration = Math.max(duration, sample.end)
      }
    }
    if (times.some((time) => !Number.isFinite(time)) || !Number.isFinite(duration) || duration < 0)
      throw new Error('Invalid MP4 presentation time')
    catalog.push({ id: track.id, width, height, times, duration, frameDuration })
  }
  const first = catalog[0]!
  return {
    times: first.times,
    duration: first.duration,
    frameDuration: first.frameDuration,
    audioStreams: info.audioTracks.length,
    videoStreams: catalog.length,
    selectedVideoStream: 0,
    videoTracks: catalog,
  }
}

export interface SelectedMp4Audio {
  bytes: Uint8Array
  /** Original file counts; the returned file contains only the selected audio. */
  audioStreams: number
  videoStreams: number
  selectedTrackId: number
}
export interface Mp4AudioSelectionOptions {
  checkpoint?(): void | Promise<void>
  /** Host-injected task yield; this format module has no DOM/timer dependency. */
  yieldControl?(): void | Promise<void>
}
interface Box { kind: string; start: number; body: number; end: number }
interface Track { id: number; handler: string; box: Box; header: Box; alternate: number; descriptions: number; samples: number; regularSamples: number }
interface FragmentTrack { box: Box; id: number; runs: number[]; ordinal: number; firstTime?: number }
const MAX_BOXES = 100000, MAX_SAMPLES = 1000000, MAX_BYTES = 64 * 1024 * 1024
const padding = ['free', 'skip', 'wide']

/** Select a self-contained MP4 audio track without relocating any media bytes.
 * Field layouts: gpac/mp4box.js v2.4.1 src/boxes/{tkhd,tfhd,trun,trex,tfra,sidx}.ts.
 * Fragment addressing follows W3C's ISO BMFF byte-stream format section 4;
 * inherited bases across removed traf boxes are deliberately unsupported.
 */
export async function selectMp4AudioTrack(input: Uint8Array, index: number,
  options: Mp4AudioSelectionOptions = {}): Promise<SelectedMp4Audio | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('MP4 audio index must be a non-negative safe integer')
  const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (input.length < 8 || !['ftyp', 'moov', 'mdat', 'styp', 'moof', 'mfra', 'sidx', 'pdin', 'pssh', 'uuid', ...padding].includes(tag(input, 4))) return
  if (input.length > MAX_BYTES) throw new Error('MP4 audio selection exceeds the 64 MiB input budget')
  // Snapshot before the dynamic parser import can yield to the caller.
  const bytes = Uint8Array.from(input), view = new DataView(bytes.buffer)
  const cooperate = async () => {
    await options.checkpoint?.()
    await options.yieldControl?.()
    await options.checkpoint?.()
  }
  let boxCount = 0, tableSamples = 0
  const need = (box: Box, at: number, length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || at < box.body || at > box.end || length > box.end - at)
      throw new Error(`Truncated MP4 ${box.kind} box`)
  }
  const exact = (box: Box, at: number) => {
    if (at !== box.end) throw new Error(`Invalid MP4 ${box.kind} box length`)
  }
  const list = (start: number, end: number): Box[] => {
    const result: Box[] = []
    for (let at = start; at < end;) {
      if (++boxCount > MAX_BOXES) throw new Error('MP4 box budget exceeded')
      if (end - at < 8) throw new Error('Truncated MP4 box header')
      let size = view.getUint32(at), header = 8
      if (size === 1) {
        if (end - at < 16) throw new Error('Truncated extended MP4 box')
        const extended = view.getBigUint64(at + 8)
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 box size exceeds safe integer range')
        size = Number(extended); header = 16
      } else if (size === 0) size = end - at
      if (size < header || size > end - at) throw new Error('Truncated MP4 box extent')
      result.push({ kind: tag(bytes, at + 4), start: at, body: at + header, end: at + size })
      at += size
    }
    return result
  }
  const children = (box: Box, allowed: string[]) => {
    const items = list(box.body, box.end)
    for (const item of items)
      if (![...allowed, ...padding].includes(item.kind))
        throw new Error(`Unsupported MP4 ${item.kind} box in ${box.kind}`)
    return items
  }
  const one = (items: Box[], kind: string, required = true): Box | undefined => {
    const found = items.filter((item) => item.kind === kind)
    if (found.length > 1 || (required && found.length !== 1)) throw new Error(`Invalid MP4 ${kind} box count`)
    return found[0]
  }
  const full = (box: Box, versions = [0], mask = 0) => {
    need(box, box.body, 4)
    const version = bytes[box.body]!, flags = view.getUint32(box.body) & 0xffffff
    if (!versions.includes(version) || (flags & ~mask)) throw new Error(`Unsupported MP4 ${box.kind} version or flags`)
    return { version, flags }
  }
  const count = (box: Box, at: number, width: number, limit = MAX_SAMPLES) => {
    need(box, at, 4)
    const entries = view.getUint32(at)
    if (entries > limit) throw new Error(`MP4 ${box.kind} entry budget exceeded`)
    need(box, at + 4, entries * width)
    exact(box, at + 4 + entries * width)
    return entries
  }
  const u64 = (box: Box, at: number) => {
    need(box, at, 8)
    const value = view.getBigUint64(at)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MP4 ${box.kind} offset exceeds safe integer range`)
    return Number(value)
  }
  const metadata = (box: Box) => {
    for (const meta of children(box, ['meta'])) {
      if (padding.includes(meta.kind)) continue
      full(meta)
      for (const item of list(meta.body + 4, meta.end)) {
        if (padding.includes(item.kind)) continue
        if (item.kind === 'hdlr') { full(item); need(item, item.body, 24); continue }
        if (item.kind !== 'ilst') throw new Error(`Unsupported MP4 metadata box ${item.kind}`)
        for (const tag of list(item.body, item.end)) for (const field of children(tag, ['data', 'mean', 'name'])) {
          if (padding.includes(field.kind)) continue
          full(field, [0], field.kind === 'data' ? 0xffffff : 0)
          need(field, field.body, field.kind === 'data' ? 8 : 4)
        }
      }
    }
  }
  const free: Box[] = [], writes: Array<{ at: number; value: number; width: number }> = []
  await cooperate()
  const top = list(0, bytes.length)
  const topStarts = new Set(top.map((box) => box.start)), topEnds = new Set(top.map((box) => box.end))
  const media = top.filter((box) => box.kind === 'mdat')
  const validateSample = (offset: number, size: number, dts: number, cts: number, duration: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 0 ||
        !Number.isSafeInteger(cts) || !Number.isSafeInteger(dts) || !Number.isSafeInteger(duration) || duration < 0 ||
        !Number.isSafeInteger(dts + duration) || !Number.isSafeInteger(cts + duration))
      throw new Error('Invalid MP4 sample extent or timestamp')
    let low = 0, high = media.length
    while (low < high) { const mid = (low + high) >>> 1; if (media[mid]!.body <= offset) low = mid + 1; else high = mid }
    const data = media[low - 1]
    if (!data || offset > data.end || size > data.end - offset) throw new Error('MP4 sample is outside media data')
  }
  for (const box of top)
    if (!['ftyp', 'styp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', ...padding].includes(box.kind))
      throw new Error(`Unsupported MP4 top-level ${box.kind} box`)
  const ftyp = one(top, 'ftyp')!, moov = one(top, 'moov')!
  for (const box of top.filter((item) => item.kind === 'ftyp' || item.kind === 'styp')) {
    need(box, box.body, 8)
    if ((box.end - box.body) % 4) throw new Error('Invalid MP4 brand table')
    if (box.end - box.body > 8 + 256 * 4) throw new Error('MP4 compatible brand budget exceeded')
  }
  const brands = [tag(bytes, ftyp.body)]
  for (let at = ftyp.body + 8; at < ftyp.end; at += 4) brands.push(tag(bytes, at))
  if (!brands.some((brand) => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'dash', 'cmfc'].includes(brand)))
    throw new Error('Unsupported MP4 file brand')
  const movie = children(moov, ['mvhd', 'trak', 'mvex', 'udta'])
  for (const box of movie.filter((item) => item.kind === 'udta')) metadata(box)
  const mvhd = one(movie, 'mvhd')!, mvhdVersion = full(mvhd, [0, 1]).version
  need(mvhd, mvhd.body, mvhdVersion ? 112 : 100)
  exact(mvhd, mvhd.body + (mvhdVersion ? 112 : 100))
  if (!view.getUint32(mvhd.body + (mvhdVersion ? 20 : 12))) throw new Error('MP4 movie timescale must be positive')
  const tracks: Track[] = [], ids = new Set<number>()
  for (const box of movie.filter((item) => item.kind === 'trak')) {
    await cooperate()
    if (tracks.length >= 256) throw new Error('MP4 track budget exceeded')
    const track = children(box, ['tkhd', 'mdia', 'edts', 'udta']), header = one(track, 'tkhd')!, version = full(header, [0, 1], 0xf).version
    for (const box of track.filter((item) => item.kind === 'udta')) metadata(box)
    need(header, header.body, version ? 96 : 84)
    exact(header, header.body + (version ? 96 : 84))
    const id = view.getUint32(header.body + (version ? 20 : 12))
    if (!id || ids.has(id)) throw new Error('MP4 track IDs must be nonzero and unique')
    ids.add(id)
    const mdia = children(one(track, 'mdia')!, ['mdhd', 'hdlr', 'minf'])
    const mdhd = one(mdia, 'mdhd')!, mediaVersion = full(mdhd, [0, 1]).version
    need(mdhd, mdhd.body, mediaVersion ? 36 : 24)
    exact(mdhd, mdhd.body + (mediaVersion ? 36 : 24))
    if (!view.getUint32(mdhd.body + (mediaVersion ? 20 : 12))) throw new Error('MP4 media timescale must be positive')
    const hdlr = one(mdia, 'hdlr')!
    full(hdlr); need(hdlr, hdlr.body, 24)
    const handler = tag(bytes, hdlr.body + 8)
    if (handler !== 'soun' && handler !== 'vide') throw new Error(`Unsupported MP4 track handler ${handler}`)
    const edit = one(track, 'edts', false)
    if (edit) {
      const elst = one(children(edit, ['elst']), 'elst')!, editVersion = full(elst, [0, 1]).version
      count(elst, elst.body + 4, editVersion ? 20 : 12, 4096)
    }
    const minf = children(one(mdia, 'minf')!, ['smhd', 'vmhd', 'nmhd', 'dinf', 'stbl'])
    for (const header of minf.filter((item) => ['smhd', 'vmhd', 'nmhd'].includes(item.kind))) {
      full(header, [0], header.kind === 'vmhd' ? 1 : 0)
      exact(header, header.body + (header.kind === 'vmhd' ? 12 : header.kind === 'smhd' ? 8 : 4))
    }
    one(minf, handler === 'soun' ? 'smhd' : 'vmhd')
    const data = children(one(minf, 'dinf')!, ['dref']), dref = one(data, 'dref')!
    full(dref); need(dref, dref.body, 8)
    const refs = list(dref.body + 8, dref.end)
    if (!refs.length || refs.length > 256 || view.getUint32(dref.body + 4) !== refs.length) throw new Error('Invalid MP4 data reference count')
    for (const ref of refs) {
      if (ref.kind !== 'url ' || full(ref, [0], 1).flags !== 1 || ref.end !== ref.body + 4)
        throw new Error('External MP4 data references are unsupported')
    }
    const tables = children(one(minf, 'stbl')!, ['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'stss', 'sdtp', 'sgpd', 'sbgp', 'cslg'])
    const stsd = one(tables, 'stsd')!
    full(stsd); need(stsd, stsd.body, 8)
    const entries = list(stsd.body + 8, stsd.end)
    if (!entries.length || entries.length > 256 || entries.length !== view.getUint32(stsd.body + 4)) throw new Error('Invalid MP4 sample description count')
    for (const entry of entries) {
      const audio = handler === 'soun', supported = audio ? ['mp4a', 'Opus', 'fLaC', 'ac-3', 'ec-3', 'alac'] : ['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'av01', 'vp08', 'vp09']
      if (!supported.includes(entry.kind)) throw new Error(`Unsupported or encrypted MP4 sample entry ${entry.kind}`)
      need(entry, entry.body, audio ? 28 : 78)
      const reference = view.getUint16(entry.body + 6)
      if (!reference || reference > refs.length) throw new Error('Invalid MP4 sample data reference')
      if (audio && view.getUint16(entry.body + 8)) throw new Error('Unsupported MP4 audio sample entry version')
      for (const child of list(entry.body + (audio ? 28 : 78), entry.end))
        if (!['esds', 'dOps', 'dfLa', 'dac3', 'dec3', 'alac', 'avcC', 'hvcC', 'av1C', 'vpcC', 'btrt', 'pasp', 'colr', 'clap', 'fiel', 'mdcv', 'clli', ...padding].includes(child.kind))
          throw new Error(`Unsupported or encrypted MP4 sample property ${child.kind}`)
    }
    one(tables, 'stts'); one(tables, 'stsc')
    if (tables.filter((item) => ['stsz', 'stz2'].includes(item.kind)).length !== 1 ||
        tables.filter((item) => ['stco', 'co64'].includes(item.kind)).length !== 1)
      throw new Error('Invalid MP4 sample size or chunk offset table count')
    for (const kind of new Set(tables.map((item) => item.kind))) if (!padding.includes(kind)) one(tables, kind)
    let timingSamples = 0, sizeSamples = 0, compositionSamples: number | undefined, chunks = 0
    for (const table of tables) {
      if (table.kind === 'stsd' || padding.includes(table.kind)) continue
      const version = full(table, ['ctts', 'sgpd', 'sbgp', 'cslg'].includes(table.kind) ? [0, 1, ...(table.kind === 'sgpd' ? [2] : [])] : [0]).version
      if (['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss'].includes(table.kind)) {
        const width = table.kind === 'stsc' ? 12 : ['stts', 'ctts', 'co64'].includes(table.kind) ? 8 : 4
        const entries = count(table, table.body + 4, width)
        if (table.kind === 'stts' || table.kind === 'ctts') {
          let samples = 0
          for (let i = 0; i < entries; i++) {
            if (!(i % 4096)) await cooperate()
            samples += view.getUint32(table.body + 8 + i * 8)
          }
          if (samples > MAX_SAMPLES) throw new Error('MP4 timing sample budget exceeded')
          if (table.kind === 'stts') { tableSamples += samples; timingSamples = samples }
          else compositionSamples = samples
        }
        if (table.kind === 'stco' || table.kind === 'co64') chunks = entries
      } else if (table.kind === 'stsz' || table.kind === 'stz2') {
        need(table, table.body, 12)
        const samples = view.getUint32(table.body + 8)
        if (samples > MAX_SAMPLES) throw new Error('MP4 size sample budget exceeded')
        sizeSamples = samples
        const width = table.kind === 'stsz' ? (view.getUint32(table.body + 4) ? 0 : 32) : bytes[table.body + 7]!
        if (table.kind === 'stz2' && ![4, 8, 16].includes(width)) throw new Error('Unsupported MP4 compact sample width')
        exact(table, table.body + 12 + Math.ceil(samples * width / 8))
      } else if (table.kind === 'sdtp') {
        if (table.end - table.body - 4 > MAX_SAMPLES) throw new Error('MP4 dependency sample budget exceeded')
      } else if (table.kind === 'cslg') exact(table, table.body + (version ? 44 : 24))
      else {
        need(table, table.body, 8)
        if (!['roll', 'prol'].includes(tag(bytes, table.body + 4))) throw new Error('Unsupported or encrypted MP4 sample grouping')
        if (table.kind === 'sbgp') count(table, table.body + (version ? 12 : 8), 8)
        else {
          const at = table.body + (version === 2 ? 16 : version === 1 ? 12 : 8)
          if (version) {
            need(table, table.body + 8, 4)
            if (view.getUint32(table.body + 8) !== 2) throw new Error('Unsupported MP4 group description length')
          }
          count(table, at, 2)
        }
      }
    }
    if (timingSamples !== sizeSamples || (compositionSamples !== undefined && compositionSamples !== sizeSamples))
      throw new Error('MP4 timing and size sample counts disagree')
    const stsc = one(tables, 'stsc')!, chunkEntries = view.getUint32(stsc.body + 4)
    if (sizeSamples ? !chunks || !chunkEntries : chunks || chunkEntries) throw new Error('Invalid MP4 empty chunk table')
    let chunkSamples = 0
    for (let i = 0; i < chunkEntries; i++) {
      if (!(i % 4096)) await cooperate()
      const at = stsc.body + 8 + i * 12, first = view.getUint32(at), samples = view.getUint32(at + 4), description = view.getUint32(at + 8),
        next = i + 1 === chunkEntries ? chunks + 1 : view.getUint32(at + 12)
      if ((!i && first !== 1) || first > chunks || next <= first || !samples || !description || description > entries.length)
        throw new Error('Invalid MP4 chunk sample mapping')
      chunkSamples += (next - first) * samples
      if (chunkSamples > MAX_SAMPLES) throw new Error('MP4 chunk sample budget exceeded')
    }
    if (chunkSamples !== sizeSamples) throw new Error('MP4 chunk and size sample counts disagree')
    tracks.push({ id, handler, box, header, alternate: header.body + (version ? 46 : 34), descriptions: entries.length,
      samples: sizeSamples, regularSamples: sizeSamples })
  }
  if (tableSamples > MAX_SAMPLES * 2) throw new Error('MP4 aggregate sample budget exceeded')
  const audio = tracks.filter((track) => track.handler === 'soun'), selected = audio[index]
  if (!selected) throw new Error('MP4 audio index is outside the original track range')
  const removed = new Set(audio.filter((track) => track !== selected).map((track) => track.id))
  for (const track of audio) if (track !== selected) free.push(track.box)
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const mvex = one(movie, 'mvex', false), defaults = new Map<number, { size: number; duration: number }>()
  if (mvex) for (const box of children(mvex, ['trex', 'mehd'])) {
    if (padding.includes(box.kind)) continue
    if (box.kind === 'mehd') { exact(box, box.body + (full(box, [0, 1]).version ? 12 : 8)); continue }
    full(box); need(box, box.body, 24); exact(box, box.body + 24)
    const id = view.getUint32(box.body + 4), description = view.getUint32(box.body + 8)
    if (!byId.has(id) || defaults.has(id) || !description || description > byId.get(id)!.descriptions) throw new Error('Invalid MP4 trex track or description')
    defaults.set(id, { duration: view.getUint32(box.body + 12), size: view.getUint32(box.body + 16) })
    if (removed.has(id)) free.push(box)
  }
  const fragments = new Map<number, { tracks: FragmentTrack[]; unique: Map<number, FragmentTrack | null> }>()
  let fragmentCount = 0, inspectedFragments = 0
  for (const moof of top.filter((box) => box.kind === 'moof')) {
    if (!(fragmentCount++ % 128)) await cooperate()
    if (!mvex) throw new Error('MP4 fragments require movie defaults')
    const items = children(moof, ['mfhd', 'traf']), mfhd = one(items, 'mfhd')!
    full(mfhd); exact(mfhd, mfhd.body + 8)
    const boxes = items.filter((box) => box.kind === 'traf'), trafs: FragmentTrack[] = [],
      unique = new Map<number, FragmentTrack | null>()
    if (!boxes.length) throw new Error('MP4 fragment contains no tracks')
    let ordinal = 0
    for (const box of boxes) {
      const items = children(box, ['tfhd', 'tfdt', 'trun']), tfhd = one(items, 'tfhd')!, flags = full(tfhd, [0], 0x03003b).flags
      need(tfhd, tfhd.body, 8)
      const id = view.getUint32(tfhd.body + 4)
      const empty = !!(flags & 0x010000)
      if (!byId.has(id) || !defaults.has(id)) throw new Error('Unknown MP4 fragment track')
      if ((flags & 1) && (flags & 0x020000)) throw new Error('Conflicting MP4 fragment bases')
      if (!(flags & 1) && !(flags & 0x020000) && boxes.length !== 1) throw new Error('Inherited MP4 fragment data bases are unsupported')
      let at = tfhd.body + 8, base = moof.start,
        defaultSize = defaults.get(id)!.size, defaultDuration = defaults.get(id)!.duration
      if (flags & 1) {
        base = u64(tfhd, at)
        if (base > bytes.length) throw new Error('MP4 fragment base is outside file')
        at += 8
      }
      for (const bit of [2, 8, 16, 32]) if (flags & bit) {
        need(tfhd, at, 4)
        if (bit === 2 && (!view.getUint32(at) || view.getUint32(at) > byId.get(id)!.descriptions)) throw new Error('Invalid MP4 fragment sample description')
        if (bit === 8) defaultDuration = view.getUint32(at)
        if (bit === 16) defaultSize = view.getUint32(at)
        at += 4
      }
      exact(tfhd, at)
      const tfdt = one(items, 'tfdt')!, decodeVersion = full(tfdt, [0, 1]).version
      exact(tfdt, tfdt.body + (decodeVersion ? 12 : 8))
      let decodeTime = decodeVersion ? u64(tfdt, tfdt.body + 4) : view.getUint32(tfdt.body + 4), previousEnd = 0,
        firstTime: number | undefined
      const runs = items.filter((item) => item.kind === 'trun'), counts: number[] = []
      if (!runs.length) throw new Error('MP4 fragment has no sample runs')
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i]!, { flags, version } = full(run, [0, 1], 0xf05)
        need(run, run.body, 8)
        if (!i && !(flags & 1)) throw new Error('MP4 first fragment run requires an explicit data offset')
        if ((flags & 4) && (flags & 0x400)) throw new Error('Conflicting MP4 sample flag fields')
        const samples = view.getUint32(run.body + 4), width = [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4
        if (empty && samples) throw new Error('MP4 empty fragment contains samples')
        if (samples > MAX_SAMPLES || (tableSamples += samples) > MAX_SAMPLES * 2) throw new Error('MP4 fragment sample budget exceeded')
        if ((byId.get(id)!.samples += samples) > MAX_SAMPLES) throw new Error('MP4 track sample budget exceeded')
        exact(run, run.body + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + samples * width)
        let field = run.body + 8, position = previousEnd
        if (flags & 1) { position = base + view.getInt32(field); field += 4 }
        if (flags & 4) field += 4
        if (!Number.isSafeInteger(position) || position < 0 || position > bytes.length)
          throw new Error('MP4 fragment run offset is outside the file')
        // Each explicit offset uses this traf's fixed base, even after the
        // first run; an omitted offset continues the previous run's end.
        // Validate directly, without allocating a second per-sample table.
        for (let sample = 0; sample < samples; sample++) {
          if (!(inspectedFragments++ % 4096)) await cooperate()
          let duration = defaultDuration, size = defaultSize, composition = 0
          if (flags & 0x100) { duration = view.getUint32(field); field += 4 }
          if (flags & 0x200) { size = view.getUint32(field); field += 4 }
          if (flags & 0x400) field += 4
          if (flags & 0x800) { composition = version ? view.getInt32(field) : view.getUint32(field); field += 4 }
          validateSample(position, size, decodeTime, decodeTime + composition, duration)
          if (i === 0 && sample === 0) firstTime = decodeTime + composition
          position += size
          decodeTime += duration
        }
        previousEnd = position
        counts.push(samples)
      }
      const keep = !removed.has(id)
      const traf: FragmentTrack = { box, id, runs: counts, ordinal: keep ? ++ordinal : 0, firstTime }
      trafs.push(traf)
      unique.set(id, unique.has(id) ? null : traf)
    }
    // A separate per-track fragment may belong entirely to a removed audio
    // track. Its whole moof can become free without moving the following mdat.
    // Keep the original map until every tfra entry has still been validated.
    if (!ordinal) free.push(moof)
    else for (const traf of trafs) if (!traf.ordinal) free.push(traf.box)
    fragments.set(moof.start, { tracks: trafs, unique })
  }
  let indexEntries = 0
  for (const mfra of top.filter((box) => box.kind === 'mfra')) {
    const items = children(mfra, ['tfra', 'mfro']), mfro = one(items, 'mfro')!
    full(mfro); need(mfro, mfro.body, 8); exact(mfro, mfro.body + 8)
    if (view.getUint32(mfro.body + 4) !== mfra.end - mfra.start) throw new Error('Invalid MP4 random access footer size')
    for (const box of items.filter((item) => item.kind === 'tfra')) {
      const version = full(box, [0, 1]).version
      need(box, box.body, 16)
      const id = view.getUint32(box.body + 4), lengths = view.getUint32(box.body + 8), entries = view.getUint32(box.body + 12)
      if (!byId.has(id) || (lengths >>> 6) || entries > MAX_SAMPLES) throw new Error('Invalid MP4 random access index')
      if ((indexEntries += entries) > MAX_SAMPLES * 2) throw new Error('MP4 aggregate index entry budget exceeded')
      const widths = [(lengths >>> 4 & 3) + 1, (lengths >>> 2 & 3) + 1, (lengths & 3) + 1]
      let at = box.body + 16
      const unsigned = (width: number) => {
        need(box, at, width)
        let value = 0
        for (let i = 0; i < width; i++) value = value * 256 + bytes[at++]!
        return value
      }
      for (let i = 0; i < entries; i++) {
        if (!(i % 4096)) await cooperate()
        need(box, at, version ? 16 : 8)
        const time = version ? u64(box, at) : view.getUint32(at),
          offset = version ? u64(box, at + 8) : view.getUint32(at + 4)
        at += version ? 16 : 8
        const ordinalAt = at, oldOrdinal = unsigned(widths[0]!), run = unsigned(widths[1]!), sample = unsigned(widths[2]!)
        const fragment = fragments.get(offset)
        let traf = fragment?.tracks[oldOrdinal - 1]
        if (traf?.id !== id && oldOrdinal === 1 && run === 1 && sample === 1) {
          // FFmpeg 6.1.1 mov_write_tfra_tag writes traf/trun/sample = 1 even
          // when the track is a later traf in a shared moof. Recover only that
          // first-sample form, with one matching track and its actual CTS.
          const matching = fragment?.unique.get(id)
          if (matching && matching.firstTime === time) traf = matching
        }
        if (!traf || traf.id !== id || run < 1 || run > traf.runs.length || sample < 1 || sample > traf.runs[run - 1]!) throw new Error('MP4 random access entry references an invalid fragment')
        if (!removed.has(id)) {
          if (traf.ordinal >= 256 ** widths[0]!) throw new Error('MP4 random access ordinal exceeds its field width')
          writes.push({ at: ordinalAt, value: traf.ordinal, width: widths[0]! })
        }
      }
      exact(box, at)
      if (removed.has(id)) free.push(box)
    }
  }
  for (const box of top.filter((item) => item.kind === 'sidx')) {
    const version = full(box, [0, 1]).version
    need(box, box.body, version ? 32 : 24)
    const id = view.getUint32(box.body + 4), offset = version ? u64(box, box.body + 20) : view.getUint32(box.body + 16), at = box.body + (version ? 32 : 24)
    if (!byId.has(id) || !view.getUint32(box.body + 8)) throw new Error('Unsupported MP4 segment index reference')
    const entries = view.getUint16(at - 2)
    if ((indexEntries += entries) > MAX_SAMPLES * 2) throw new Error('MP4 aggregate index entry budget exceeded')
    exact(box, at + entries * 12)
    let position = box.end + offset
    for (let i = 0; i < entries; i++) {
      if (!(i % 4096)) await cooperate()
      const value = view.getUint32(at + i * 12), size = value & 0x7fffffff
      if ((value >>> 31) || !size || !topStarts.has(position) || size > bytes.length - position)
        throw new Error('Unsupported hierarchical or invalid MP4 segment index')
      position += size
    }
    if (entries && !topEnds.has(position)) throw new Error('MP4 segment index ends inside a box')
    if (removed.has(id)) free.push(box)
  }
  // MP4Box still validates regular tables and total sample counts. Its pinned
  // 2.4.1 fragment offsets ignore later explicit trun offsets, so fragment
  // addresses/times were validated independently above and are not reused here.
  await cooperate()
  const { createFile } = await import('mp4box'), file = createFile(false)
  file.onError = (message) => { throw new Error(`MP4 audio metadata: ${message}`) }
  // v2.4.1 appendBuffer accepts ArrayBuffer + fileStart; fromArrayBuffer would
  // silently allocate a second complete input. One private contiguous buffer
  // also avoids MultiBufferStream's overlap/concatenation copies.
  file.appendBuffer(Object.assign(bytes.buffer, { fileStart: 0, usedBytes: 0 })); file.flush()
  await cooperate()
  let total = 0, inspected = 0
  for (const track of tracks) {
    const samples = file.getTrackSamplesInfo(track.id)
    if (!samples || samples.length > MAX_SAMPLES || (total += samples.length) > MAX_SAMPLES * 2) throw new Error('MP4 decoded sample table budget exceeded')
    if (samples.length !== track.samples) throw new Error('MP4 expanded sample count does not match its source tables')
    for (let i = 0; i < track.regularSamples; i++) {
      const sample = samples[i]!
      if (!(inspected++ % 4096)) await cooperate()
      validateSample(sample.offset, sample.size, sample.dts, sample.cts, sample.duration)
    }
  }
  await cooperate()
  let committed = 0
  for (const box of free) {
    if (!(committed++ % 4096)) await cooperate()
    bytes.set([102, 114, 101, 101], box.start + 4)
  }
  bytes[selected.header.body + 3] = bytes[selected.header.body + 3]! | 3 // enabled and in-movie
  view.setUint16(selected.alternate, 0)
  for (const write of writes) {
    if (!(committed++ % 4096)) await cooperate()
    let value = write.value
    for (let i = write.width - 1; i >= 0; i--) { bytes[write.at + i] = value & 255; value = Math.floor(value / 256) }
  }
  return { bytes, audioStreams: audio.length, videoStreams: tracks.filter((track) => track.handler === 'vide').length, selectedTrackId: selected.id }
}

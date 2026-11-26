import type { ByteSource, Resource } from '../../engine/ports/storage.ts'
import { borrowResourceBlob, openResourceSource, resourceReadBounds, resourceViewBounds } from '../../engine/storage/resource-source.ts'
import { zipEndOffsets } from '../../formats/zip/executable.ts'

/** A logical archive spanning physical game inputs. The library keeps each
 * original file and its own checksums, even when a read crosses volumes. */
function join(name: string, files: Resource[], pkzip: boolean, checkpoint: () => Promise<void>): Resource {
  let size = 0
  const starts = files.map((file) => {
    const start = size
    size += file.size
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || !Number.isSafeInteger(size))
      throw new Error('Invalid archive volume size: ' + file.name)
    return start
  })
  function* spans(offset: number, length: number) {
    let low = 0, high = starts.length
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2)
      if (starts[mid]! <= offset) low = mid
      else high = mid
    }
    for (let i = low; length; i++) {
      const file = files[i]!, at = offset - starts[i]!, take = Math.min(length, file.size - at)
      yield { file, at, take }
      offset += take
      length -= take
    }
  }
  const source: ByteSource = {
    size,
    async read(offset, length) {
      resourceReadBounds(size, offset, length)
      await checkpoint()
      const output = new Uint8Array(length)
      let written = 0
      for (const { file, at, take } of spans(offset, length)) {
        const part = file.source ?? (await openResourceSource(file, { checkpoint })).source
        if (part.size !== file.size) throw new Error('Archive volume size changed: ' + file.name)
        const bytes = await part.read(at, take)
        await checkpoint()
        if (!(bytes instanceof Uint8Array) || bytes.length !== take) throw new Error('Short archive volume read: ' + file.name)
        output.set(bytes, written)
        written += take
      }
      return output
    },
    ...(files.every((file) => file.source?.borrowBlob) ? {
      async borrowBlob(offset: number, length: number, check?: () => void | Promise<void>) {
        resourceViewBounds(size, offset, length)
        const blobs: Blob[] = [], step = async () => { await checkpoint(); await check?.() }
        await step()
        for (const { file, at, take } of spans(offset, length)) {
          const blob = await borrowResourceBlob(file.source!, at, take, step)
          if (!(blob instanceof Blob)) throw new Error('Expected immutable game file backing')
          blobs.push(blob)
        }
        return new Blob(blobs)
      },
    } : {}),
  }
  return { name, size, source, read: () => source.read(0, size),
    ...(pkzip ? { zipDiskOffsets: Object.freeze(starts) } : {}) }
}

interface VolumeGroup {
  numbered: Map<number, Resource>
  pkzip: boolean
  lastDisk?: number
}

async function mzVolume(file: Resource, checkpoint: () => Promise<void>): Promise<boolean> {
  if (file.size < 2) return false
  const { source } = await openResourceSource(file, { checkpoint }), bytes = await source.read(0, 2)
  return bytes[0] === 0x4d && bytes[1] === 0x5a
}

/** Only a final disk declaring multiple disks can turn a same-name EXE into
 * volume zero. A normal installer beside an independent ZIP stays separate. */
async function pksfxLastDisk(file: Resource, checkpoint: () => Promise<void>): Promise<number | undefined> {
  if (file.size < 22 || file.zipDiskOffsets) return
  const { source } = await openResourceSource(file, { checkpoint }),
    at = Math.max(0, source.size - 65557), bytes = await source.read(at, source.size - at),
    tail = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (const end of zipEndOffsets(tail)) {
    const disk = tail.getUint16(end + 4, true), centralDisk = tail.getUint16(end + 6, true)
    if (disk === 0) return
    if (disk !== 0xffff && centralDisk !== 0xffff && centralDisk > disk) continue
    if (disk !== 0xffff) return disk
    // ZIP64's locator gives the physical disk count even when the classic
    // disk field is saturated. The full index reader checks all other fields.
    const locatorAt = at + end - 20
    if (locatorAt < 0) continue
    const locatorBytes = await source.read(locatorAt, 20),
      locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength),
      disks = locator.getUint32(16, true)
    if (locator.getUint32(0, true) === 0x07064b50 && disks > 1 && locator.getUint32(4, true) < disks &&
      (centralDisk === 0xffff || centralDisk < disks)) return disks - 1
  }
}

/** ZIP/XP3/executable byte splits use logical offsets; PKZIP .zNN files retain the
 * original disk numbers. Use the spelling of the first byte part or final
 * PKZIP disk and keep independent archives in their submitted mount order. */
export async function joinArchiveVolumes(files: readonly Resource[], checkpoint: () => Promise<void>): Promise<Resource[]> {
  const groups = new Map<string, VolumeGroup>(), physical = new Map<string, Resource[]>()
  for (const [i, file] of files.entries()) {
    if (i % 256 === 0) await checkpoint()
    const key = file.name.toLowerCase()
    const raw = /^(.*\.(?:zip|xp3|exe))\.(\d{3,})$/i.exec(file.name)
    const disk = raw ? null : /^(.*)\.z(\d{2,})$/i.exec(file.name)
    const part = raw || disk
    if (!part) {
      if (/\.(?:zip|xp3|exe)$/i.test(key)) {
        const matches = physical.get(key) ?? []
        matches.push(file)
        physical.set(key, matches)
      }
      continue
    }
    const target = (part[1]! + (raw ? '' : '.zip')).toLowerCase()
    const group = groups.get(target) ?? { numbered: new Map<number, Resource>(), pkzip: !raw }
    const number = Number(part[2])
    if (group.pkzip !== !raw || group.numbered.has(number))
      throw new Error('游戏归档分卷重名或混用了两种编号：' + file.name)
    group.numbered.set(number, file)
    groups.set(target, group)
  }
  // PKWARE APPNOTE 8.4.1 replaces .z01 with .exe. Two-disk sets contain
  // only that executable first volume and the final .zip, without any .zNN.
  for (const [target, finals] of physical) {
    if (!target.endsWith('.zip') || finals.length !== 1) continue
    const group = groups.get(target)
    if (group && (!group.pkzip || group.numbered.has(1))) continue
    const executables = physical.get(target.slice(0, -4) + '.exe') ?? []
    if (!executables.length) continue
    let lastDisk: number | undefined, mz = false
    try {
      lastDisk = await pksfxLastDisk(finals[0]!, checkpoint)
      if (lastDisk !== undefined && executables.length === 1) mz = await mzVolume(executables[0]!, checkpoint)
    } catch (error) {
      if (group) throw error
      // With no numbered sibling, these may simply be unrelated resources
      // beside a playable game. Optional probing must not break that game.
      // A real cancellation still wins before falling back to independent files.
      await checkpoint()
      continue
    }
    if (lastDisk === undefined) continue
    if (executables.length !== 1) throw new Error('游戏归档分卷重名：' + target.slice(0, -4) + '.exe')
    if (!mz) continue
    const selected: VolumeGroup = group ?? { numbered: new Map<number, Resource>(), pkzip: true }
    selected.numbered.set(1, executables[0]!)
    selected.lastDisk = lastDisk
    groups.set(target, selected)
  }
  if (!groups.size) return [...files]
  const replacements = new Map<Resource, Resource>(), consumed = new Set<Resource>()
  for (const [target, { numbered, pkzip, lastDisk }] of groups) {
    await checkpoint()
    const finals = physical.get(target) ?? []
    // A complete archive named *.001 could already be opened by its
    // signature and addressed by that exact name in an existing library.
    if (!pkzip && numbered.size === 1 && numbered.has(1)) continue
    if (pkzip && !finals.length) {
      // An unrelated DOS .z80 or a leftover disk alongside a valid game is
      // still an ordinary resource. A selection made solely of parts needs
      // the final directory disk before it can be played.
      const first = numbered.get(1)
      if (files.length === numbered.size && first && first.size >= 4) {
        const { source } = await openResourceSource(first, { checkpoint })
        const mark = await source.read(0, 4)
        if (mark[0] === 0x50 && mark[1] === 0x4b &&
          (mark[2] === 3 && mark[3] === 4 || mark[2] === 7 && mark[3] === 8))
          throw new Error('缺少 ZIP 最后一卷：' + target)
      }
      const exe = physical.get(target.slice(0, -4) + '.exe')
      if (!first && numbered.has(2) && exe?.length === 1 && files.length === numbered.size + 1 &&
          await mzVolume(exe[0]!, checkpoint)) throw new Error('缺少 ZIP 最后一卷：' + target)
      continue
    }
    if (finals.length !== (pkzip ? 1 : 0)) throw new Error('游戏归档和分卷的文件名冲突：' + target)
    const parts: Resource[] = []
    if (lastDisk !== undefined && [...numbered.keys()].some((number) => number < 1 || number > lastDisk))
      throw new Error('ZIP 分卷编号与最后一卷不匹配：' + target)
    for (let i = 1; i <= (lastDisk ?? numbered.size); i++) {
      if (i % 256 === 0) await checkpoint()
      const file = numbered.get(i)
      if (!file) throw new Error('游戏归档缺少分卷 ' + i + '：' + target)
      parts.push(file)
      consumed.add(file)
    }
    const first = parts[0]!
    const anchor = pkzip ? finals[0]! : first
    if (pkzip) { parts.push(anchor); consumed.add(anchor) }
    const name = pkzip ? anchor.name : anchor.name.slice(0, anchor.name.lastIndexOf('.'))
    replacements.set(anchor, join(name, parts, pkzip, checkpoint))
  }
  return files.flatMap((file) => replacements.get(file) ?? (consumed.has(file) ? [] : [file]))
}

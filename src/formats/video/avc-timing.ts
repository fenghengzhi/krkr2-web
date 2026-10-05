/** H.264 SPS/VUI timing only; this does not decode pictures or replace MP4 CTS.
 * Syntax: ITU-T H.264 7.3.2.1.1 / Annex E. FFmpeg h264_parser uses
 * 2*num_units_in_tick/time_scale for the nominal frame duration independently
 * of fixed_frame_rate_flag. Restrict this adapter to progressive avc1: avc3
 * may change its SPS in-band, and field/picture timing needs a fuller decoder. */
class Bits {
  private position = 0
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    if (count < 0 || count > 32 || this.position + count > this.bytes.length * 8)
      throw new Error('Truncated AVC sequence parameter set')
    let value = 0
    for (let bit = 0; bit < count; bit++, this.position++)
      value = value * 2 + ((this.bytes[this.position >>> 3]! >>> (7 - (this.position & 7))) & 1)
    return value
  }
  ue(): number {
    let zeros = 0
    while (!this.read(1)) if (++zeros > 31) throw new Error('AVC Exp-Golomb value exceeds budget')
    return 2 ** zeros - 1 + this.read(zeros)
  }
  se(): number {
    const value = this.ue()
    return value % 2 ? (value + 1) / 2 : -value / 2
  }
  bounded(max: number, field: string): number {
    const value = this.ue()
    if (value > max) throw new Error(`Invalid AVC ${field}`)
    return value
  }
}

function spsDuration(nal: Uint8Array): number | undefined {
  if (nal.length < 4 || nal.length > 65535 || (nal[0]! & 0x80) || !(nal[0]! & 0x60) || (nal[0]! & 31) !== 7)
    throw new Error('Invalid AVC sequence parameter set')
  const rbsp = new Uint8Array(nal.length - 1)
  let size = 0, zeros = 0
  for (let at = 1; at < nal.length; at++) {
    const byte = nal[at]!
    if (zeros === 2 && byte === 3) {
      if (at + 1 >= nal.length || nal[at + 1]! > 3) throw new Error('Invalid AVC emulation prevention byte')
      zeros = 0
      continue
    }
    if (zeros === 2 && byte <= 2) throw new Error('Missing AVC emulation prevention byte')
    rbsp[size++] = byte
    zeros = byte === 0 ? Math.min(2, zeros + 1) : 0
  }
  const bits = new Bits(rbsp.subarray(0, size)), profile = bits.read(8)
  bits.read(8); bits.read(8) // constraint flags/reserved and level_idc
  // Other profiles may have additional syntax. Do not derive a clock from a
  // guessed layout (including scalable/multiview extensions).
  if (![66, 77, 88, 100, 110, 122, 244, 44].includes(profile)) return
  bits.bounded(31, 'seq_parameter_set_id')
  if ([100, 110, 122, 244, 44].includes(profile)) {
    const chroma = bits.bounded(3, 'chroma_format_idc')
    if (chroma === 3) bits.read(1) // separate_colour_plane_flag
    bits.bounded(6, 'bit_depth_luma_minus8'); bits.bounded(6, 'bit_depth_chroma_minus8')
    bits.read(1) // qpprime_y_zero_transform_bypass_flag
    if (bits.read(1)) for (let list = 0; list < (chroma === 3 ? 12 : 8); list++) {
      if (!bits.read(1)) continue
      let last = 8, next = 8
      for (let i = 0; i < (list < 6 ? 16 : 64); i++) {
        if (next !== 0) {
          const delta = bits.se()
          if (delta < -128 || delta > 127) throw new Error('Invalid AVC scaling_list delta_scale')
          next = (last + delta + 256) % 256
        }
        if (next !== 0) last = next
      }
    }
  }
  bits.bounded(12, 'log2_max_frame_num_minus4')
  const order = bits.bounded(2, 'pic_order_cnt_type')
  if (order === 0) bits.bounded(12, 'log2_max_pic_order_cnt_lsb_minus4')
  else if (order === 1) {
    bits.read(1); bits.se(); bits.se()
    const cycle = bits.bounded(255, 'num_ref_frames_in_pic_order_cnt_cycle')
    for (let i = 0; i < cycle; i++) bits.se()
  }
  bits.bounded(16, 'max_num_ref_frames'); bits.read(1)
  bits.bounded(65535, 'pic_width_in_mbs_minus1'); bits.bounded(65535, 'pic_height_in_map_units_minus1')
  const progressive = bits.read(1) !== 0
  if (!progressive) bits.read(1)
  bits.read(1) // direct_8x8_inference_flag
  if (bits.read(1)) for (let i = 0; i < 4; i++) bits.ue() // frame crop offsets
  if (!bits.read(1)) return // vui_parameters_present_flag
  if (bits.read(1) && bits.read(8) === 255) { bits.read(16); bits.read(16) }
  if (bits.read(1)) bits.read(1) // overscan_info_present_flag
  if (bits.read(1)) {
    bits.read(3); bits.read(1) // video_format, video_full_range_flag
    if (bits.read(1)) { bits.read(8); bits.read(8); bits.read(8) }
  }
  if (bits.read(1)) { bits.bounded(5, 'chroma_sample_loc_type_top_field'); bits.bounded(5, 'chroma_sample_loc_type_bottom_field') }
  if (!bits.read(1)) return // timing_info_present_flag
  const units = bits.read(32), scale = bits.read(32)
  bits.read(1) // fixed_frame_rate_flag does not make nominal timing unavailable
  if (!units || !scale) throw new Error('Invalid AVC VUI timing values')
  return progressive ? (2000 * units) / scale : undefined
}

/** All SPS records in one avc1 description must agree. The caller shares the
 * metadata budget across descriptions/tracks and only calls once per object. */
export function readAvcFrameDuration(description: unknown, budget = { remaining: 1024 * 1024 }): number | undefined {
  if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 0) throw new Error('Invalid AVC SPS metadata budget')
  if (!description || typeof description !== 'object' || !('type' in description) || description.type !== 'avc1') return
  const config = (description as { avcC?: { SPS?: Array<{ length: number; data: Uint8Array }> } }).avcC,
    sets = config?.SPS
  if (!Array.isArray(sets) || !sets.length || sets.length > 31) throw new Error('Invalid AVC SPS inventory')
  let duration: number | undefined, available = true
  for (const set of sets) {
    if (!(set?.data instanceof Uint8Array) || set.length !== set.data.length || set.length > budget.remaining)
      throw new Error('AVC SPS metadata budget or length exceeded')
    budget.remaining -= set.length
    const value = spsDuration(set.data)
    if (value === undefined || (duration !== undefined && duration !== value)) available = false
    duration ??= value
  }
  return available ? duration : undefined
}

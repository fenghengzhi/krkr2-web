/** Vorbis I 4.3.9 mapping 0, also the output order of the pinned libvorbis
 * wrapper. The mixer consumes increasing WAVE speaker bits. Channel count
 * alone cannot distinguish 5.0 rear speakers or the 6.1 rear-center plane.
 * https://xiph.org/vorbis/doc/Vorbis_I_spec.html (section 4.3.9)
 * Mono/stereo retain their old unspecified layout (including quad expansion).
 */
interface VorbisLayout { readonly order?: readonly number[]; readonly speakerMask?: number }
const unspecified: VorbisLayout = {}
const layouts: Readonly<Record<number, VorbisLayout>> = {
  3: { order: [0, 2, 1], speakerMask: 0x7 },
  4: { speakerMask: 0x33 },
  5: { order: [0, 2, 1, 3, 4], speakerMask: 0x37 },
  6: { order: [0, 2, 1, 5, 3, 4], speakerMask: 0x3f },
  7: { order: [0, 2, 1, 6, 5, 3, 4], speakerMask: 0x70f },
  8: { order: [0, 2, 1, 7, 5, 6, 3, 4], speakerMask: 0x63f },
}
export const vorbisLayout = (channels: number): VorbisLayout => layouts[channels] ?? unspecified

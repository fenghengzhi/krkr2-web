/** XP3 mark + index pointer 19 + unsupported index compression 7. This raw
 * container exists and is readable; only opening its index is invalid. */
export const malformedXp3 = new Uint8Array([0x58,0x50,0x33,13,10,32,10,26,139,103,1,19,0,0,0,0,0,0,0,7])

import { createHash } from 'node:crypto'
import { discStoryGame } from './disc-story.ts'
import { distributionZip, member } from './deflated-distribution.ts'

/** The installation archive contains only the original KAG game. Its data CD
 * remains a sibling import, never an extra script-visible game resource. */
export function discStoryRelease(binary: boolean) {
  const original = discStoryGame(binary), game = original.filter((file) => !['story.cue', 'story.iso'].includes(file.name)),
    cue = original.find((file) => file.name === 'story.cue')!.buffer,
    image = original.find((file) => file.name === 'story.iso')!.buffer,
    files = [{ name: 'Game.zip', buffer: distributionZip(game.map((file) => member('Game/' + file.name, file.buffer))) },
      ...(binary
        ? [{ name: 'Voices.zip', buffer: distributionZip([member('Media/story.cue', cue), member('Media/story.iso', image)]) }]
        : [{ name: 'Extras/story.cue', buffer: cue }, { name: 'Extras/story.iso', buffer: image }]),
      { name: 'notes.txt', buffer: Buffer.from('"OUTSIDE THE GAME NAMESPACE"') }],
    hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  return {
    files: files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })),
    drive: binary ? 'G' : 'D', mapping: binary ? 'G=Voices.zip>Media/story.cue' : '',
    directory: 'Game/',
    manifest: {
      mode: binary ? 'bytecode/external ZIP CUE' : 'source/loose CUE',
      files: files.map((file) => ({ name: file.name, bytes: file.buffer.length, sha256: hash(file.buffer) })),
      gameMembers: game.map((file) => ({ name: 'Game/' + file.name, bytes: file.buffer.length, sha256: hash(file.buffer) })),
      externalDisc: { cueSha256: hash(cue), imageSha256: hash(image) },
    },
  }
}

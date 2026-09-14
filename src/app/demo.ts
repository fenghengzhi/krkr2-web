import backgroundUrl from '../../examples/minimal/background.png?url'
import startupSource from '../../examples/minimal/startup.tjs?raw'
import sceneSource from '../../examples/minimal/scene.tjs?raw'
import type { GameFile } from '../protocol/session.ts'

export async function demoFiles(): Promise<GameFile[]> {
  const response = await fetch(backgroundUrl)
  if (!response.ok) throw new Error('Demo image could not be loaded')
  return [
    { path: 'startup.tjs', blob: new Blob([startupSource]) },
    { path: 'scene.tjs', blob: new Blob([sceneSource]) },
    { path: 'background.png', blob: await response.blob() },
  ]
}

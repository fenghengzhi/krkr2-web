import assert from 'node:assert/strict'
import type { EngineSession } from '../../src/engine/session.ts'

/** A headless pixel oracle consumes the complete window image. Select the
 * actual public CPU draw device; the default WebGL device intentionally sends
 * one FrameLayer per texture. Browser counterparts retain that default path. */
export async function selectSoftwareFrame(session: EngineSession, window: string): Promise<void> {
  const drawer = await session.evaluate(`(function(){var w=${window};
    w.drawDevice.preferredDrawer=Window.PassThroughDrawDevice.dtDrawDib;
    w.drawDevice.recreate();w.update();return w.drawDevice.drawer;})()`)
  assert.equal(drawer, '1', 'The real CPU drawer must publish a complete window image')
  await session.idle()
}

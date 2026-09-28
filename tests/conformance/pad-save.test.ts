import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent, SessionDependencies } from '../../src/engine/session.ts'
import type {
  PadIdentity,
  PadMessage,
  PadPresentation,
  PadSaveRequest,
} from '../../src/protocol/pad.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function latestPads(events: EngineEvent[]): PadPresentation {
  const event = events.filter((event) => event.type === 'pads').at(-1)
  assert(event?.type === 'pads')
  return event
}

async function until(ready: () => boolean, description: string): Promise<void> {
  const end = performance.now() + 10000
  while (!ready()) {
    assert(performance.now() < end, `Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function frameClock() {
  let now = 0
  const tasks = new Set<{ at: number; run(): void }>()
  return {
    now: () => now,
    schedule(run: () => void, delay: number) {
      const task = { at: now + delay, run }
      tasks.add(task)
      return () => {
        tasks.delete(task)
      }
    },
    advance(milliseconds: number) {
      now += milliseconds
      for (const task of [...tasks]) if (task.at <= now && tasks.delete(task)) task.run()
    },
    get pending() {
      return tasks.size
    },
  }
}

async function fixture(
  binary: boolean,
  source = '',
  overrides: Partial<SessionDependencies> = {},
  resources: Record<string, string | Uint8Array> = {},
) {
  const harness = await headless(
    {
      ...resources,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("pad-save.tjs","savedata/pad-save.cjs",false,true,false);Scripts.execStorage("savedata/pad-save.cjs");'
        : 'Scripts.execStorage("pad-save.tjs");',
      'pad-save.tjs':
        String.raw`
System.exitOnWindowClose=false;
var pad=new Pad(),other=new Pad();pad.visible=true;other.visible=true;
pad.text="original\n雪😀";pad.fileName="C:\\private\\draft";
other.text="other";other.fileName="other.tjs";
function replaceText(){pad.text="script replacement";return pad.text;}
function hidePad(){pad.visible=false;return 0;}
function destroyPad(){invalidate pad;return 0;}
` + source,
    },
    overrides,
  )
  try {
    await harness.session.start()
  } catch (error) {
    await harness.session.stop()
    throw error
  }
  let sequence = 0
  const identity = (index = 0): PadIdentity => {
    const pad = latestPads(harness.events).pads[index]
    assert(pad)
    return {
      generation: 1,
      id: pad.id,
      epoch: pad.epoch,
      baseTextEpoch: pad.textEpoch,
      seq: ++sequence,
    }
  }
  const request = (): PadSaveRequest => {
    const save = latestPads(harness.events).save
    assert(save, 'Save-open must publish a shared host modal scope')
    return save
  }
  const open = () => {
    assert.equal(harness.session.pad({ ...identity(), kind: 'save-open' }).status, 'accepted')
    return request()
  }
  return { ...harness, identity, request, open }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`Pad save captures an acknowledged readonly snapshot and releases its host scope only after the matching receipt (${mode})`, async () => {
    const f = await fixture(binary, 'function protect(){pad.readOnly=true;return 0;}')
    try {
      const edited = f.session.pad({ ...f.identity(), kind: 'edit', text: 'typed\n雪😀' })
      assert.equal(edited.status, 'accepted')
      assert.equal(edited.view?.text, 'typed\r\n雪😀')
      assert.equal(await f.session.evaluate('protect()'), '0')
      const initial = latestPads(f.events).pads[0]!,
        save = f.open()
      assert.equal(save.text, 'typed\r\n雪😀')
      assert.equal(save.fileName, 'draft.tjs')
      assert.equal(save.revision, initial.revision)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert(latestPads(f.events).pads.every((pad) => pad.blocked))
      assert.equal(
        f.session.pad({ ...f.identity(1), kind: 'edit', text: 'blocked' }).status,
        'ignored',
      )
      assert.equal(await f.session.evaluate('replaceText()'), 'script replacement')
      assert.equal(
        f.request().text,
        'typed\r\n雪😀',
        'A script replacement cannot rewrite the save snapshot',
      )
      assert.equal(f.request().revision, save.revision)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'accepted',
        }).status,
        'accepted',
      )
      const confirmed = f.request()
      assert.equal(confirmed.fileName, 'accepted.tjs')
      assert.equal(confirmed.text, save.text)
      assert.equal(typeof confirmed.receipt, 'number')
      assert.equal(latestPads(f.events).pads[0]!.fileName, 'C:\\private\\draft')
      assert.equal(
        f.session.inspectOwnership().modalScopes,
        1,
        'Confirmation alone must not release the scope',
      )
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'duplicate',
        }).status,
        'ignored',
      )
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: confirmed.receipt! + 1,
          ok: true,
        }).status,
        'ignored',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: confirmed.receipt!,
          ok: true,
        }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(latestPads(f.events).save, null)
      assert(latestPads(f.events).pads.every((pad) => !pad.blocked))
      assert.equal(
        await f.session.evaluate('[pad.text,pad.fileName,other.text,other.fileName].join("|")'),
        'script replacement|accepted.tjs|other|other.tjs',
      )
      assert.deepEqual(
        f.session.exportSaves().map((file) => file.path),
        binary ? ['savedata/pad-save.cjs'] : [],
      )
    } finally {
      await f.session.stop()
    }
    assert.equal(f.session.snapshot().handles, 0)
  })

  test(`Pad save failures retain their scope for retry and cancellation preserves the script fileName (${mode})`, async () => {
    const f = await fixture(binary)
    try {
      const save = f.open()
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'first.tjs',
        }).status,
        'accepted',
      )
      const first = f.request().receipt!
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: first,
          ok: false,
          error: 'download denied',
        }).status,
        'accepted',
      )
      assert.equal(f.request().error, 'download denied')
      assert.equal(f.request().receipt, undefined)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'second.tjs',
        }).status,
        'accepted',
      )
      const second = f.request().receipt!
      assert.notEqual(first, second, 'Retry must receive a fresh one-use receipt')
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: first,
          ok: true,
        }).status,
        'ignored',
      )
      assert.equal(
        f.session.pad({ ...f.identity(), kind: 'save-cancel', requestId: save.id }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(latestPads(f.events).save, null)
      assert.equal(await f.session.evaluate('pad.fileName'), 'C:\\private\\draft')
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: second,
          ok: true,
        }).status,
        'ignored',
      )
    } finally {
      await f.session.stop()
    }
  })

  for (const action of ['hidePad', 'destroyPad'] as const) {
    test(`Pad ${action} revokes a confirmed save before a late download outcome (${mode})`, async () => {
      const f = await fixture(binary)
      try {
        const save = f.open()
        assert.equal(
          f.session.pad({
            ...f.identity(),
            kind: 'save-confirm',
            requestId: save.id,
            fileName: 'late.tjs',
          }).status,
          'accepted',
        )
        const late: PadMessage = {
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: f.request().receipt!,
          ok: true,
        }
        assert.equal(await f.session.evaluate(`${action}()`), '0')
        assert.equal(f.session.inspectOwnership().modalScopes, 0)
        assert.equal(latestPads(f.events).save, null)
        assert.equal(f.session.pad(late).status, 'ignored')
        assert.equal(await f.session.evaluate('other.text'), 'other')
        if (action === 'hidePad')
          assert.equal(await f.session.evaluate('pad.fileName'), 'C:\\private\\draft')
      } finally {
        await f.session.stop()
      }
    })
  }

  test(`Stopping a confirmed Pad save retires the host scope and rejects its late receipt (${mode})`, async () => {
    const f = await fixture(binary)
    let late: PadMessage | undefined
    try {
      const save = f.open()
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'late.tjs',
        }).status,
        'accepted',
      )
      late = {
        ...f.identity(),
        kind: 'save-outcome',
        requestId: save.id,
        receipt: f.request().receipt!,
        ok: true,
      }
    } finally {
      await f.session.stop()
    }
    assert.equal(f.session.inspectOwnership().modalScopes, 0)
    assert.equal(f.session.inspectOwnership().padSources, 0)
    assert.equal(f.session.snapshot().handles, 0)
    assert.deepEqual(latestPads(f.events).pads, [])
    assert.equal(latestPads(f.events).save, null)
    assert(late)
    assert.equal(f.session.pad(late).status, 'ignored')
  })

  test(`Pad host save stays available during user pause without resuming the VM (${mode})`, async () => {
    const f = await fixture(binary)
    try {
      f.session.pause()
      assert.equal(f.session.snapshot().state, 'paused')
      const before = f.session.snapshot().handles,
        save = f.open()
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(
        f.session.inspectOwnership().modalWaits,
        0,
        'A host save does not borrow a suspended TJS wait frame',
      )
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'paused.tjs',
        }).status,
        'accepted',
      )
      const receipt = f.request().receipt!
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt,
          ok: true,
        }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().userPaused, true)
      assert.equal(f.session.snapshot().handles, before)
      f.session.resume()
      assert.equal(await f.session.evaluate('pad.fileName'), 'paused.tjs')
    } finally {
      await f.session.stop()
    }
  })

  test(`Layer self-updates keep their ordinary frame schedule during and after a Pad save (${mode})`, async () => {
    const clock = frameClock(),
      f = await fixture(
        binary,
        `
var win=new Window();win.setInnerSize(4,4);win.visible=true;
var layer=new Layer(win,null);layer.setSize(4,4);layer.visible=true;
var padPaintCount=0;
layer.onPaint=function(){
  global.padPaintCount++;
  Debug.message("pad-save-paint:"+global.padPaintCount);
  if(global.padPaintCount<5)layer.update();
};
layer.update();
`,
        { now: clock.now, schedule: clock.schedule },
      ),
      painted = () => f.logs.filter((line) => line.startsWith('pad-save-paint:')),
      advance = async (milliseconds: number) => {
        clock.advance(milliseconds)
        // Drain only work scheduled by the actual deadline. Evaluating a TJS
        // expression here would hide the missing autonomous redraw regression.
        await f.session.idle()
      }
    try {
      await f.session.idle()
      assert.deepEqual(painted(), ['pad-save-paint:1'])
      assert.equal(clock.pending, 1)
      const save = f.open()
      assert.equal(f.session.inspectOwnership().modalWaits, 0)
      assert.deepEqual(painted(), ['pad-save-paint:1'], 'Opening a save does not create a VM turn')
      await advance(15)
      assert.deepEqual(painted(), ['pad-save-paint:1'])
      await advance(1)
      assert.deepEqual(painted(), ['pad-save-paint:1', 'pad-save-paint:2'])
      assert.equal(f.request().id, save.id)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(clock.pending, 1)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'animating.tjs',
        }).status,
        'accepted',
      )
      const receipt = f.request().receipt!
      await advance(16)
      assert.deepEqual(painted(), ['pad-save-paint:1', 'pad-save-paint:2', 'pad-save-paint:3'])
      assert.equal(f.request().receipt, receipt)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt,
          ok: true,
        }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      await advance(16)
      assert.deepEqual(painted(), [
        'pad-save-paint:1',
        'pad-save-paint:2',
        'pad-save-paint:3',
        'pad-save-paint:4',
      ])

      const pausedSave = f.open()
      f.session.pause()
      assert.equal(clock.pending, 0)
      await advance(100)
      assert.equal(painted().length, 4)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-cancel',
          requestId: pausedSave.id,
        }).status,
        'accepted',
      )
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(clock.pending, 0)
      assert.equal(painted().length, 4, 'Host completion cannot override the game pause')
      f.session.resume()
      assert.equal(clock.pending, 1)
      await advance(0)
      assert.deepEqual(painted(), [
        'pad-save-paint:1',
        'pad-save-paint:2',
        'pad-save-paint:3',
        'pad-save-paint:4',
        'pad-save-paint:5',
      ])
      assert.equal(clock.pending, 0)
    } finally {
      await f.session.stop()
    }
    assert.equal(clock.pending, 0)
    assert.equal(f.session.snapshot().handles, 0)
  })

  test(`Pad discovers its actual mounted font bytes while the game VM remains user-paused (${mode})`, async () => {
    const bytes = await readFile(new URL('../fixtures/font-selection/latin.ttf', import.meta.url))
    const f = await fixture(
      binary,
      'pad.fontFace="Selection Latin";',
      {},
      { 'fonts/latin.ttf': bytes },
    )
    try {
      const pad = latestPads(f.events).pads[0]!,
        baselineLogs = [...f.logs]
      f.session.pause()
      const handles = f.session.snapshot().handles
      const font = await bounded(
        f.session.padFont(pad.id, pad.epoch),
        'font discovery while user-paused',
      )
      assert(font, 'The mounted font must be discovered without requiring a TJS resume')
      assert.equal(font.family, 'Selection Latin')
      assert.equal(font.bold, false)
      assert.equal(font.italic, false)
      assert.deepEqual(Buffer.from(font.bytes), bytes)
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().userPaused, true)
      assert.equal(f.session.snapshot().handles, handles)
      assert.deepEqual(f.logs, baselineLogs)
      f.session.resume()
      assert.equal(await f.session.evaluate('pad.fontFace'), 'Selection Latin')
    } finally {
      await f.session.stop()
    }
  })

  test(`A timer can finish its main-window close and nested event round while a host Pad save is open (${mode})`, async () => {
    const clock = frameClock(),
      f = await fixture(
        binary,
        `
System.exitOnWindowClose=true;
class ClosingWindow extends Window {
  function ClosingWindow(){super.Window();visible=true;}
  function finalize(){Debug.message("pad-main-close:finalized");}
}
class Managed {
  function finalize(){Debug.message("pad-main-close:managed");}
}
var win=new ClosingWindow();win.add(new Managed());
var timer=new Timer(function(){
  timer.enabled=false;
  invalidate win;
  Debug.message("pad-main-close:callback");
  System.eventDisabled=false;
  Debug.message("pad-main-close:after-round");
},"");
timer.interval=16;timer.enabled=true;
`,
        { now: clock.now, schedule: clock.schedule },
      )
    try {
      await f.session.idle()
      const save = f.open()
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(f.session.inspectOwnership().modalWaits, 0)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'closing.tjs',
        }).status,
        'accepted',
      )
      const outcome: PadMessage = {
        ...f.identity(),
        kind: 'save-outcome',
        requestId: save.id,
        receipt: f.request().receipt!,
        ok: true,
      }
      clock.advance(16)
      // Observe automatic termination before finally calls stop. The callback's
      // nested empty event round must return before ordinary VM-entry shutdown.
      await until(() => f.session.snapshot().state === 'stopped', 'timer main-window exit')
      assert(f.logs.includes('pad-main-close:finalized'))
      assert(f.logs.includes('pad-main-close:managed'))
      assert(f.logs.includes('pad-main-close:callback'))
      assert(
        f.logs.indexOf('pad-main-close:after-round') > f.logs.indexOf('pad-main-close:callback'),
        'A host save must not cancel the rest of the ordinary timer callback at a nested tail',
      )
      assert.equal(
        f.events.some((event) => event.type === 'state' && event.snapshot.state === 'failed'),
        false,
      )
      assert.equal(f.logs.some((line) => line.includes('Execution cancelled')), false)
      assert.equal(f.session.snapshot().handles, 0)
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      assert.deepEqual(latestPads(f.events).pads, [])
      assert.equal(latestPads(f.events).save, null)
      assert.equal(f.session.pad(outcome).status, 'ignored', 'Stop retires the pending save receipt')
      assert.equal(clock.pending, 0)
    } finally {
      await f.session.stop()
    }
  })

  test(`A Pad download acknowledgement waits for a nested TJS System dialog to release its own native frame (${mode})`, async () => {
    const f = await fixture(binary)
    let pending: Promise<string> | undefined
    try {
      const save = f.open()
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'nested.tjs',
        }).status,
        'accepted',
      )
      const receipt = f.request().receipt!
      pending = f.session.evaluate('System.inform("nested", "Pad child")')
      // Observe rejection immediately as well as in finally, including a test
      // failure before this intentionally suspended native call is released.
      void pending.catch(() => {})
      await until(
        () => f.events.some((event) => event.type === 'system-dialog' && !!event.request),
        'nested system dialog',
      )
      const dialog = f.events.filter((event) => event.type === 'system-dialog').at(-1)
      assert(dialog?.type === 'system-dialog' && dialog.request)
      assert.equal(f.session.inspectOwnership().modalScopes, 2)
      assert.equal(latestPads(f.events).save, null)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt,
          ok: true,
        }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 2)
      const stillOpen = f.events.filter((event) => event.type === 'system-dialog').at(-1)
      assert(stillOpen?.type === 'system-dialog' && stillOpen.request)
      assert.equal(
        stillOpen.request.id,
        dialog.request.id,
        'Finishing the host parent must not cancel its TJS child',
      )
      assert.equal(f.session.selectSystemDialog(dialog.request.id, ''), true)
      await pending
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(latestPads(f.events).save, null)
      assert.equal(await f.session.evaluate('pad.fileName'), 'nested.tjs')
    } finally {
      await f.session.stop()
      await Promise.allSettled(pending ? [pending] : [])
    }
  })

  test(`Pad accepts a completed download acknowledgement after page hiding without resuming the paused VM (${mode})`, async () => {
    const f = await fixture(binary)
    try {
      const save = f.open()
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'hidden.tjs',
        }).status,
        'accepted',
      )
      const outcome: PadMessage = {
        ...f.identity(),
        kind: 'save-outcome',
        requestId: save.id,
        receipt: f.request().receipt!,
        ok: true,
      }
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: true })
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().activity.state, 'hidden')
      assert.equal(f.session.pad(outcome).status, 'accepted')
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().activity.state, 'hidden')
      assert.equal(latestPads(f.events).pads[0]!.fileName, 'hidden.tjs')
      assert.equal(latestPads(f.events).save, null)
      assert.equal(f.session.pad({ ...outcome, seq: outcome.seq + 1 }).status, 'ignored')
    } finally {
      await f.session.stop()
    }
  })

  test(`Pad host save does not enable disabled game timer, continuous or paint callbacks (${mode})`, async () => {
    let now = 0,
      presentations = 0
    const scheduled = new Set<{ at: number; run(): void }>()
    const f = await fixture(
      binary,
      `
System.eventDisabled=true;
var timerCount=0,continuousCount=0,paintCount=0;
var timer=new Timer(function(){global.timerCount++;},"");timer.interval=10;timer.enabled=true;
function continuous(){global.continuousCount++;}
System.addContinuousHandler(continuous);
var win=new Window();win.setInnerSize(4,4);win.visible=true;
var layer=new Layer(win,null);layer.setSize(4,4);layer.visible=true;
layer.onPaint=function(){global.paintCount++;};layer.update();
`,
      {
        now: () => now,
        schedule: (run, delay) => {
          const task = { at: now + delay, run }
          scheduled.add(task)
          return () => {
            scheduled.delete(task)
          }
        },
        renderer: {
          present() {
            presentations++
          },
          dispose() {},
        },
      },
    )
    try {
      const painted = presentations
      now = 100
      for (const task of [...scheduled]) if (task.at <= now && scheduled.delete(task)) task.run()
      const save = f.open()
      assert.equal(f.session.snapshot().eventDisabled, true)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-confirm',
          requestId: save.id,
          fileName: 'disabled.tjs',
        }).status,
        'accepted',
      )
      assert.equal(
        f.session.pad({
          ...f.identity(),
          kind: 'save-outcome',
          requestId: save.id,
          receipt: f.request().receipt!,
          ok: true,
        }).status,
        'accepted',
      )
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(
        await f.session.evaluate(
          '[timerCount,continuousCount,paintCount,System.eventDisabled,pad.fileName].join("|")',
        ),
        '0|0|0|1|disabled.tjs',
      )
      assert.equal(
        presentations,
        painted,
        'Saving must not grant the disabled game a paint checkpoint',
      )
    } finally {
      await f.session.stop()
    }
  })
}

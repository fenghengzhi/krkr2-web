import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var stockWindow=new Window();stockWindow.caption="Stock cursor and hint";
stockWindow.setInnerSize(200,100);stockWindow.visible=true;
var stockRoot=new Layer(stockWindow,null);stockRoot.setSize(200,100);
stockRoot.fillRect(0,0,200,100,0xff203040);stockRoot.cursor=crArrow;stockRoot.hint="root hint";
var stockParent=new Layer(stockWindow,stockRoot);stockParent.setPos(20,10);stockParent.setSize(130,70);
stockParent.fillRect(0,0,130,70,0xff405060);stockParent.visible=true;
stockParent.cursor=crCross;stockParent.hint="parent hint A";
var stockChild=new Layer(stockWindow,stockParent);stockChild.setPos(10,10);stockChild.setSize(70,40);
stockChild.fillRect(0,0,70,40,0xff7090b0);stockChild.visible=true;stockChild.focusable=true;
stockChild.hint="own child";stockChild.showParentHint=true;
var stockCommandCount=0;
function stockCommand(key){
  if(key==65)stockParent.cursor=crIBeam;
  else if(key==66)stockChild.cursor=crDefault;
  else if(key==67)stockParent.cursor=crHandPoint;
  else if(key==72)stockParent.hint="parent hint B";
  else if(key==73)stockChild.showParentHint=false;
  else if(key==74)stockChild.hint="";
  else if(key==75)stockChild.showParentHint=true;
  else if(key==76)stockParent.showParentHint=true;
  else if(key==77)stockChild.hint="own next";
  else if(key==78)stockChild.showParentHint=true;
  else if(key==86)stockChild.setCursorPos(15,12);
  else return;
  global.stockCommandCount++;
  Debug.message("stock-command:"+global.stockCommandCount+":"+key+":"+
    [stockChild.cursor,stockParent.cursor,stockChild.hint,stockChild.showParentHint].join("|"));
}
stockChild.onKeyDown=function(key,shift,process){global.stockCommand(key);};
stockWindow.onMouseMove=function(x,y,shift){Debug.message("stock-move:"+x+","+y);};
stockWindow.onMouseUp=function(x,y,button,shift){Debug.message("stock-up:"+x+","+y);};
stockChild.focus();
`

interface StockCursorEvidence {
  state: number
  move: number
  up: number
  commands: Record<string, number>
  timeline: StockCursorObservation[]
  dropped: number
}
interface StockCursorObservation {
  index: number
  at: number
  wallTime: number
  source: 'dom' | 'session'
  type: string
  generation?: number
  sequence?: number
  windowId?: number
  text?: string
  cursor?: number
  hint?: string
  focusedLayer?: number
  virtualRevision?: number | null
  basePhysicalSequence?: number
  target?: string
  relatedTarget?: string
  activeElement?: string
  documentFocused?: boolean
  visibility?: string
  trusted?: boolean
  clientX?: number
  clientY?: number
  buttons?: number
  bounds?: { x: number; y: number; width: number; height: number }
}
declare global {
  interface Window { stockCursorEvidence: StockCursorEvidence }
}

/** Observe the real event stream without delaying or changing it. Negative
 * latch assertions must follow present(), not merely a log inside a callback. */
async function observePresentation(page: Page) {
  await page.addInitScript(() => {
    const NativeChannel = MessageChannel,
      evidence: StockCursorEvidence = { state: 0, move: 0, up: 0, commands: {}, timeline: [], dropped: 0 }
    window.stockCursorEvidence = evidence
    let index = 0
    const record = (entry: Omit<StockCursorObservation, 'index' | 'at' | 'wallTime'>) => {
      const item = { ...entry, index: ++index, at: performance.now(), wallTime: Date.now() }
      if (evidence.timeline.length < 4096) evidence.timeline.push(item)
      else evidence.dropped++
    }
    const name = (target: EventTarget | null): string => {
      if (target === window) return 'window'
      if (target === document) return 'document'
      if (!(target instanceof Element)) return target === null ? 'null' : 'other'
      const owner = target.closest('[data-window-id]')?.getAttribute('data-window-id')
      return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}${target.classList.length ? `.${[...target.classList].join('.')}` : ''}${owner ? `[window=${owner}]` : ''}`
    }
    const observeDOM = (event: Event) => {
      // Observe only. Do not focus, preventDefault, change pointer ownership,
      // or synthesize a compensating move after a native boundary event.
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-window-id]')
      if (!canvas) return
      const mouse = event instanceof MouseEvent ? event : undefined,
        related = event instanceof MouseEvent || event instanceof FocusEvent ? event.relatedTarget : null,
        bounds = /leave|out|blur|visibilitychange/.test(event.type) ? canvas.getBoundingClientRect() : undefined
      record({
        source: 'dom', type: event.type, target: name(event.target), relatedTarget: name(related),
        activeElement: name(document.activeElement), documentFocused: document.hasFocus(),
        visibility: document.visibilityState, trusted: event.isTrusted,
        ...(mouse ? { clientX: mouse.clientX, clientY: mouse.clientY, buttons: mouse.buttons } : {}),
        ...(bounds ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}),
      })
    }
    for (const type of [
      'mouseenter', 'mouseleave', 'mousemove', 'mousedown', 'mouseup',
      'pointerenter', 'pointerleave', 'pointerover', 'pointerout', 'pointermove', 'pointerdown', 'pointerup',
      'focusin', 'focusout', 'visibilitychange',
    ]) document.addEventListener(type, observeDOM, { capture: true, passive: true })
    window.addEventListener('focus', observeDOM, { passive: true })
    window.addEventListener('blur', observeDOM, { passive: true })
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== 'object') return
          const message = event.data as {
            generation?: number; sequence?: number; windowId?: number; type?: string; text?: string
            input?: {
              cursor?: number; hint?: string; focused?: number
              virtualCursor?: { revision: number; basePhysicalSequence: number } | null
            }
          }
          if (!Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.sequence)) return
          if (message.type === 'state') {
            evidence.state = message.sequence!
            record({ source: 'session', type: message.type, generation: message.generation, sequence: message.sequence })
          }
          if (message.type === 'window-input') record({
            source: 'session', type: message.type, generation: message.generation,
            sequence: message.sequence, windowId: message.windowId,
            cursor: message.input?.cursor, hint: message.input?.hint, focusedLayer: message.input?.focused,
            virtualRevision: message.input?.virtualCursor?.revision ?? null,
            basePhysicalSequence: message.input?.virtualCursor?.basePhysicalSequence,
          })
          if (message.type !== 'log' || typeof message.text !== 'string') return
          if (message.text.startsWith('stock-')) record({
            source: 'session', type: message.type, generation: message.generation,
            sequence: message.sequence, text: message.text,
          })
          if (message.text.startsWith('stock-command:')) evidence.commands[message.text] = message.sequence!
          if (message.text.startsWith('stock-move:')) evidence.move = message.sequence!
          if (message.text.startsWith('stock-up:')) evidence.up = message.sequence!
        })
        return channel
      },
    })
  })
}

async function movePhysical(page: Page, canvas: Locator, x: number, y: number) {
  const before = await page.evaluate(() => window.stockCursorEvidence.move),
    box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * x / 200, box!.y + box!.height * y / 100)
  await expect.poll(() => page.evaluate((previous) => {
    const evidence = window.stockCursorEvidence
    return evidence.move > previous && evidence.state > evidence.move
  }, before)).toBe(true)
}

/** Keep the pointer over the child: using the console's Evaluate button here
 * would leave the canvas and invalidate the native notification scenario. */
function commands(page: Page) {
  let count = 0
  return async (letter: string, state: string) => {
    const message = `stock-command:${++count}:${letter.charCodeAt(0)}:${state}`
    await page.keyboard.press(`Key${letter}`)
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate((text) => {
      const evidence = window.stockCursorEvidence,
        command = evidence.commands[text]
      return command !== undefined && evidence.state > command
    }, message)).toBe(true)
  }
}

async function preserveCleanup(primary: unknown[], cleanup: () => Promise<void>) {
  try { await cleanup() }
  catch (error) {
    if (primary.length) throw new AggregateError([...primary, error], 'Stock cursor/hint scenario and cleanup failed')
    throw error
  }
}

async function finishWithEvidence(page: Page, info: TestInfo, name: string, cleanup: (() => Promise<void>)[]) {
  const failures: unknown[] = []
  // Retain the failure boundary before cleanup changes the game. Evidence
  // collection failure must still permit mouse release and real Stop cleanup.
  try {
    await info.attach(name, {
      contentType: 'application/json',
      body: JSON.stringify(await page.evaluate(() => window.stockCursorEvidence)),
    })
  } catch (error) { failures.push(error) }
  for (const action of cleanup) {
    try { await action() }
    catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Stock input evidence and cleanup failed')
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: stock cursor inheritance updates on native notifications and reaches physical and virtual cursors`, async ({ page }, info) => {
      await observePresentation(page)
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Stock cursor and hint'),
        canvas = surface.locator('canvas[data-window-id]'),
        marker = surface.locator('.game-virtual-cursor'),
        command = commands(page), primary: unknown[] = []
      try {
        await canvas.scrollIntoViewIfNeeded()
        await canvas.focus()
        await expect(surface.locator('.game-text-input')).toBeFocused()
        await movePhysical(page, canvas, 180, 85)
        await expect(canvas).toHaveCSS('cursor', 'default')
        await movePhysical(page, canvas, 35, 25)
        await expect(canvas).toHaveCSS('cursor', 'crosshair')

        // The child's stored ID remains 0. An ancestor setter is not a
        // notification from the current hit Layer, even after a same-hit move.
        await command('A', '0|-4|own child|1')
        await expect(canvas).toHaveCSS('cursor', 'crosshair')
        await movePhysical(page, canvas, 40, 30)
        await expect(canvas).toHaveCSS('cursor', 'crosshair')
        await command('B', '0|-4|own child|1')
        await expect(canvas).toHaveCSS('cursor', 'text')
        await command('C', '0|-21|own child|1')
        await expect(canvas).toHaveCSS('cursor', 'text')
        await movePhysical(page, canvas, 180, 85)
        await expect(canvas).toHaveCSS('cursor', 'default')
        await movePhysical(page, canvas, 35, 25)
        await expect(canvas).toHaveCSS('cursor', 'pointer')

        // A script cursor move shares the same effective cursor latch. Changing
        // appearance never changes the 075 marker's position or write identity.
        await command('V', '0|-21|own child|1')
        await expect(marker).toBeVisible()
        await expect(marker).toHaveAttribute('data-cursor-shape', 'pointer')
        await expect(canvas).toHaveCSS('cursor', 'none')
        const revision = await marker.getAttribute('data-cursor-revision')
        expect(Number(revision)).toBeGreaterThan(0)
        await command('A', '0|-4|own child|1')
        await expect(marker).toHaveAttribute('data-cursor-shape', 'pointer')
        await command('B', '0|-4|own child|1')
        await expect(marker).toHaveAttribute('data-cursor-shape', 'text')
        await expect(marker).toHaveAttribute('data-cursor-revision', revision!)
        await movePhysical(page, canvas, 55, 35)
        await expect(marker).toHaveCount(0)
        await expect(canvas).toHaveCSS('cursor', 'text')
        await info.attach('stock-cursor-native-notifications', {
          contentType: 'application/json',
          body: JSON.stringify({ backend, binary, revision, physical: 'text', storedChildCursor: 0 }),
        })
      } catch (error) { primary.push(error); throw error }
      finally { await preserveCleanup(primary, () => finishWithEvidence(
        page, info, 'stock-cursor-passive-input-timeline', [() => game.stop()],
      )) }
    })

    test(`${variant}: hint assignment and showParentHint preserve native inheritance and refresh timing`, async ({ page }, info) => {
      await observePresentation(page)
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Stock cursor and hint'),
        canvas = surface.locator('canvas[data-window-id]'),
        command = commands(page), primary: unknown[] = []
      let pressed = false
      const reenter = async () => {
        await movePhysical(page, canvas, 180, 85)
        await expect(canvas).toHaveAttribute('title', 'root hint')
        await movePhysical(page, canvas, 35, 25)
      }
      try {
        await canvas.scrollIntoViewIfNeeded()
        await canvas.focus()
        await expect(surface.locator('.game-text-input')).toBeFocused()
        await reenter()
        // showParentHint skips even a nonempty local hint. Its getter still
        // returns that local text; the setter does not publish a new hint.
        await expect(canvas).toHaveAttribute('title', 'parent hint A')
        await command('H', '0|-3|own child|1')
        await expect(canvas).toHaveAttribute('title', 'parent hint A')
        await movePhysical(page, canvas, 40, 30)
        await expect(canvas).toHaveAttribute('title', 'parent hint A')
        await command('I', '0|-3|own child|0')
        await expect(canvas).toHaveAttribute('title', 'parent hint A')
        await reenter()
        await expect(canvas).toHaveAttribute('title', 'own child')

        // A hint assignment always clears showParentHint, including the empty
        // string. Re-enabling inheritance waits until the next native enter.
        await command('J', '0|-3||0')
        await expect(canvas).toHaveAttribute('title', '')
        await command('K', '0|-3||1')
        await expect(canvas).toHaveAttribute('title', '')
        await movePhysical(page, canvas, 40, 30)
        await expect(canvas).toHaveAttribute('title', '')
        await reenter()
        await expect(canvas).toHaveAttribute('title', 'parent hint B')
        await command('L', '0|-3||1')
        await expect(canvas).toHaveAttribute('title', 'parent hint B')
        await reenter()
        await expect(canvas).toHaveAttribute('title', 'root hint')

        await command('M', '0|-3|own next|0')
        await expect(canvas).toHaveAttribute('title', 'own next')
        await command('N', '0|-3|own next|1')
        await expect(canvas).toHaveAttribute('title', 'own next')
        await page.mouse.down()
        pressed = true
        await expect(canvas).toHaveAttribute('title', '')
        const beforeUp = await page.evaluate(() => window.stockCursorEvidence.up)
        await page.mouse.up()
        pressed = false
        await expect.poll(() => page.evaluate((previous) => {
          const evidence = window.stockCursorEvidence
          return evidence.up > previous && evidence.state > evidence.up
        }, beforeUp)).toBe(true)
        await expect(canvas).toHaveAttribute('title', '')
        await reenter()
        await expect(canvas).toHaveAttribute('title', 'root hint')
        await info.attach('stock-hint-native-notifications', {
          contentType: 'application/json',
          body: JSON.stringify({ backend, binary, localHint: 'own next', showParentHint: true, presentedHint: 'root hint' }),
        })
      } catch (error) { primary.push(error); throw error }
      finally { await preserveCleanup(primary, () => finishWithEvidence(
        page, info, 'stock-hint-passive-input-timeline', [
          ...(pressed ? [() => page.mouse.up()] : []), () => game.stop(),
        ],
      )) }
    })
  }
}

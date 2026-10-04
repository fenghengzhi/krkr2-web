import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var mouseWindow=new Window();mouseWindow.caption="Mouse geometry";
mouseWindow.setInnerSize(200,100);mouseWindow.setPos(60,40);mouseWindow.setZoom(1,2);mouseWindow.setLayerPos(3,-3);mouseWindow.visible=true;
var mouseRoot=new Layer(mouseWindow,null);mouseRoot.setSize(101,103);
mouseRoot.fillRect(0,0,101,103,0xff203040);
var mouseChild=new Layer(mouseWindow,mouseRoot);mouseChild.setPos(10,6);mouseChild.setSize(80,80);
mouseChild.fillRect(0,0,80,80,0xff80a0c0);mouseChild.visible=true;
var mouseOrder=[],mouseDragging=false;
function mouseRecord(kind,x,y){
  global.mouseOrder.add(kind+":"+x+","+y);
  Debug.message("mouse-event:"+kind+":"+x+","+y);
}
mouseWindow.onMouseMove=function(x,y,shift){global.mouseRecord("window-move",x,y);};
mouseChild.onMouseMove=function(x,y,shift){global.mouseRecord("layer-move",x,y);};
mouseWindow.onMouseDown=function(x,y,button,shift){
  global.mouseOrder.clear();global.mouseRecord("window-down",x,y);
  global.mouseWindow.setZoom(2,3);global.mouseWindow.setLayerPos(-3,5);
};
mouseChild.onMouseDown=function(x,y,button,shift){
  global.mouseRecord("layer-down",x,y);global.mouseDragging=true;
  Debug.message("mouse-down-order:"+global.mouseOrder.join("|"));
};
mouseWindow.onMouseUp=function(x,y,button,shift){global.mouseRecord("window-up",x,y);};
mouseChild.onMouseUp=function(x,y,button,shift){global.mouseRecord("layer-up",x,y);global.mouseDragging=false;};
var mouseWitness=new Window();mouseWitness.caption="Mouse witness";mouseWitness.setInnerSize(50,40);mouseWitness.setPos(520,0);mouseWitness.visible=true;
var witnessRoot=new Layer(mouseWitness,null);witnessRoot.setSize(50,40);
`

interface MouseGeometryEvents { state: number; logs: Record<string, number> }
declare global { interface Window { mouseGeometryEvents: MouseGeometryEvents } }

/** Passive receipt of the real Session stream. The state following a callback
 * log is after present(), so the next physical packet observes the new view. */
async function observePresentation(page: Page) {
  await page.addInitScript(() => {
    const NativeChannel = MessageChannel,
      evidence: MouseGeometryEvents = { state: 0, logs: {} }
    window.mouseGeometryEvents = evidence
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!event.data || typeof event.data !== 'object') return
          const message = event.data as { generation?: number; sequence?: number; type?: string; text?: string }
          if (!Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.sequence)) return
          if (message.type === 'state') evidence.state = message.sequence!
          if (message.type === 'log' && typeof message.text === 'string' && message.text.startsWith('mouse-'))
            evidence.logs[message.text] = message.sequence!
        })
        return channel
      },
    })
  })
}

async function presentedLog(page: Page, text: string) {
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate((text) => {
    const evidence = window.mouseGeometryEvents, sequence = evidence.logs[text]
    return sequence !== undefined && evidence.state > sequence
  }, text)).toBe(true)
}

/** Select an integer viewport position whose raw logical coordinate truncates
 * to the requested client pixel. Negative capture positions use (-n-1,-n].
 * This avoids accepting a neighboring oracle value due to CSS/MouseEvent
 * rounding, while still dispatching actual browser mouse events. */
async function moveToClientPixel(page: Page, canvas: Locator, x: number, y: number) {
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  const sample = (origin: number, extent: number, logical: number, pixel: number) => {
    const scale = extent / logical,
      first = pixel < 0 ? Math.floor(origin + (pixel - 1) * scale) + 1 : Math.ceil(origin + pixel * scale),
      last = pixel < 0 ? Math.floor(origin + pixel * scale) : Math.ceil(origin + (pixel + 1) * scale) - 1
    expect(last, 'The logical pixel must contain an integer viewport position').toBeGreaterThanOrEqual(first)
    return Math.round((first + last) / 2)
  }
  await page.mouse.move(sample(bounds!.x, bounds!.width, 200, x), sample(bounds!.y, bounds!.height, 100, y))
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    test(`${backend}/${binary ? 'bytecode' : 'source'}: real drag preserves captured PaintBox coordinates across a Window callback transform`, async ({ page }, info) => {
      await observePresentation(page)
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Mouse geometry'),
        canvas = surface.locator('canvas[data-window-id]'),
        failures: unknown[] = []
      let pressed = false
      try {
        // Floating placement leaves viewport room for negative captured points;
        // doubled CSS width gives each logical pixel representable mouse samples.
        await page.addStyleTag({ content: '.game-window[aria-label="Mouse geometry"] { width: 400px !important; }' })
        await canvas.scrollIntoViewIfNeeded()
        // Root (101,103), zoom 1/2 => destination (51,52), origin (2,-2).
        // Raw client integer (20,15) => PaintBox (18,17) => primary (35,33).
        await moveToClientPixel(page, canvas, 20, 15)
        await presentedLog(page, 'mouse-event:window-move:18,17')
        await presentedLog(page, 'mouse-event:layer-move:25,27')
        await page.mouse.down()
        pressed = true
        // Window onMouseDown changes zoom to 2/3 and origin to (-3,5).
        // DrawDevice uses NEW dimensions (67,69), but the OLD captured (18,17):
        // primary (27,25), child-local (17,19). It does not synthesize a move.
        await presentedLog(page, 'mouse-down-order:window-down:18,17|layer-down:17,19')

        // The next real packet uses new MulDiv origin (-2,3). Capture keeps
        // delivering outside the surface: (-12,-8) -> (-10,-11) -> (-15,-16).
        await moveToClientPixel(page, canvas, -12, -8)
        await presentedLog(page, 'mouse-event:window-move:-10,-11')
        await presentedLog(page, 'mouse-event:layer-move:-25,-22')
        await page.mouse.up()
        pressed = false
        await presentedLog(page, 'mouse-event:window-up:-10,-11')
        await presentedLog(page, 'mouse-event:layer-up:-25,-22')
        await info.attach('mouse-manager-coordinate-receipts', {
          contentType: 'application/json',
          body: JSON.stringify({
            backend, binary, primarySize: [101, 103], initialDestSize: [51, 52], changedDestSize: [67, 69],
            events: await page.evaluate(() => window.mouseGeometryEvents),
          }),
        })
      } catch (error) { failures.push(error); throw error }
      finally {
        try {
          if (pressed) await page.mouse.up()
          await game.stop()
        } catch (error) {
          if (failures.length) throw new AggregateError([...failures, error], 'Mouse manager scenario and cleanup failed')
          throw error
        }
      }
    })
  }
}

import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchPads, observePads, padSource, padSurface } from '../helpers/web-pad.ts'
import { finishComposition, startComposition } from '../helpers/web-window-attention.ts'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { centralRecords } from '../helpers/zip-fixtures.ts'

async function fontFiles() {
  return Promise.all(
    ['latin.ttf', 'mono.ttf'].map(async (name) => ({
      name,
      mimeType: 'font/ttf',
      buffer: await readFile(`tests/fixtures/font-selection/${name}`),
    })),
  )
}

async function movePointer(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  resizeGrip = false,
) {
  await target.scrollIntoViewIfNeeded()
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  // A resize grip is clipped to its lower-right triangle. Its box center is
  // exactly on the diagonal, so use a strict interior point across browsers.
  const x = bounds!.x + (resizeGrip ? bounds!.width * 0.75 : Math.min(12, bounds!.width / 2)),
    y = bounds!.y + bounds!.height * (resizeGrip ? 0.75 : 0.5)
  expect(
    await target.evaluate(
      (element, point) => {
        const hit = element.ownerDocument.elementFromPoint(point.x, point.y)
        return hit !== null && (hit === element || element.contains(hit))
      },
      { x, y },
    ),
    'The drag origin must hit its intended Pad control',
  ).toBe(true)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy)
  await page.mouse.up()
}

/** These are explicit DOM composition events, not a claim of OS IME automation. */
async function staleComposition(text: Locator, value: string) {
  await finishComposition(text, value)
  await expect(text).not.toHaveValue(value)
}

const gameSource = String.raw`
var padKeys=[],padTextKeys="",padFlow="";
class PadGameWindow extends Window {
  function PadGameWindow(){super.Window();caption="Pad game";setInnerSize(180,90);setPos(0,260);visible=true;}
  function onKeyDown(key,shift){global.padKeys.add(key);Debug.message("pad-game-key:"+key);}
  function onKeyPress(key){global.padTextKeys+=key;}
  function onMouseDown(){
    var flow=global.padFlow;global.padFlow="";
    if(flow=="window")global.padModal.showModal();
    if(flow=="system")System.inputString("Pad system input","Pads are blocked during this request.","");
    if(flow=="font")global.padLayer.font.doUserSelect(fsfTrueTypeOnly,"Pad font request","Choose a font","AV");
    if(flow=="clipboard"){try{var ignored=Clipboard.asText;}catch(error){Debug.message("pad-clipboard-cancelled");}}
    if(flow!="")Debug.message("pad-modal-return:"+flow);
  }
}
var padGame=new PadGameWindow(),padLayer=new Layer(padGame,null);
padLayer.type=ltOpaque;padLayer.setSize(180,90);padLayer.fillRect(0,0,180,90,0xff305070);padLayer.focusable=true;padLayer.focus();
var padModal=new Window(),padModalLayer=new Layer(padModal,null);
padModal.caption="Pad modal child";padModal.setInnerSize(160,90);padModal.setPos(210,260);
padModalLayer.type=ltOpaque;padModalLayer.setSize(160,90);padModalLayer.fillRect(0,0,160,90,0xff704030);
`

// Pad surfaces run sequentially within this file. Real clipboard content
// cases register in clipboard.spec.ts alongside every other real API case.
test.describe.configure({ mode: 'default' })

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: independent Pad editors preserve native fontColor behavior and script writes to readonly text`, async ({
      page,
    }) => {
      const game = await launchPads(page, backend, binary, padSource),
        first = padSurface(page, 'First pad'),
        second = padSurface(page, 'Second pad'),
        text = first.locator('textarea')
      try {
        await expect(page.locator('.game-pad')).toHaveCount(2)
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await evaluate(
          page,
          '(global.Window.mainWindow===null)+","+(first instanceof "Pad")+","+(first instanceof "Window")',
          '1,1,0',
        )
        await text.fill('编辑 😀\nsecond line')
        await second.locator('textarea').fill('independent')
        await evaluate(
          page,
          'first.text=="编辑 😀\\r\\nsecond line" && second.text=="independent"',
          '1',
        )
        await evaluate(
          page,
          '(first.color=0x123456,first.fontColor=0xaabbcc,first.fontHeight=20,first.fontBold=1,first.fontItalic=1,first.fontUnderline=1,first.fontStrikeOut=1,first.wordWrap=true,first.showScrollBars=2,first.statusText="<b>status</b>",first.opacity=128,first.readOnly=true,[first.fontColor,first.color,first.fontSize,first.opacity].join(","))',
          '1193046,1193046,15,255',
        )
        await expect(text).toHaveCSS('color', 'rgb(170, 187, 204)')
        await expect(text).toHaveCSS('background-color', 'rgb(18, 52, 86)')
        await expect(text).toHaveCSS('font-size', '20px')
        await expect(text).toHaveCSS('font-weight', '700')
        await expect(text).toHaveCSS('font-style', 'italic')
        await expect(text).toHaveCSS('text-decoration-line', 'underline line-through')
        await expect(text).toHaveAttribute('wrap', 'soft')
        await expect(text).toHaveCSS('overflow-x', 'hidden')
        await expect(text).toHaveCSS('overflow-y', 'scroll')
        await expect(first).toHaveCSS('opacity', '1')
        await expect(first.locator('.game-pad-status')).toHaveText('<b>status</b>')
        await expect(first.locator('.game-pad-status b')).toHaveCount(0)
        await expect(first.locator('[data-action="execute"]')).toBeDisabled()
        await text.click()
        await page.keyboard.press('End')
        await page.keyboard.type('cannot edit')
        await expect(text).toHaveValue('编辑 😀\nsecond line')
        await first.locator('[data-action="menu"]').click()
        for (const action of ['cut', 'paste', 'undo', 'redo'])
          await expect(first.locator(`[data-action="${action}"]`)).toBeDisabled()
        await expect(first.locator('[data-action="copy"]')).toBeEnabled()
        await evaluate(
          page,
          '(first.text="script replacement\\nnext",first.showStatusBar=false,first.text)',
          'script replacement\r\nnext',
        )
        await expect(text).toHaveValue('script replacement\nnext')
        await expect(first.locator('.game-pad-footer')).toHaveCSS('visibility', 'hidden')
        await expect(second.locator('textarea')).toHaveValue('independent')
        await expect(second.locator('textarea')).toHaveCSS('color', 'rgb(255, 255, 255)')
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: Pad uses a registered game font with actual glyph metrics`, async ({
      page,
    }) => {
      const game = await launchPads(
          page,
          backend,
          binary,
          padSource + '\nfirst.fontFace="Selection Latin";first.fontHeight=20;',
          await fontFiles(),
        ),
        first = padSurface(page, 'First pad'),
        text = first.locator('textarea')
      try {
        await expect(first).toHaveAttribute('data-font-state', 'ready')
        await expect
          .poll(() =>
            text.evaluate((element) => {
              const style = getComputedStyle(element),
                canvas = document.createElement('canvas'),
                context = canvas.getContext('2d')!
              context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
              return context.measureText('A').width
            }),
          )
          .toBeCloseTo(10, 1)
        await evaluate(page, 'first.fontFace+","+first.fontHeight', 'Selection Latin,20')
        await expect(padSurface(page, 'Second pad').locator('textarea')).toHaveCSS(
          'font-size',
          '12px',
        )
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: Pad geometry, close and restore preserve each native instance`, async ({
      page,
    }) => {
      const game = await launchPads(page, backend, binary, padSource),
        first = padSurface(page, 'First pad'),
        second = padSurface(page, 'Second pad')
      const expectActiveEditor = async () => {
        await expect(first.locator('textarea')).toBeFocused()
        const firstOrder = await first.evaluate((element) =>
            Number(getComputedStyle(element).zIndex),
          ),
          secondOrder = await second.evaluate((element) => Number(getComputedStyle(element).zIndex))
        expect(firstOrder).toBeGreaterThan(secondOrder)
      }
      try {
        await movePointer(page, first.locator('.game-pad-header'), 31, 17)
        await expectActiveEditor()
        await evaluate(page, 'first.left+","+first.top', '31,17')
        // Resize must activate its owner independently of the preceding drag.
        await second.locator('textarea').click()
        await expect(second.locator('textarea')).toBeFocused()
        await movePointer(page, first.locator('.game-pad-resize'), 29, 23, true)
        await expectActiveEditor()
        await evaluate(page, 'first.width+","+first.height', '349,243')
        await first.locator('[data-action="close"]').click()
        await expect(first).toBeHidden()
        await evaluate(
          page,
          '(isvalid first)+","+first.visible+","+first.text+","+second.visible',
          '1,0,first,1',
        )
        await evaluate(
          page,
          '(first.text="hidden script edit",first.visible=true,first.width=60,first.height=90,[first.width,first.height].join(","))',
          '60,90',
        )
        await expect(first).toHaveCSS('width', '60px')
        await expect(first).toHaveCSS('height', '90px')
        await evaluate(
          page,
          '(first.width=320,first.height=220,first.borderStyle=3,first.visible)',
          '1',
        )
        await expect(first.locator('.game-pad-resize')).toBeHidden()
        await expect(first.locator('textarea')).toHaveValue('hidden script edit')
        await expect(first).toHaveAttribute('data-blocked', 'false')
        await expect(padSurface(page, 'Second pad').locator('textarea')).toHaveValue('second')
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: Pad editing and stale composition stay isolated from a trapping game Window`, async ({
      page,
    }) => {
      const game = await launchPads(
          page,
          backend,
          binary,
          padSource + gameSource + '\npadGame.trapKey=true;',
        ),
        first = padSurface(page, 'First pad'),
        text = first.locator('textarea'),
        surface = page.locator('.game-window[aria-label="Pad game"]')
      try {
        await surface.locator('canvas').click({ position: { x: 8, y: 8 } })
        await page.keyboard.press('a')
        await expect(page.getByText('pad-game-key:65', { exact: true })).toBeVisible()
        await text.fill('')
        await page.keyboard.type('Pad only')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')
        await page.keyboard.insertText('雪😀')
        await evaluate(
          page,
          'first.text=="Pad only\\t\\r\\n雪😀" && padKeys.join(",")=="65" && padTextKeys=="a"',
          '1',
        )
        await text.click()
        await startComposition(text, 'uncommitted 仮')
        await evaluate(page, '(first.text="replacement\\nkept",1)', '1')
        await expect(text).toHaveValue('replacement\nkept')
        await staleComposition(text, 'stale 仮')
        await expect(text).toHaveValue('replacement\nkept')
        await evaluate(page, 'first.text=="replacement\\r\\nkept" && padKeys.join(",")=="65"', '1')
        await text.click()
        await startComposition(text, '確定 😀')
        await finishComposition(text, '確定 😀')
        await evaluate(page, 'first.text+","+second.text', '確定 😀,second')
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: a throwing native Pad finalizer retains its editor until successful retry`, async ({
      page,
    }) => {
      const game = await launchPads(
          page,
          backend,
          binary,
          String.raw`
System.exitOnWindowClose=false;var padFinals=0;
class RetryPad extends Pad {
  function RetryPad(){super.Pad();title="Retry pad";text="alive";visible=true;}
  function finalize(){global.padFinals++;text="finalizer "+global.padFinals;if(global.padFinals==1)throw "Pad finalizer retry";}
}
var retryPad=new RetryPad();
`,
        ),
        pad = padSurface(page, 'Retry pad')
      try {
        await evaluate(
          page,
          '(function(){try{invalidate retryPad;}catch(error){}return [isvalid retryPad,padFinals,retryPad.text].join(",");})()',
          '1,1,finalizer 1',
        )
        await expect(pad).toBeVisible()
        await expect(pad.locator('textarea')).toHaveValue('finalizer 1')
        await pad.locator('textarea').fill('user edit after failure')
        await evaluate(page, 'retryPad.text', 'user edit after failure')
        await evaluate(
          page,
          '(function(){invalidate retryPad;return [isvalid retryPad,padFinals].join(",");})()',
          '0,2',
        )
        await expect(page.locator('.game-pad')).toHaveCount(0)
      } finally {
        await game.stop()
      }
    })

    for (const flow of ['window', 'system', 'font', 'clipboard'] as const) {
      test(`${variant}: ${flow} modal blocks all Pad input and restores editability`, async ({
        page,
      }) => {
        const game = await launchPads(
            page,
            backend,
            binary,
            padSource + gameSource + `\npadFlow="${flow}";`,
            flow === 'font' ? await fontFiles() : [],
          ),
          first = padSurface(page, 'First pad'),
          second = padSurface(page, 'Second pad'),
          surface = page.locator('.game-window[aria-label="Pad game"]')
        try {
          await first.locator('textarea').fill('before modal')
          await surface.locator('canvas').click({ position: { x: 8, y: 8 } })
          await expect(first).toHaveAttribute('data-blocked', 'true')
          await expect(second).toHaveAttribute('data-blocked', 'true')
          expect(await first.evaluate((element) => (element as HTMLElement).inert)).toBe(true)
          await expect(first.locator('[data-action="save"]')).toBeDisabled()
          // Synthetic delivery exercises the adapter's stale-event guard even
          // though inert prevents physical focus/input in the real browser.
          await first.locator('textarea').evaluate((element) => {
            const text = element as HTMLTextAreaElement
            text.value = 'blocked injected edit'
            text.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }))
          })
          if (flow === 'window')
            await page
              .locator('.game-window[aria-label="Pad modal child"]')
              .getByRole('button', { name: '关闭游戏窗口', exact: true })
              .click()
          else if (flow === 'system')
            await page
              .getByRole('dialog', { name: 'Pad system input', exact: true })
              .getByRole('button', { name: '取消', exact: true })
              .click()
          else if (flow === 'font')
            await page
              .getByRole('dialog', { name: 'Pad font request', exact: true })
              .getByRole('button', { name: '取消', exact: true })
              .click()
          else
            await page
              .locator('.game-clipboard')
              .getByRole('button', { name: '取消', exact: true })
              .click()
          await expect(page.getByText(`pad-modal-return:${flow}`, { exact: true })).toBeVisible()
          await expect(first).toHaveAttribute('data-blocked', 'false')
          await expect(second).toHaveAttribute('data-blocked', 'false')
          await expect(first.locator('textarea')).toHaveValue('before modal')
          await first.locator('textarea').fill('after modal')
          await evaluate(page, 'first.text+","+second.text', 'after modal,second')
        } finally {
          await game.stop()
        }
      })
    }

    test(`${variant}: Pad downloads real UTF-8 CRLF bytes and readonly cancellation preserves fileName`, async ({
      page,
    }, info) => {
      const game = await launchPads(
          page,
          backend,
          binary,
          padSource +
            String.raw`
first.text="UTF-8 雪😀\nsecond\rthird\r\n";first.fileName="C:\\source\\old-name.tjs";first.readOnly=true;
`,
        ),
        first = padSurface(page, 'First pad'),
        save = page.getByRole('dialog', { name: '保存 Pad 文本', exact: true }),
        downloads: string[] = []
      page.on('download', (download) => downloads.push(download.suggestedFilename()))
      try {
        await first.locator('[data-action="save"]').click()
        await expect(save.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue(
          'old-name.tjs',
        )
        await expect(save).toContainText('UTF-8 · CRLF 换行 · 无 BOM')
        await save.getByRole('textbox').fill('cancelled.txt')
        await save.getByRole('button', { name: '取消', exact: true }).click()
        await expect(save).toHaveCount(0)
        await evaluate(
          page,
          'first.fileName=="C:\\\\source\\\\old-name.tjs" && first.readOnly',
          '1',
        )
        expect(downloads).toEqual([])
        await first.locator('textarea').click()
        await page.keyboard.press('ControlOrMeta+s')
        await expect(save).toBeVisible()
        await save.getByRole('textbox').fill('browser-result')
        const received = page.waitForEvent('download')
        await save.getByRole('button', { name: '下载', exact: true }).click()
        const download = await received
        expect(download.suggestedFilename()).toBe('browser-result.tjs')
        expect(await download.failure()).toBeNull()
        const path = await download.path()
        expect(path).not.toBeNull()
        const exported = await readFile(path!)
        await info.attach('pad-export.tjs', {
          body: exported,
          contentType: 'text/plain;charset=utf-8',
        })
        expect(exported).toEqual(Buffer.from('UTF-8 雪😀\r\nsecond\rthird\r\n', 'utf8'))
        await expect(save).toHaveCount(0)
        await evaluate(
          page,
          '[first.fileName,first.readOnly,second.fileName].join(",")',
          'browser-result.tjs,1,',
        )
        expect(downloads).toEqual(['browser-result.tjs'])
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: Pad downloads the admitted snapshot after a suspended Timer replaces the live text`, async ({
      page,
    }, info) => {
      const game = observePads(page),
        bytes = remoteArchive('zip'),
        late = centralRecords(bytes).records.find((entry) => entry.name === 'late.tjs')!
      let armed = false,
        held = 0,
        release: (() => void) | undefined
      const server = await httpServer({
        '/pad.zip': {
          bytes,
          etag: '"pad-snapshot-v1"',
          intercept(request, response) {
            const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
            if (!armed || !range || request.method !== 'GET') return false
            const from = Number(range[1]),
              to = Math.min(bytes.length - 1, Number(range[2]))
            if (from > late.data || to < late.data) return false
            held++
            release = () => {
              armed = false
              response.writeHead(206, {
                ETag: '"pad-snapshot-v1"',
                'Content-Range': `bytes ${from}-${to}/${bytes.length}`,
                'Content-Length': to - from + 1,
              })
              response.end(bytes.subarray(from, to + 1))
              release = undefined
            }
            return true
          },
        },
      })
      try {
        await page.addInitScript(() => {
          const original = Worker.prototype.postMessage,
            observed: string[] = []
          Object.assign(window, { padSaveAcks: observed })
          Worker.prototype.postMessage = function (
            message: unknown,
            transferOrOptions?: Transferable[] | StructuredSerializeOptions,
          ) {
            const request = message as {
                id?: string
                type?: string
                argumentList?: { value?: unknown }[]
              },
              packet = request.argumentList?.[1]?.value as { kind?: string } | undefined
            if (
              request.type === 'APPLY' &&
              request.argumentList?.[0]?.value === 'pad' &&
              packet?.kind === 'save-open'
            ) {
              const listener = (event: MessageEvent) => {
                const result = event.data as { id?: string; value?: { status?: unknown } }
                if (result.id !== request.id) return
                this.removeEventListener('message', listener)
                observed.push(String(result.value?.status))
              }
              this.addEventListener('message', listener)
            }
            // Observe actual acknowledgement without delaying, replacing, or
            // injecting any RPC, payload, VM result or download implementation.
            return Reflect.apply(original, this, [message, transferOrOptions])
          }
        })
        await page.goto(`/?backend=${backend}`)
        test.skip(
          backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
          'JSPI unavailable',
        )
        await page.locator('#remote-url').fill(server.url + '/pad.zip')
        await page.locator('#load-url').click()
        await expect(page.getByText('zip-ready:42:0', { exact: true })).toBeVisible()
        const script =
          `w.visible=false;\n${padSource}\n` +
          String.raw`
first.text="admitted 雪😀\nsecond";first.readOnly=true;
function padDeferredMutation(){
  global.padTimer.enabled=false;
  var lines=[];lines.load("late.tjs","utf-8");
  global.first.text="changed after save admission";
  Debug.message("pad-snapshot-mutation:"+lines[0]);
}
var padTimer=new Timer(global,"padDeferredMutation");padTimer.interval=10;
`
        await evaluate(
          page,
          binary
            ? `(function(){var code=[${JSON.stringify(script)}];code.save("savedata/pad-snapshot.tjs","utf-8");Scripts.compileStorage("savedata/pad-snapshot.tjs","savedata/pad-snapshot.cjs",false,true,false);Scripts.execStorage("savedata/pad-snapshot.cjs");return 1;})()`
            : `(function(){Scripts.exec(${JSON.stringify(script)});return 1;})()`,
          '1',
        )
        armed = true
        // The timer may start inside the command's outer checkpoint. Do not
        // wait for that command's completion while its actual I/O is held.
        await page.locator('#expression').fill('padTimer.enabled=true')
        await page.locator('#evaluate').click()
        await expect.poll(() => held).toBe(1)
        const first = padSurface(page, 'First pad'),
          save = page.getByRole('dialog', { name: '保存 Pad 文本', exact: true })
        await first.locator('[data-action="save"]').click()
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { padSaveAcks: string[] }).padSaveAcks),
          )
          .toEqual(['accepted'])
        await info.attach('pad-save-admitted-before-storage-completion.json', {
          body: JSON.stringify(
            {
              acks: await page.evaluate(
                () => (window as unknown as { padSaveAcks: string[] }).padSaveAcks,
              ),
              storagePending: !!release,
              requests: server.requests,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        })
        expect(release).toBeDefined()
        release!()
        await expect(page.getByText('pad-snapshot-mutation:73', { exact: true })).toBeVisible()
        await expect(save).toBeVisible()
        await expect(first.locator('textarea')).toHaveValue('changed after save admission')
        const received = page.waitForEvent('download')
        await save.getByRole('button', { name: '下载', exact: true }).click()
        const download = await received
        expect(await download.failure()).toBeNull()
        const path = await download.path()
        expect(path).not.toBeNull()
        const exported = await readFile(path!)
        await info.attach('pad-snapshot-export.tjs', {
          body: exported,
          contentType: 'text/plain;charset=utf-8',
        })
        expect(exported).toEqual(Buffer.from('admitted 雪😀\r\nsecond', 'utf8'))
        await expect(save).toHaveCount(0)
        await evaluate(page, 'first.text+","+second.text', 'changed after save admission,second')
      } finally {
        release?.()
        try {
          await game.stop()
        } finally {
          await server.close()
        }
      }
    })

    test(`${variant}: stopping a pending Pad save retires its UI and permits a fresh session`, async ({
      page,
    }) => {
      const game = await launchPads(page, backend, binary, padSource),
        first = padSurface(page, 'First pad'),
        save = page.getByRole('dialog', { name: '保存 Pad 文本', exact: true }),
        downloads: string[] = []
      page.on('download', (download) => downloads.push(download.suggestedFilename()))
      await first.locator('textarea').fill('unsaved')
      await first.locator('[data-action="save"]').click()
      await expect(save).toBeVisible()
      const retired = await save.getByRole('button', { name: '下载', exact: true }).elementHandle(),
        retiredStop = await save
          .getByRole('button', { name: '停止游戏', exact: true })
          .elementHandle()
      await save.getByRole('button', { name: '停止游戏', exact: true }).click()
      await game.stopped()
      const fresh = await launchPads(
        page,
        backend,
        binary,
        padSource + '\nfirst.text="fresh session";',
        [],
        true,
      )
      try {
        // Stop disables and detaches these buttons. Native .click() is a no-op
        // on a disabled button, so first verify retirement, then explicitly
        // deliver each stale event through the listener that owns the action.
        for (const old of [retired, retiredStop]) {
          expect(
            await old!.evaluate((element) => ({
              connected: element.isConnected,
              disabled: (element as HTMLButtonElement).disabled,
            })),
          ).toEqual({ connected: false, disabled: true })
        }
        // Save is handled by the form's submit listener, not button click.
        expect(
          await retired!.evaluate((element) => {
            const form = element.closest('form')
            if (!form) throw new Error('Retired Pad confirmation lost its form')
            return form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          }),
        ).toBe(false)
        await retiredStop!.evaluate((element) =>
          element.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
            }),
          ),
        )
        await evaluate(page, 'first.text+","+second.text', 'fresh session,second')
        await expect(page.locator('.game-pad')).toHaveCount(2)
        await expect(page.locator('.game-pad-save')).toHaveCount(0)
        expect(downloads).toEqual([])
      } finally {
        await retired?.dispose()
        await retiredStop?.dispose()
        await fresh.stop()
      }
    })
  }
}

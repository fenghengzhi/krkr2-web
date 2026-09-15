import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { centralRecords } from '../helpers/zip-fixtures.ts'

type Flow = 'inform' | 'input' | 'nested'

const source = String.raw`
System.exitOnWindowClose=false;
var dialogFlow="inform",dialogTrace=[],dialogCalls=0,dialogKeys=0,dialogMenus=0,dialogTimers=0;
function dialogMark(value){dialogTrace.add(value);Debug.message("system-dialog-proof:"+value);}
class DialogWindow extends Window {
  function DialogWindow(){super.Window();caption="System dialog owner";setInnerSize(180,100);setPos(0,0);visible=true;}
  function onMouseDown(){
    global.dialogCalls++;global.dialogMark("before:"+global.dialogCalls);
    global.dialogClock.enabled=true;
    if(global.dialogFlow=="inform"){
      var result=System.inform("The Timer continues while this message is open.","Message proof");
      global.dialogMark("inform-return:"+typeof result);
    }else if(global.dialogFlow=="input"){
      var unicode=System.inputString("Unicode input","请输入名字 <b>文字</b>","初期値");
      global.dialogMark("unicode-return:"+typeof unicode+":"+unicode);
      var empty=System.inputString("Empty input","An empty confirmation is still a string.","remove me");
      global.dialogMark("empty-return:"+typeof empty+":"+empty.length);
      var cancel=System.inputString("Cancel input","Escape cancels this input.","cancel me");
      global.dialogMark("cancel-return:"+typeof cancel);
      var button=System.inputString("Cancel button","The cancel button also returns void.","unchanged");
      global.dialogMark("button-return:"+typeof button);
    }else{
      var parent=System.inputString("Parent input","Keep this edit while the Timer opens a child.","parent initial");
      global.dialogMark("parent-return:"+typeof parent+":"+parent);
    }
    global.dialogMark("after");
  }
  function onKeyDown(key,shift){if(key==65){global.dialogKeys++;global.dialogMark("game-key:"+global.dialogKeys);}}
}
var dialogWindow=new DialogWindow(),dialogLayer=new Layer(dialogWindow,null);
dialogLayer.type=ltOpaque;dialogLayer.setSize(180,100);dialogLayer.fillRect(0,0,180,100,0xff305070);
var dialogMenu=new MenuItem(dialogWindow,"Dialog shortcut");dialogWindow.menu.add(dialogMenu);
dialogMenu.shortcut="Shift+F6";
dialogMenu.onClick=function(){global.dialogMenus++;global.dialogMark("game-menu:"+global.dialogMenus);};
function dialogTick(){
  dialogClock.enabled=false;dialogTimers++;dialogMark("timer:"+dialogTimers);
  if(dialogFlow=="nested"){
    var lines=[];lines.load("late.tjs","utf-8");
    dialogMark("child-before:"+lines[0]);
    var result=System.inputString("Child input","A nested Timer owns this input.","child initial");
    dialogMark("child-return:"+typeof result+":"+result);
  }
}
var dialogClock=new Timer(global,"dialogTick");dialogClock.interval=100;
dialogMark("ready");
`

const startup = (binary: boolean, file = 'system-dialog-proof') =>
  binary
    ? `Scripts.compileStorage("${file}.tjs","savedata/${file}.cjs",false,true,false);Scripts.execStorage("savedata/${file}.cjs");`
    : `Scripts.execStorage("${file}.tjs");`

async function prepare(page: Page, backend: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  return errors
}

function controls(page: Page, errors: string[]) {
  const owner = page.locator('.game-window[aria-label="System dialog owner"]'),
    canvas = owner.locator('canvas[data-window-id]')
  return {
    owner,
    canvas,
    async open() {
      await expect(owner).toBeVisible()
      await canvas.focus()
      await canvas.click({ position: { x: 90, y: 50 } })
      await expect(page.getByText('system-dialog-proof:before:1', { exact: true })).toBeVisible()
      await expect(owner).toHaveAttribute('data-blocked', 'true')
      await expect(page.getByText('system-dialog-proof:timer:1', { exact: true })).toBeVisible()
      await expect(page.getByText('system-dialog-proof:after', { exact: true })).toHaveCount(0)
    },
    async stopped() {
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-system-dialog')).toHaveCount(0)
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.game-menu-overlay')).toHaveCount(0)
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      expect(errors).toEqual([])
    },
    async stop() {
      // The application command must retire even a startup-owned modal scope.
      if (await page.locator('#stop').isEnabled())
        await page.locator('#stop').dispatchEvent('click')
      await this.stopped()
    },
  }
}

async function launch(page: Page, backend: string, binary: boolean, flow: Flow) {
  const errors = await prepare(page, backend)
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(startup(binary)) },
    {
      name: 'system-dialog-proof.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + `\ndialogFlow="${flow}";`),
    },
  ])
  await expect(page.getByText('system-dialog-proof:ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return controls(page, errors)
}

async function launchNested(page: Page, backend: string, binary: boolean) {
  const errors = await prepare(page, backend),
    bytes = remoteArchive('zip'),
    late = centralRecords(bytes).records.find((entry) => entry.name === 'late.tjs')!
  let armed = false,
    held = 0,
    release: (() => void) | undefined
  const server = await httpServer({
    '/dialog.zip': {
      bytes,
      etag: '"system-dialog-nesting-v1"',
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
            ETag: '"system-dialog-nesting-v1"',
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
    await page.locator('#remote-url').fill(server.url + '/dialog.zip')
    await page.locator('#load-url').click()
    await expect(page.getByText('zip-ready:42:0', { exact: true })).toBeVisible()
    await expect(page.locator('#evaluate')).toBeEnabled()
    const script = `w.visible=false;\n${source}\ndialogFlow="nested";`
    // This setup finishes before the real mouse event suspends the VM. The
    // nested Timer is subsequently gated by its own real asynchronous read.
    await evaluate(
      page,
      binary
        ? `(function(){var code=[${JSON.stringify(script)}];code.save("savedata/dialog-nested.tjs","utf-8");Scripts.compileStorage("savedata/dialog-nested.tjs","savedata/dialog-nested.cjs",false,true,false);Scripts.execStorage("savedata/dialog-nested.cjs");return 1;})()`
        : `(function(){Scripts.exec(${JSON.stringify(script)});return 1;})()`,
      '1',
    )
    armed = true
    return {
      ...controls(page, errors),
      async waiting() {
        await expect.poll(() => held).toBe(1)
      },
      release() {
        expect(release).toBeDefined()
        release!()
      },
      async close() {
        release?.()
        await server.close()
      },
    }
  } catch (error) {
    release?.()
    await server.close()
    throw error
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: inform pumps Timer while real dialog keys cannot reach the game`, async ({
      page,
    }) => {
      const game = await launch(page, backend, binary, 'inform')
      try {
        await game.open()
        const dialog = page.getByRole('dialog', { name: 'Message proof', exact: true }),
          confirm = dialog.getByRole('button', { name: '确定', exact: true })
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('The Timer continues while this message is open.')
        await expect(dialog.getByRole('textbox')).toHaveCount(0)
        await expect(confirm).toBeFocused()
        await page.keyboard.press('a')
        await page.keyboard.press('Shift+F6')
        await expect(page.getByText(/^system-dialog-proof:game-/)).toHaveCount(0)
        await expect(page.getByText(/^system-dialog-proof:inform-return:/)).toHaveCount(0)
        await page.keyboard.press('Enter')
        await expect(dialog).toHaveCount(0)
        await expect(
          page.getByText('system-dialog-proof:inform-return:void', { exact: true }),
        ).toBeVisible()
        await expect(page.getByText('system-dialog-proof:after', { exact: true })).toBeVisible()
        await expect(game.owner).toHaveAttribute('data-blocked', 'false')
        await expect
          .poll(() => game.owner.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true)
        await evaluate(
          page,
          '[dialogCalls,dialogKeys,dialogMenus,dialogTimers].join(",")',
          '1,0,0,1',
        )
        // The same inputs work again after the owned dialog has returned.
        await game.canvas.focus()
        await page.keyboard.press('a')
        await expect(
          page.getByText('system-dialog-proof:game-key:1', { exact: true }),
        ).toBeVisible()
        await page.keyboard.press('Shift+F6')
        await expect(
          page.getByText('system-dialog-proof:game-menu:1', { exact: true }),
        ).toBeVisible()
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: inputString preserves Unicode and distinguishes empty confirmation from both cancel paths`, async ({
      page,
    }) => {
      const game = await launch(page, backend, binary, 'input')
      try {
        await game.open()
        const unicode = page.getByRole('dialog', { name: 'Unicode input', exact: true }),
          input = unicode.getByRole('textbox', { name: '输入内容', exact: true }),
          value = '編集した名前 😀 café'
        await expect(unicode).toContainText('请输入名字 <b>文字</b>')
        await expect(unicode.locator('b')).toHaveCount(0)
        await expect(input).toHaveValue('初期値')
        await expect(input).toBeFocused()
        await input.fill('')
        // Playwright has no OS IME driver. These composition events exercise
        // the ownership guard; Unicode insertion and Enter are real input.
        await input.dispatchEvent('compositionstart', { data: '編' })
        await page.keyboard.insertText(value)
        await page.keyboard.press('Enter')
        await expect(unicode).toBeVisible()
        await expect(page.getByText(/^system-dialog-proof:unicode-return:/)).toHaveCount(0)
        await input.dispatchEvent('compositionend', { data: value })
        await expect(input).toHaveValue(value)
        await page.keyboard.press('Enter')
        await expect(
          page.getByText(`system-dialog-proof:unicode-return:String:${value}`, { exact: true }),
        ).toBeVisible()
        const empty = page.getByRole('dialog', { name: 'Empty input', exact: true })
        await empty.getByRole('textbox').fill('')
        await empty.getByRole('button', { name: '确定', exact: true }).click()
        await expect(
          page.getByText('system-dialog-proof:empty-return:String:0', { exact: true }),
        ).toBeVisible()
        const cancel = page.getByRole('dialog', { name: 'Cancel input', exact: true })
        await expect(cancel.getByRole('textbox')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(
          page.getByText('system-dialog-proof:cancel-return:void', { exact: true }),
        ).toBeVisible()
        const button = page.getByRole('dialog', { name: 'Cancel button', exact: true })
        await button.getByRole('button', { name: '取消', exact: true }).click()
        await expect(
          page.getByText('system-dialog-proof:button-return:void', { exact: true }),
        ).toBeVisible()
        await expect(page.locator('.game-system-dialog')).toHaveCount(0)
        await expect(page.getByText('system-dialog-proof:after', { exact: true })).toBeVisible()
        await evaluate(
          page,
          '[dialogCalls,dialogKeys,dialogMenus,dialogTimers].join(",")',
          '1,0,0,1',
        )
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: a nested Timer dialog restores its parent's edited value, selection and focus`, async ({
      page,
    }) => {
      const game = await launchNested(page, backend, binary)
      try {
        await game.open()
        await game.waiting()
        const parent = page.getByRole('dialog', { name: 'Parent input', exact: true }),
          input = parent.getByRole('textbox', { name: '输入内容', exact: true }),
          value = 'parent-修改值'
        await expect(input).toHaveValue('parent initial')
        await input.fill(value)
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Shift+ArrowLeft')
        const selection = await input.evaluate((element: HTMLInputElement) => [
          element.selectionStart,
          element.selectionEnd,
          element.selectionDirection,
        ])
        expect(Number(selection[1]) - Number(selection[0])).toBe(1)
        const retainedInput = await input.elementHandle()
        game.release()
        const child = page.getByRole('dialog', { name: 'Child input', exact: true })
        await expect(child).toBeVisible()
        await expect(
          page.getByText('system-dialog-proof:child-before:73', { exact: true }),
        ).toBeVisible()
        await expect(parent).toHaveCount(0)
        await expect(page.locator('.game-system-dialog')).toHaveCount(1)
        await expect(child.getByRole('textbox')).toBeFocused()
        await expect(page.getByText(/^system-dialog-proof:parent-return:/)).toHaveCount(0)
        await child.getByRole('textbox').fill('child-確認')
        await page.keyboard.press('Enter')
        await expect(
          page.getByText('system-dialog-proof:child-return:String:child-確認', { exact: true }),
        ).toBeVisible()
        await expect(parent).toBeVisible()
        await expect(input).toHaveValue(value)
        await expect(input).toBeFocused()
        expect(await retainedInput!.evaluate((element) => element.isConnected)).toBe(true)
        expect(
          await input.evaluate((element: HTMLInputElement) => [
            element.selectionStart,
            element.selectionEnd,
            element.selectionDirection,
          ]),
        ).toEqual(selection)
        await expect(game.owner).toHaveAttribute('data-blocked', 'true')
        await page.keyboard.press('Enter')
        await expect(
          page.getByText(`system-dialog-proof:parent-return:String:${value}`, { exact: true }),
        ).toBeVisible()
        await expect(page.getByText('system-dialog-proof:after', { exact: true })).toBeVisible()
        await expect(game.owner).toHaveAttribute('data-blocked', 'false')
        await evaluate(
          page,
          'dialogTrace.join("|")',
          `ready|before:1|timer:1|child-before:73|child-return:String:child-確認|parent-return:String:${value}|after`,
        )
      } finally {
        try {
          await game.stop()
        } finally {
          await game.close()
        }
      }
    })

    test(`${variant}: Stop retires a dialog opened before any Window and a fresh Worker can resume normally`, async ({
      page,
    }) => {
      const errors = await prepare(page, backend),
        game = controls(page, errors)
      try {
        await page.locator('#files').setInputFiles([
          {
            name: 'startup.tjs',
            mimeType: 'text/plain',
            buffer: Buffer.from(startup(binary, 'startup-dialog')),
          },
          {
            name: 'startup-dialog.tjs',
            mimeType: 'text/plain',
            buffer: Buffer.from(
              'System.inform("This startup has not created a Window.");Debug.message("system-dialog-startup-must-not-resume");',
            ),
          },
        ])
        const dialog = page.getByRole('dialog', { name: 'Information', exact: true })
        await expect(dialog).toBeVisible()
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await expect(
          page.getByText('system-dialog-startup-must-not-resume', { exact: true }),
        ).toHaveCount(0)
        await dialog.getByRole('button', { name: '停止游戏', exact: true }).click()
        await game.stopped()
        await expect(
          page.getByText('system-dialog-startup-must-not-resume', { exact: true }),
        ).toHaveCount(0)
        await page.locator('#files').setInputFiles({
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'System.inform("Fresh session","Fresh dialog");var freshWindow=new Window();freshWindow.visible=true;Debug.message("system-dialog-fresh-returned");',
          ),
        })
        await page
          .getByRole('dialog', { name: 'Fresh dialog', exact: true })
          .getByRole('button', { name: '确定', exact: true })
          .click()
        await expect(page.getByText('system-dialog-fresh-returned', { exact: true })).toBeVisible()
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(1)
        await expect(page.locator('.game-system-dialog')).toHaveCount(0)
      } finally {
        await game.stop()
      }
    })
  }
}

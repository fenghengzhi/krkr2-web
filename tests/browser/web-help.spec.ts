import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { prepareSystemPage, stopSystemPage } from '../helpers/web-system-core.ts'

const firstText = '帮助 / Help 雪 😀\r\n<script>window.helpExecuted=true</script>\n<button>plain text</button>',
  secondText = 'second help\n<script>throw "not executable"</script>',
  file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })

async function preserveCleanup(primary: { error: unknown } | undefined, cleanup: () => Promise<void>) {
  try { await cleanup() }
  catch (error) {
    if (primary) throw new AggregateError([primary.error, error], 'Help scenario and cleanup both failed')
    throw error
  }
}

function files(binary: boolean, text = firstText) {
  return [
    file('startup.tjs', binary
      ? 'Scripts.compileStorage("help-test.tjs","savedata/help-test.cjs",false,true,false);Scripts.execStorage("savedata/help-test.cjs");'
      : 'Scripts.execStorage("help-test.tjs");'),
    file('help-test.tjs', `
var first=System.shellExecute(Storages.getLocalName(System.exePath)+"readme.txt");
Debug.message("web-help:continued:"+first);
function replaceHelp(){return System.shellExecute("second.md");}
function tryHelp(){try{return string(replaceHelp());}catch(e){return e.message;}}
function unsupportedHelp(){return [System.shellExecute("missing.txt"),
System.shellExecute("readme.txt","args"),System.shellExecute("bad.html"),
System.shellExecute("https://example.com/readme.txt")].join("|");}
`),
    file('ReadMe.TXT', text), file('second.md', secondText), file('bad.html', '<script>throw 1</script>'),
  ]
}

for (const backend of ['asyncify', 'jspi'] as const) {
  for (const binary of [false, true])
    test(`${backend}/${binary ? 'bytecode' : 'source'}: real VFS help is shown as text, returns before dismissal, and retires across Stop`, async ({ page }, info) => {
      const setup = await prepareSystemPage(page, backend)
      let primary: { error: unknown } | undefined
      try {
        await page.locator('#files').setInputFiles(files(binary))
        await expect(page.getByText('web-help:continued:1', { exact: true })).toBeVisible()
        const help = page.locator('.game-help'), body = page.locator('.game-help-text')
        await expect(help).toBeVisible()
        expect(await body.textContent()).toBe(firstText)
        await expect(page.locator('.game-help-path')).toHaveText('game://./ReadMe.TXT')
        await expect(body.locator('script,button')).toHaveCount(0)
        expect(await page.evaluate(() => (window as unknown as { helpExecuted?: boolean }).helpExecuted)).toBeUndefined()
        const retired = await page.locator('.game-help-close').elementHandle()
        expect(retired).not.toBeNull()
        try {
          await evaluate(page, 'replaceHelp()', '1')
          await expect(help).toHaveCount(1)
          expect(await body.textContent()).toBe(secondText)
          await retired!.evaluate((button) => (button as HTMLButtonElement).click())
          await expect(help).toBeVisible()
          expect(await body.textContent()).toBe(secondText)
          await evaluate(page, 'unsupportedHelp()', '0|0|0|0')
          expect(await body.textContent()).toBe(secondText)
          await page.locator('#pause').click()
          await expect(page.locator('#status')).toHaveText('已暂停')
          await expect(help).toBeVisible()
          await page.locator('.game-help-close').click()
          await expect(help).toHaveCount(0)
          await page.locator('#pause').click()
          await evaluate(page, 'replaceHelp()', '1')
          await expect(help).toBeVisible()
          await stopSystemPage(page, setup.errors)
          await expect(help).toHaveCount(0)
          await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
          await page.locator('#files').setInputFiles(files(binary, 'fresh session help'))
          await expect(help).toBeVisible()
          expect(await body.textContent()).toBe('fresh session help')
          await retired!.evaluate((button) => (button as HTMLButtonElement).click())
          await expect(help).toBeVisible()
          expect(await body.textContent()).toBe('fresh session help')
        } finally { await retired?.dispose() }
        await info.attach('help-shown-and-script-continued', {
          body: await page.locator('#logs').innerText(), contentType: 'text/plain',
        })
      } catch (error) { primary = { error }; throw error }
      finally {
        await preserveCleanup(primary, async () => {
          await stopSystemPage(page, setup.errors)
          await expect(page.locator('.game-help')).toHaveCount(0)
        })
      }
    })

  test(`${backend}: hidden help presentation fails, recovers, and focused help isolates real game shortcuts`, async ({ page }) => {
    const setup = await prepareSystemPage(page, backend)
    let primary: { error: unknown } | undefined
    try {
      await page.locator('#files').setInputFiles(files(false))
      await expect(page.getByText('web-help:continued:1', { exact: true })).toBeVisible()
      await page.locator('.stage-panel').evaluate((host) => {
        ;(host as HTMLElement).hidden = true
        ;(host as HTMLElement).style.display = 'none'
      })
      await evaluate(page, 'tryHelp()', 'Help presentation is not visible')
      await expect(page.locator('.game-help')).toBeHidden()
      await page.locator('.stage-panel').evaluate((host) => {
        ;(host as HTMLElement).hidden = false
        ;(host as HTMLElement).style.removeProperty('display')
      })
      await evaluate(page, 'tryHelp()', '1')
      expect(await page.locator('.game-help-text').textContent()).toBe(secondText)
      await evaluate(page, `(function(){
global.helpMenuCount=0;global.helpWindow=new Window();
global.helpLayer=new Layer(global.helpWindow,null);
global.helpWindow.setInnerSize(240,120);global.helpWindow.visible=true;
global.helpMenu=new MenuItem(global.helpWindow,"Help shortcut");
global.helpWindow.menu.add(global.helpMenu);global.helpMenu.shortcut="Shift+F6";
global.helpMenu.onClick=function(){global.helpMenuCount++;Debug.message("help-shortcut:"+global.helpMenuCount);};
return "ready";
})()`, 'ready')
      const surface = page.locator('#stage .game-window[data-window-id]'),
        canvas = surface.locator('canvas'),
        gameInput = surface.locator('.game-text-input'),
        helpBody = page.locator('.game-help-text')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('tabindex', '0')
      await expect(surface.getByRole('button', { name: /Help shortcut/ })).toBeEnabled()
      await canvas.focus()
      // BrowserInput deliberately redirects canvas focus to its real textarea.
      await expect(gameInput).toBeFocused()
      await page.keyboard.press('Shift+F6')
      await expect(page.getByText('help-shortcut:1', { exact: true })).toBeVisible()
      await helpBody.focus()
      await expect(helpBody).toBeFocused()
      await expect(surface).toHaveAttribute('data-active', 'true')
      await page.keyboard.press('Shift+F6')
      await evaluate(page, 'helpMenuCount', '1')
      await helpBody.focus()
      await expect(helpBody).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator('.game-help')).toHaveCount(0)
      await canvas.focus()
      await expect(gameInput).toBeFocused()
      await page.keyboard.press('Shift+F6')
      await expect(page.getByText('help-shortcut:2', { exact: true })).toBeVisible()
      await evaluate(page, `(function(){
var open=new MenuItem(global.helpWindow,"Open fullscreen help");
open.onClick=function(){global.helpWindow.fullScreen=true;System.shellExecute("second.md");Debug.message("fullscreen-help-continued");};
global.helpWindow.menu.add(open);return "ready";
})()`, 'ready')
      await surface.getByRole('button', { name: 'Open fullscreen help', exact: true }).click()
      await expect(surface).toHaveClass(/game-window-fullscreen/)
      const panel = page.locator('.game-help'), close = panel.locator('.game-help-close')
      await expect(panel).toHaveCSS('position', 'fixed')
      await expect(close).toBeVisible()
      expect(await close.evaluate((button) => {
        const box = button.getBoundingClientRect()
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      expect(await helpBody.textContent()).toBe(secondText)
      // Exit remains a real reachable control while the help stays open.
      await surface.locator('.game-window-leave-fullscreen').click()
      await expect(surface).not.toHaveClass(/game-window-fullscreen/)
      await expect(panel).toHaveCSS('position', 'relative')
      await expect(page.getByText('fullscreen-help-continued', { exact: true })).toBeVisible()
      await close.click()
      await expect(panel).toHaveCount(0)
    } catch (error) { primary = { error }; throw error }
    finally {
      await preserveCleanup(primary, async () => {
        await page.locator('.stage-panel').evaluate((host) => {
          ;(host as HTMLElement).hidden = false
          ;(host as HTMLElement).style.removeProperty('display')
        })
        const exit = page.locator('.game-window-fullscreen .game-window-leave-fullscreen')
        if (await exit.isVisible()) await exit.click()
        await stopSystemPage(page, setup.errors)
      })
    }
  })

  test(`${backend}: native help capability is required and restoring the exact manifest permits real presentation`, async ({ page }, info) => {
    const setup = await prepareSystemPage(page, backend),
      bytes = await readFile(resolve('.generated/wasm/manifest.json')),
      hash = createHash('sha256').update(bytes).digest('hex'),
      path = `/wasm/manifest-${hash.slice(0, 16)}.json`,
      matches = (url: URL) => url.pathname === path,
      errors: string[] = [],
      records: { original: WasmManifest; served: WasmManifest }[] = []
    let primary: { error: unknown } | undefined
    await page.context().route(matches, async (route) => {
      try {
        const response = await route.fetch(), actual = await response.body()
        expect(actual).toEqual(bytes)
        const original = JSON.parse(actual.toString()) as WasmManifest, served = structuredClone(original)
        expect(served.capabilities?.nativeHelp).toBe(1)
        delete served.capabilities!.nativeHelp
        records.push({ original, served })
        await route.fulfill({ response, json: served })
      } catch (error) { errors.push(String(error)); await route.abort('failed') }
    })
    try {
      await page.locator('#files').setInputFiles(files(false))
      await expect(page.locator('#logs')).toContainText('WASM manifest is missing native help support')
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('.game-help')).toHaveCount(0)
      await expect.poll(() => setup.workers.map(({ closed }) => closed)).toEqual([true])
      expect(errors).toEqual([])
      expect(records).toHaveLength(1)
      await page.context().unroute(matches)
      await page.locator('#files').setInputFiles(files(false))
      await expect(page.getByText('web-help:continued:1', { exact: true })).toBeVisible()
      expect(await page.locator('.game-help-text').textContent()).toBe(firstText)
    } catch (error) { primary = { error }; throw error }
    finally {
      await preserveCleanup(primary, async () => {
        await page.context().unroute(matches)
        await info.attach('native-help-manifest-intervention', {
          body: JSON.stringify({ hash, path, records, errors }), contentType: 'application/json',
        })
        // Preserve the expected manifest rejection separately from page errors.
        await stopSystemPage(page, setup.errors)
      })
    }
  })
}

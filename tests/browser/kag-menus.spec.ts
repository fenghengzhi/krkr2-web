import { test, expect } from '@playwright/test'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: KAG callbacks, macros and script menus work in the Worker`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const script = String.raw`
class Parser extends KAGParser {
  function Parser(){super.KAGParser();debugLevel=tkdlNone;}
  function onScenarioLoad(name){return "[macro name=say][emb exp=mp.text][endmacro][say text=A][if exp=true]B[endif]\\";}
}
var parser=new Parser();parser.loadScenario("virtual.ks");var output="",tag;
while((tag=parser.getNextTag())!==void) if(tag.tagname=="ch")output+=tag.text;
Debug.message("KAG="+output);
var window=new Window(), tools=new MenuItem(window,"Tools(&T)"), item=new MenuItem(window,"Count");window.visible=true;
window.menu.add(tools);tools.add(item);var count=0;
item.shortcut="Shift+F6";item.onClick=function(){count++;item.checked=true;Debug.message("menu-count="+count);};
var open=new MenuItem(window,"Open popup");window.menu.add(open);
open.onClick=function(){tools.popup(0,40,40);Debug.message("popup closed");};
`
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(script) })
    await expect(page.locator('#logs')).toContainText('KAG=AB')
    await page.getByText('Tools', { exact: true }).click()
    await page.getByRole('button', { name: 'Count', exact: false }).click()
    await expect(page.locator('#logs')).toContainText('menu-count=1')
    await page.locator('canvas').click()
    await page.keyboard.press('Shift+F6')
    await expect(page.locator('#logs')).toContainText('menu-count=2')
    await page.getByRole('button', { name: 'Open popup' }).click()
    await expect(page.locator('.game-menu-popup')).toBeVisible()
    await page
      .locator('.game-menu-popup')
      .getByRole('button', { name: 'Count', exact: false })
      .click()
    await expect(page.locator('#logs')).toContainText('menu-count=3')
    await expect(page.locator('#logs')).toContainText('popup closed')
    await expect(page.locator('.game-menu-popup')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open popup' }).click()
    await expect(page.locator('.game-menu-popup')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.game-menu-popup')).toHaveCount(0)
    await page.locator('#stop').click()
    await expect(page.locator('#game-menus')).toBeHidden()
  })
}

test('Web Locks excludes a second game session and releases on stop', async ({ page, context }) => {
  const second = await context.newPage()
  const file = {
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from('Debug.message("lock="+System.createAppLock("browser-lock"));'),
  }
  await page.goto('/?backend=asyncify')
  await second.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles(file)
  await expect(page.locator('#logs')).toContainText('lock=1')
  await second.locator('#files').setInputFiles(file)
  await expect(second.locator('#logs')).toContainText('lock=0')
  await page.locator('#stop').click()
  await expect(page.locator('#stop')).toBeDisabled()
  await second.locator('#expression').fill('System.createAppLock("browser-lock")')
  await second.locator('#evaluate').click()
  await expect(second.locator('#logs p span').last()).toHaveText('1')
  await second.close()
})

import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { injectActivity, visibility } from '../helpers/activity-browser.ts'
import { audioPosition, injectAudioProbe, loadMedia } from '../helpers/media-browser.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: disabled events, continuous closures and exception handlers preserve the VM`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(`
var order="",ticks=0,caught=0,goodCalls=0,value=73;
var timer=new Timer(function(){ticks++;},"");timer.interval=10;timer.enabled=true;
var trigger=new AsyncTrigger(function(){order+="N";},"");
function b(t){order+="B";System.removeContinuousHandler(b);}
function a(t){order+="A";System.removeContinuousHandler(a);System.addContinuousHandler(b);}
function bad(t){throw "browser event failure";}
function good(t){goodCalls++;System.removeContinuousHandler(good);}
System.eventDisabled=true;trigger.trigger();System.addContinuousHandler(a);System.addContinuousHandler(a);
Debug.message("system-ready");
`),
    })
    await expect(page.locator('#logs')).toContainText('system-ready')
    await expect(page.locator('#status')).toHaveText('事件已停止')
    // Allow actual browser timer wakes while event delivery is disabled.
    await page.waitForTimeout(100)
    await evaluate(page, 'ticks', '0')
    await evaluate(
      page,
      '(function(){System.eventDisabled=false;timer.enabled=false;return order;})()',
      'NAB',
    )
    await evaluate(
      page,
      'Scripts.exec("System.exceptionHandler=function(e){caught++;return true;};System.addContinuousHandler(bad);System.addContinuousHandler(good);")',
      '',
    )
    await expect(page.locator('#status')).toHaveText('运行中')
    await evaluate(page, 'caught+","+goodCalls', '1,1')
    await evaluate(
      page,
      'Scripts.exec("System.exceptionHandler=null;System.addContinuousHandler(bad);")',
      '',
    )
    await expect(page.locator('#status')).toHaveText('事件已停止')
    await expect(page.locator('#logs')).toContainText('browser event failure')
    await evaluate(page, 'value', '73')
    await evaluate(page, 'System.eventDisabled=false', '0')
    await expect(page.locator('#status')).toHaveText('运行中')
    await page.locator('#stop').click()
  })

  test(`${backend}: menus and shortcuts obey visibility and event disabling while popups can return`, async ({
    page,
  }) => {
    await injectActivity(page)
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(80,40);var clicks=0;
var group=new MenuItem(w,"Tools"),item=new MenuItem(w,"Count");w.menu.add(group);group.add(item);
item.shortcut="Shift+F6";item.onClick=function(){clicks++;};Debug.message("menu-ready");
`),
    })
    await expect(page.locator('#logs')).toContainText('menu-ready')
    await page.locator('#pause-background').uncheck()
    await page.locator('canvas').click()
    await page.keyboard.press('Shift+F6')
    await evaluate(page, 'clicks', '1')
    await evaluate(page, 'System.eventDisabled=true', '1')
    await expect(page.locator('#game-menus summary')).toHaveAttribute('aria-disabled', 'true')
    await page.locator('canvas').click()
    await page.keyboard.press('Shift+F6')
    await evaluate(page, 'clicks', '1')
    await page.locator('#expression').fill('group.popup(0,20,20)')
    await page.locator('#evaluate').click()
    await expect(page.locator('.game-menu-popup')).toBeVisible()
    await page.locator('.game-menu-popup').getByRole('button', { name: 'Count' }).click()
    await expect(page.locator('.game-menu-popup')).toHaveCount(0)
    await evaluate(page, 'clicks', '1')
    await evaluate(page, 'System.eventDisabled=false', '0')
    await visibility(page, 'hidden')
    await expect(page.locator('#status')).toHaveText('运行中')
    await page.locator('canvas').click()
    await page.keyboard.press('Shift+F6')
    await evaluate(page, 'clicks', '1')
    await visibility(page, 'visible')
    await page.getByText('Tools', { exact: true }).click()
    await page.getByRole('button', { name: 'Count' }).click()
    await evaluate(page, 'clicks', '2')
    await page.locator('#expression').fill('group.popup(0,20,20)')
    await page.locator('#evaluate').click()
    await expect(page.locator('.game-menu-popup')).toBeVisible()
    await visibility(page, 'hidden')
    await expect(page.locator('.game-menu-popup')).toHaveCount(0)
    await visibility(page, 'visible')
    await evaluate(page, 'clicks', '2')
    await page.locator('#stop').click()
  })

  test(`${backend}: event disabling keeps media clocks running and suppresses frame notifications`, async ({
    page,
  }) => {
    await injectAudioProbe(page)
    const movie = await loadMedia(page, backend)
    await evaluate(
      page,
      'Scripts.exec("var frames=0;movie.onFrameUpdate=function(frame){if(++frames==1)Debug.message(\\\"frame-notified\\\");};System.eventDisabled=true;")',
      '',
    )
    await expect(page.locator('#status')).toHaveText('事件已停止')
    const before = await audioPosition(page)
    await expect.poll(() => audioPosition(page)).not.toBe(before)
    await expect(movie).toHaveJSProperty('paused', false)
    await evaluate(page, 'frames', '0')
    await evaluate(page, 'System.eventDisabled=false', '0')
    await expect(page.getByText('frame-notified', { exact: true })).toBeVisible()
    await evaluate(page, 'frames>0', '1')
    await evaluate(
      page,
      'Scripts.exec("var ends=[];sound.onStatusChanged=function(s){ends.add(\\\"audio:\\\"+s);};movie.onStatusChanged=function(s){ends.add(\\\"video:\\\"+s);};System.eventDisabled=true;sound.stop();sound.looping=false;sound.position=0;sound.play();movie.loop=false;movie.stop();movie.play();")',
      '',
    )
    await expect(movie).toHaveJSProperty('ended', true)
    await expect.poll(() => audioPosition(page)).toBe(44100)
    await evaluate(page, 'sound.status+","+movie.status', 'stop,stop')
    await evaluate(page, 'ends.count', '0')
    await evaluate(page, 'System.eventDisabled=false', '0')
    await evaluate(
      page,
      'ends.count==2 && ends.find("audio:stop")>=0 && ends.find("video:stop")>=0',
      '1',
    )
    await page.locator('#stop').click()
  })

  test(`${backend}: stopping a continuous callback interrupts its native script loop`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'var value=61;function tick(t){Debug.message("continuous-entered");while(true){}}System.addContinuousHandler(tick);',
      ),
    })
    await expect(page.locator('#logs')).toContainText('continuous-entered')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    await expect(page.locator('#status')).toHaveText('待机')
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from('Debug.message("restart-after-continuous");'),
    })
    await expect(page.locator('#logs')).toContainText('restart-after-continuous')
    await page.locator('#stop').click()
  })
}

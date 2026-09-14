import { expect, type Page } from '@playwright/test'
export async function injectActivity(page: Page, initial: 'visible' | 'hidden' = 'visible') {
  await page.addInitScript((initial) => {
    const state = window as unknown as { activityVisibility: 'visible' | 'hidden' }
    state.activityVisibility = initial
    Object.defineProperty(document, 'visibilityState', {
      get: () => state.activityVisibility,
      configurable: true,
    })
    Object.defineProperty(document, 'hidden', {
      get: () => state.activityVisibility === 'hidden',
      configurable: true,
    })
  }, initial)
}
export async function visibility(
  page: Page,
  state: 'visible' | 'hidden',
  expected: 'visible' | 'hidden' | 'frozen' | 'away' = state,
) {
  await page.evaluate((value) => {
    ;(window as unknown as { activityVisibility: string }).activityVisibility = value
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  await expect(page.locator('#stage')).toHaveAttribute('data-activity', expected)
}
export async function lifecycle(page: Page, type: 'freeze' | 'resume' | 'pagehide' | 'pageshow') {
  await page.evaluate((type) => {
    if (type === 'pagehide' || type === 'pageshow')
      window.dispatchEvent(new PageTransitionEvent(type, { persisted: true }))
    else document.dispatchEvent(new Event(type))
  }, type)
}
export const activitySource = String.raw`
var w=new Window();w.visible=true;w.setInnerSize(8,4);
var root=new Layer(w,null);root.setSize(8,4);root.fillRect(0,0,8,4,0xff123456);
var value=17,clicks=0,ticks=0,downs=0,committed="";
root.focusable=true;root.imeMode=imOpen;root.onKeyPress=function(key,process){committed+=key;Debug.message("activity-text="+committed);};
root.onClick=function(){clicks++;Debug.message("activity-click="+clicks);};
root.onMouseDown=function(){downs++;root.focus();};
var timer=new Timer(function(){ticks++;Debug.message("activity-tick="+ticks);},"");timer.interval=200;timer.enabled=true;
Debug.message("activity-ready");
`
export const activityFile = {
  name: 'startup.tjs',
  mimeType: 'text/plain',
  buffer: Buffer.from(activitySource),
}
export async function loadActivity(page: Page, backend: string, baseURL = '') {
  await page.goto(`${baseURL}/?backend=${backend}`)
  await page.locator('#files').setInputFiles(activityFile)
  await expect(page.locator('#logs')).toContainText('activity-ready')
  await expect(page.locator('#evaluate')).toBeEnabled()
}

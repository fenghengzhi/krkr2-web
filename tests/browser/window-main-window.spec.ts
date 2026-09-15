import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

async function launch(page: Page, backend: string, binary: boolean, source: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  const startup = binary
    ? 'Scripts.compileStorage("browser-main-window.tjs","savedata/browser-main-window.cjs",false,true,false);Scripts.execStorage("savedata/browser-main-window.cjs");'
    : 'Scripts.execStorage("browser-main-window.tjs");'
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(startup) },
    {
      name: 'browser-main-window.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + '\nDebug.message("browser-main-window-ready");'),
    },
  ])
  await expect(page.getByText('browser-main-window-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return async () => {
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: global.Window.mainWindow is a read-only identity query that does not retain its result`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var initiallyNull=(global.Window.mainWindow===null),deaths=0,readonlyRejected=false,secondRejected=false;
class BrowserMainWindow extends Window {
  function BrowserMainWindow(){super.Window();}
  function finalize(){deaths++;}
}
var win=new BrowserMainWindow();win.caption="main-identity";win.visible=true;
function checkGuards(){
  try{global.Window.mainWindow=null;}catch(error){readonlyRejected=true;}
  try{var second=new global.Window();}catch(error){secondRejected=true;}
  return 0;
}
function hideMain(){win.visible=false;return 0;}
function dropMain(){delete global.win;return 0;}
`,
      )
      try {
        await evaluate(page, 'initiallyNull+","+(global.Window.mainWindow===win)', '1,1')
        await evaluate(page, 'checkGuards()', '0')
        await evaluate(
          page,
          'readonlyRejected+","+secondRejected+","+(global.Window.mainWindow===win)+","+global.Window.mainWindow.caption',
          '1,1,1,main-identity',
        )
        await evaluate(page, 'hideMain()', '0')
        await evaluate(page, '(global.Window.mainWindow===win)+","+win.visible', '1,0')
        await evaluate(page, 'dropMain()', '0')
        await evaluate(page, '(global.Window.mainWindow===null)+","+deaths', '1,1')
      } finally {
        await stop()
      }
    })

    test(`${mode}: mainWindow survives a script finalizer failure and unregisters before managed cleanup`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var trace=[],failWindow=true,caught="";
class BrowserRetryWindow extends Window {
  function BrowserRetryWindow(){super.Window();}
  function finalize(){
    trace.add("script:"+int(global.Window.mainWindow===this));
    if(failWindow)throw new global.Exception("browser-main-finalizer");
  }
}
class BrowserMainObserver {
  var owner;
  function BrowserMainObserver(window){owner=window;}
  function finalize(){
    trace.add("managed:"+int(global.Window.mainWindow===null)+":"+owner.caption+":"+int(isvalid owner));
  }
}
var win=new BrowserRetryWindow();win.caption="retry-main";win.visible=true;
var item=new BrowserMainObserver(win);win.add(item);
function rejectInvalidation(){try{invalidate win;}catch(error){caught=error.message;}return 0;}
function retryInvalidation(){failWindow=false;invalidate win;invalidate win;return 0;}
`,
      )
      try {
        await evaluate(page, 'rejectInvalidation()', '0')
        await evaluate(page, 'caught', 'browser-main-finalizer')
        await evaluate(
          page,
          '(global.Window.mainWindow===win)+","+(isvalid win)+","+(isvalid item)+","+trace.join("|")',
          '1,1,1,script:1',
        )
        await evaluate(page, 'retryInvalidation()', '0')
        await evaluate(
          page,
          '(global.Window.mainWindow===null)+","+(isvalid win)+","+(isvalid item)+","+trace.join("|")',
          '1,0,0,script:1|script:1|managed:1:retry-main:1',
        )
      } finally {
        await stop()
      }
    })

    test(`${mode}: a replacement created during managed cleanup remains the mainWindow`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var trace=[],replacement=null;
class BrowserReplacement {
  function finalize(){
    trace.add("before:"+int(global.Window.mainWindow===null));
    replacement=new global.Window();replacement.caption="replacement-main";replacement.visible=true;
    trace.add("created:"+int(global.Window.mainWindow===replacement));
  }
}
class BrowserFollowingCleanup {
  function finalize(){trace.add("following:"+int(global.Window.mainWindow===replacement));}
}
var win=new global.Window();win.visible=true;
win.add(new BrowserReplacement());win.add(new BrowserFollowingCleanup());
function replaceMain(){invalidate win;delete global.win;return 0;}
function retireReplacement(){invalidate replacement;return 0;}
`,
      )
      try {
        await evaluate(page, 'replaceMain()', '0')
        await evaluate(page, 'trace.join("|")', 'before:1|created:1|following:1')
        await evaluate(
          page,
          '(global.Window.mainWindow===replacement)+","+replacement.caption+","+replacement.visible',
          '1,replacement-main,1',
        )
        await evaluate(page, 'retireReplacement()', '0')
        await evaluate(page, '(global.Window.mainWindow===null)+","+(isvalid replacement)', '1,0')
      } finally {
        await stop()
      }
    })
  }
}

import { test } from '@playwright/test'
import { runWaveFocus } from '../helpers/wave-focus-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: shipped background volume keeps music audible after switching away and restores it on return`, async ({ page, browserName, baseURL }, info) => {
    // The regular Chromium connection emulates foreground focus for every page.
    // Its complete scenario runs once with the owned noDefaults connection in
    // activity-native-browser/wave-focus.spec.ts. Retain Firefox/WebKit here;
    // inability to leave focus must still fail, never pass on synthetic events.
    test.skip(browserName === 'chromium', 'Real Chromium tab focus is verified by the same scenario in the trusted-lifecycle job')
    await runWaveFocus(page, info, backend, binary, baseURL!, 'playwright-defaults')
  })

import { test } from '../helpers/native-activity-browser.ts'
import { runWaveFocus } from '../helpers/wave-focus-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual Chromium tab focus preserves shipped background music and restores its foreground level`, async ({ native, baseURL }, info) => {
    await runWaveFocus(native.page, info, backend, binary, baseURL!, 'chromium-no-defaults')
  })

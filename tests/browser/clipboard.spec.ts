import { test, expect, type ElementHandle, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

type ClipboardCall = {
  method: 'read' | 'write' | 'writeText'
  active: boolean
  hasBeenActive: boolean
  focused: boolean
  secure: boolean
  state: 'pending' | 'fulfilled' | 'rejected'
  types?: string[][]
  error?: { name: string; message: string }
}
type ClipboardProof = { calls: ClipboardCall[]; installationErrors: string[] }
declare global {
  interface Window {
    clipboardProof: ClipboardProof
  }
}

const unicode = '剪贴板の文字 😀 café\n第二行',
  panel = '.game-clipboard',
  prefix = 'clipboard-proof:',
  recordedGrants = new WeakMap<Page, string[]>()

// All clipboard cases share one sequential file. In particular, the hosted
// headed Firefox job uses its display clipboard, not a headless private one.
test.describe.configure({ mode: 'default' })

test.afterEach(async ({ page }, info) => {
  // If the initial read never settled, even a failure-time evaluation could
  // manufacture activation. Retain the timeout/trace without such a probe.
  if (
    info.status !== info.expectedStatus &&
    !info.title.startsWith('page-owned initial') &&
    !page.isClosed()
  )
    await evidence(page, info, recordedGrants.get(page) ?? [], 'clipboard-at-failure')
})

async function observe(page: Page) {
  recordedGrants.set(page, [])
  await page.addInitScript(() => {
    const proof: ClipboardProof = { calls: [], installationErrors: [] }
    window.clipboardProof = proof
    const clipboard = navigator.clipboard
    if (!clipboard) {
      proof.installationErrors.push('navigator.clipboard is unavailable')
      return
    }
    for (const method of ['read', 'write', 'writeText'] as const) {
      const original = clipboard[method]
      if (typeof original !== 'function') {
        proof.installationErrors.push(`navigator.clipboard.${method} is unavailable`)
        continue
      }
      try {
        Object.defineProperty(clipboard, method, {
          configurable: true,
          value: function (this: Clipboard, ...args: unknown[]) {
            const call: ClipboardCall = {
              method,
              active: navigator.userActivation.isActive,
              hasBeenActive: navigator.userActivation.hasBeenActive,
              focused: document.hasFocus(),
              secure: isSecureContext,
              state: 'pending',
            }
            proof.calls.push(call)
            try {
              // Observe the real API without moving its invocation out of the
              // actual button handler or substituting any returned content.
              const result = Reflect.apply(original, this, args)
              return Promise.resolve(result).then(
                (value) => {
                  call.state = 'fulfilled'
                  if (method === 'read')
                    call.types = (value as ClipboardItem[]).map((item) => [...item.types])
                  return value
                },
                (error: unknown) => {
                  call.state = 'rejected'
                  call.error = {
                    name:
                      error instanceof Error || error instanceof DOMException
                        ? error.name
                        : 'UnknownError',
                    message:
                      error instanceof Error || error instanceof DOMException
                        ? error.message
                        : String(error),
                  }
                  throw error
                },
              )
            } catch (error) {
              call.state = 'rejected'
              call.error = {
                name:
                  error instanceof Error || error instanceof DOMException
                    ? error.name
                    : 'UnknownError',
                message:
                  error instanceof Error || error instanceof DOMException
                    ? error.message
                    : String(error),
              }
              throw error
            }
          },
        })
      } catch (error) {
        proof.installationErrors.push(`${method}: ${String(error)}`)
      }
    }
  })
}

async function evidence(
  page: Page,
  info: TestInfo,
  grants: string[],
  name = 'real-browser-clipboard',
) {
  const proof = await page.evaluate(() => window.clipboardProof),
    inventory = JSON.parse(
      await readFile(resolve('node_modules/playwright-core/browsers.json'), 'utf8'),
    ) as { browsers: { name: string; revision: string; revisionOverrides?: unknown }[] }
  await info.attach(name, {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        browser: info.project.name,
        version: page.context().browser()?.version(),
        lockedBrowserInventory: inventory.browsers.filter((entry) =>
          entry.name.startsWith(info.project.name),
        ),
        runnerOS: process.env.RUNNER_OS ?? process.platform,
        headless: process.env.KRKR_TEST_HEADED !== '1',
        origin: new URL(page.url()).origin,
        grants,
        input: info.title.startsWith('page-owned initial')
          ? 'Page-owned initial script, completed before automation evaluation'
          : info.title.startsWith('PNG-only')
            ? 'Playwright locator.click on application buttons; the initial PNG write uses a dedicated synthetic-data fixture button'
            : 'Playwright locator.click on the actual application DOM button',
        scope:
          process.env.KRKR_TEST_HEADED === '1'
            ? 'Same-origin synthetic data on this hosted display; no external application interoperability claim'
            : 'Real headless browser clipboard backend; not an OS interoperability claim',
        ...proof,
      },
      null,
      2,
    ),
  })
  expect(proof.installationErrors).toEqual([])
  return proof.calls
}

async function prepare(page: Page, backend: string, browserName: string, assisted = true) {
  const errors: string[] = [],
    grants = assisted && browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : []
  page.on('pageerror', (error) => errors.push(error.message))
  await observe(page)
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  if (grants.length)
    await page.context().grantPermissions(grants, { origin: new URL(page.url()).origin })
  recordedGrants.set(page, grants)
  return { errors, grants }
}

function program(body: string) {
  return `
System.exitOnWindowClose=false;
var clipboardCalls=0;
function clipboardMark(value){Debug.message("${prefix}"+value);}
class ClipboardWindow extends Window {
  function ClipboardWindow(){super.Window();caption="Clipboard owner";setInnerSize(180,100);setPos(0,0);visible=true;}
  function onMouseDown(){
    if(global.clipboardCalls++)return;
    ${body}
  }
}
var clipboardWindow=new ClipboardWindow(),clipboardLayer=new Layer(clipboardWindow,null);
clipboardLayer.type=ltOpaque;clipboardLayer.setSize(180,100);clipboardLayer.fillRect(0,0,180,100,0xff305070);
clipboardMark("ready");
`
}

async function load(page: Page, binary: boolean, code: string) {
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("clipboard.tjs","savedata/clipboard.cjs",false,true,false);Scripts.execStorage("savedata/clipboard.cjs");'
          : 'Scripts.execStorage("clipboard.tjs");',
      ),
    },
    { name: 'clipboard.tjs', mimeType: 'text/plain', buffer: Buffer.from(code) },
  ])
}

function mark(page: Page, value: string) {
  return page.getByText(prefix + value, { exact: true })
}

async function open(page: Page) {
  await expect(mark(page, 'ready')).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  await page
    .locator('.game-window[aria-label="Clipboard owner"] canvas[data-window-id]')
    .click({ position: { x: 90, y: 50 } })
}

async function waiting(page: Page, operation: string, before: string) {
  await expect(mark(page, before)).toBeVisible()
  await expect(page.locator(panel)).toHaveAttribute('data-request-id', /^[1-9]\d*$/)
  await expect(page.locator(panel)).toHaveAttribute('data-generation', /^[1-9]\d*$/)
  await expect(page.locator(panel)).toHaveAttribute('data-operation', operation)
  await expect(page.locator(panel)).toHaveAttribute('data-state', 'waiting')
  await expect(page.locator(`${panel} [data-action="perform"]`)).toBeEnabled()
  await expect(page.locator(`${panel} [data-action="cancel"]`)).toBeEnabled()
  return page.locator(`${panel} [data-action="perform"]`)
}

async function perform(page: Page, operation: string, before: string, after: string) {
  const button = await waiting(page, operation, before)
  await expect(mark(page, after)).toHaveCount(0)
  await button.click()
  await expect(mark(page, after)).toBeVisible()
}

async function stopped(page: Page, errors: string[]) {
  await expect(page.locator('#status')).toHaveText('待机')
  await expect(page.locator(panel)).toHaveCount(0)
  await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
  await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
  expect(errors).toEqual([])
}

async function stop(page: Page, errors: string[]) {
  const clipboardStop = page.locator(`${panel} [data-action="stop"]`),
    dialogStop = page.locator('.game-system-dialog .system-dialog-actions [data-action="stop"]')
  if ((await clipboardStop.count()) && (await clipboardStop.isEnabled()))
    await clipboardStop.click()
  else if ((await dialogStop.count()) && (await dialogStop.last().isEnabled()))
    await dialogStop.last().click()
  else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
  await stopped(page, errors)
}

function successful(calls: ClipboardCall[], methods: ClipboardCall['method'][]) {
  expect(calls.map((call) => call.method)).toEqual(methods)
  for (const call of calls) {
    expect(call.state).toBe('fulfilled')
    expect(call.active).toBe(true)
    expect(call.hasBeenActive).toBe(true)
    expect(call.focused).toBe(true)
    expect(call.secure).toBe(true)
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: real Clipboard Unicode and empty-text round trip (Chromium driver grants; Firefox/WebKit no grants)`, async ({
      page,
      browserName,
    }, info) => {
      const setup = await prepare(page, backend, browserName)
      try {
        await load(
          page,
          binary,
          program(`
clipboardMark("before-write");Clipboard.asText=${JSON.stringify(unicode)};clipboardMark("after-write");
clipboardMark("before-format");clipboardMark("format:"+int(Clipboard.hasFormat(cbfText)));
clipboardMark("before-read");var text=Clipboard.asText;clipboardMark("unicode-read:"+typeof text+":"+int(text===${JSON.stringify(unicode)}));
clipboardMark("before-empty-write");Clipboard.asText="";clipboardMark("after-empty-write");
clipboardMark("before-empty-format");clipboardMark("empty-format:"+int(Clipboard.hasFormat(cbfText)));
clipboardMark("before-empty-read");var empty=Clipboard.asText;clipboardMark("empty-read:"+typeof empty+":"+empty.length);
clipboardMark("done");`),
        )
        await open(page)
        await waiting(page, 'write-text', 'before-write')
        // Clipboard owns an explicit browser action, not a modal Window or a
        // cooperative TJS Timer scope.
        await expect(page.locator('.game-window[aria-label="Clipboard owner"]')).toHaveAttribute(
          'data-blocked',
          'false',
        )
        await expect(page.locator('dialog:modal')).toHaveCount(0)
        await expect(page.locator('#stop')).toBeEnabled()
        await perform(page, 'write-text', 'before-write', 'after-write')
        await perform(page, 'has-text', 'before-format', 'format:1')
        await perform(page, 'read-text', 'before-read', 'unicode-read:String:1')
        await perform(page, 'write-text', 'before-empty-write', 'after-empty-write')
        await perform(page, 'has-text', 'before-empty-format', 'empty-format:1')
        await perform(page, 'read-text', 'before-empty-read', 'empty-read:String:0')
        await expect(mark(page, 'done')).toBeVisible()
        const calls = await evidence(page, info, setup.grants)
        successful(calls, ['writeText', 'read', 'read', 'writeText', 'read', 'read'])
        for (const call of calls.filter((call) => call.method === 'read'))
          expect(call.types!.some((types) => types.includes('text/plain'))).toBe(true)
      } finally {
        await stop(page, setup.errors)
      }
    })

    test(`${variant}: cancelling each Clipboard action raises AbortError without touching the real API`, async ({
      page,
      browserName,
    }, info) => {
      const setup = await prepare(page, backend, browserName, false)
      try {
        await load(
          page,
          binary,
          program(`
clipboardMark("before-write-cancel");try{Clipboard.asText="must not be copied";clipboardMark("unexpected-write");}catch(e){clipboardMark("write-cancel:"+int(e.message.indexOf("AbortError")>=0));}
clipboardMark("before-has-cancel");try{Clipboard.hasFormat(cbfText);clipboardMark("unexpected-has");}catch(e){clipboardMark("has-cancel:"+int(e.message.indexOf("AbortError")>=0));}
clipboardMark("before-read-cancel");try{var text=Clipboard.asText;clipboardMark("unexpected-read");}catch(e){clipboardMark("read-cancel:"+int(e.message.indexOf("AbortError")>=0));}
clipboardMark("cancel-done");`),
        )
        await open(page)
        for (const [operation, name] of [
          ['write-text', 'write'],
          ['has-text', 'has'],
          ['read-text', 'read'],
        ]) {
          await waiting(page, operation, `before-${name}-cancel`)
          await page.locator(`${panel} [data-action="cancel"]`).click()
          await expect(mark(page, `${name}-cancel:1`)).toBeVisible()
        }
        await expect(mark(page, 'cancel-done')).toBeVisible()
        await expect(page.getByText(/^clipboard-proof:unexpected-/)).toHaveCount(0)
        expect(await evidence(page, info, setup.grants)).toEqual([])
      } finally {
        await stop(page, setup.errors)
      }
    })

    test(`${variant}: Stop retires a startup Clipboard request and detached buttons cannot affect a fresh Worker`, async ({
      page,
      browserName,
    }, info) => {
      const setup = await prepare(page, backend, browserName)
      let retired: ElementHandle<SVGElement | HTMLElement> | null = null
      try {
        await load(
          page,
          binary,
          `Debug.message("${prefix}startup-before");try{Clipboard.asText="retired startup write";Debug.message("${prefix}startup-must-not-resume");}catch(e){Debug.message("${prefix}stopped-catch");}Debug.message("${prefix}startup-tail");`,
        )
        await waiting(page, 'write-text', 'startup-before')
        retired = await page.locator(panel).elementHandle()
        const oldGeneration = await page.locator(panel).getAttribute('data-generation')
        await page.locator(`${panel} [data-action="stop"]`).click()
        await stopped(page, setup.errors)
        // Preserve this Session's complete log before loading the replacement,
        // whose startup clears it. Stop is execution cancellation, so neither
        // a successful clipboard return nor a catch/tail continuation may run.
        const stoppedLogs = await page.locator('#logs').innerText()
        await info.attach('stopped-clipboard-startup-logs', {
          body: stoppedLogs,
          contentType: 'text/plain',
        })
        expect(stoppedLogs).toContain(prefix + 'startup-before')
        for (const forbidden of ['startup-must-not-resume', 'stopped-catch', 'startup-tail'])
          expect(stoppedLogs).not.toContain(prefix + forbidden)
        await expect(mark(page, 'startup-must-not-resume')).toHaveCount(0)
        await expect(mark(page, 'stopped-catch')).toHaveCount(0)
        await expect(mark(page, 'startup-tail')).toHaveCount(0)
        await load(
          page,
          binary,
          `Debug.message("${prefix}fresh-before");Clipboard.asText=${JSON.stringify(unicode)};Debug.message("${prefix}fresh-written");var text=Clipboard.asText;Debug.message("${prefix}fresh-read:"+int(text===${JSON.stringify(unicode)}));var w=new Window();w.visible=true;`,
        )
        await waiting(page, 'write-text', 'fresh-before')
        expect(await page.locator(panel).getAttribute('data-generation')).not.toBe(oldGeneration)
        // This deliberately synthetic click only challenges a retired listener.
        // It must not call any Clipboard API, regardless of automation activation.
        await retired!.evaluate((element) => {
          document.body.append(element)
          element.querySelector<HTMLButtonElement>('[data-action="perform"]')?.click()
          element.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
          element.querySelector<HTMLButtonElement>('[data-action="stop"]')?.click()
          element.remove()
        })
        expect(await page.evaluate(() => window.clipboardProof.calls)).toEqual([])
        await perform(page, 'write-text', 'fresh-before', 'fresh-written')
        await perform(page, 'read-text', 'fresh-written', 'fresh-read:1')
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(1)
        successful(await evidence(page, info, setup.grants), ['writeText', 'read'])
        await expect(mark(page, 'startup-must-not-resume')).toHaveCount(0)
        await expect(mark(page, 'stopped-catch')).toHaveCount(0)
        await expect(mark(page, 'startup-tail')).toHaveCount(0)
      } finally {
        try {
          await stop(page, setup.errors)
        } finally {
          await retired?.dispose()
        }
      }
    })
  }
}

test('PNG-only real clipboard has no text; a later real write replaces it (Chromium driver grants; Firefox/WebKit no grants)', async ({
  page,
  browserName,
}, info) => {
  const setup = await prepare(page, 'asyncify', browserName)
  try {
    await load(
      page,
      false,
      program(`
clipboardMark("png-before-format");clipboardMark("png-format:"+int(Clipboard.hasFormat(cbfText)));
clipboardMark("png-before-read");clipboardMark("png-read:"+typeof Clipboard.asText);
clipboardMark("png-before-write");Clipboard.asText=${JSON.stringify(unicode)};clipboardMark("png-written");
var text=Clipboard.asText;clipboardMark("png-replaced:"+int(text===${JSON.stringify(unicode)}));`),
    )
    // Install a synthetic-data fixture button. The native write itself happens
    // only in its real click handler, with a valid PNG Blob prepared beforehand.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      canvas.getContext('2d')!.fillRect(0, 0, 1, 1)
      const png = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG unavailable')))),
        ),
        button = document.createElement('button'),
        result = document.createElement('output')
      button.id = 'clipboard-png-seed'
      button.textContent = 'Write synthetic PNG only'
      result.id = 'clipboard-png-result'
      button.addEventListener('click', () => {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
          () => (result.textContent = 'written'),
          (error: Error) => (result.textContent = `${error.name}:${error.message}`),
        )
      })
      document.body.append(button, result)
    })
    await page.locator('#clipboard-png-seed').click()
    await expect(page.locator('#clipboard-png-result')).toHaveText('written')
    await open(page)
    await perform(page, 'has-text', 'png-before-format', 'png-format:0')
    await perform(page, 'read-text', 'png-before-read', 'png-read:void')
    await perform(page, 'write-text', 'png-before-write', 'png-written')
    await perform(page, 'read-text', 'png-written', 'png-replaced:1')
    const calls = await evidence(page, info, setup.grants)
    successful(calls, ['write', 'read', 'read', 'writeText', 'read'])
    for (const call of calls.slice(1, 3)) {
      expect(call.types!.some((types) => types.includes('image/png'))).toBe(true)
      expect(call.types!.some((types) => types.includes('text/plain'))).toBe(false)
    }
    expect(calls[4].types!.some((types) => types.includes('text/plain'))).toBe(true)
  } finally {
    await stop(page, setup.errors)
  }
})

test('real same-origin buttons without permission grants preserve browser read policy and TJS errors', async ({
  page,
  browserName,
}, info) => {
  const setup = await prepare(page, 'asyncify', browserName, false)
  try {
    await load(
      page,
      false,
      program(`
clipboardMark("policy-before-write");Clipboard.asText=${JSON.stringify(unicode)};clipboardMark("policy-written");
try{var text=Clipboard.asText;clipboardMark("policy-read:"+int(text===${JSON.stringify(unicode)}));}
catch(e){clipboardMark("policy-error:"+int(e.message.indexOf("NotAllowedError")>=0));}
clipboardMark("policy-done");`),
    )
    await open(page)
    await perform(page, 'write-text', 'policy-before-write', 'policy-written')
    await perform(
      page,
      'read-text',
      'policy-written',
      browserName === 'chromium' ? 'policy-error:1' : 'policy-read:1',
    )
    await expect(mark(page, 'policy-done')).toBeVisible()
    const calls = await evidence(page, info, setup.grants)
    expect(calls.map((call) => call.method)).toEqual(['writeText', 'read'])
    successful(calls.slice(0, 1), ['writeText'])
    if (browserName === 'chromium') {
      // With this repository's default no-channel headless launch, Playwright
      // uses chromium-headless-shell. A real Chrome native prompt is not tested.
      expect(process.env.KRKR_TEST_HEADED).not.toBe('1')
      expect(calls[1].state).toBe('rejected')
      expect(calls[1].error?.name).toBe('NotAllowedError')
      await expect(mark(page, 'policy-read:1')).toHaveCount(0)
    } else successful(calls.slice(1), ['read'])
  } finally {
    await stop(page, setup.errors)
  }
})

test('a Timer Clipboard request inside System.inputString suspends only the parent answer controls', async ({
  page,
  browserName,
}, info) => {
  const setup = await prepare(page, 'asyncify', browserName)
  try {
    await load(
      page,
      false,
      program(`
global.clipboardTimer=new Timer(global,"clipboardTick");global.clipboardTimer.interval=100;
global.clipboardTimer.enabled=true;
var answer=System.inputString("Clipboard parent","Keep this answer while copying text.","parent initial");
clipboardMark("parent-return:"+answer);`) +
        `
function clipboardTick(){
clipboardTimer.enabled=false;clipboardMark("parent-copy-before");Clipboard.asText=${JSON.stringify(unicode)};
clipboardMark("parent-copy-written");var text=Clipboard.asText;clipboardMark("parent-copy-read:"+int(text===${JSON.stringify(unicode)}));
}
`,
    )
    await open(page)
    const dialog = page.getByRole('dialog', { name: 'Clipboard parent', exact: true }),
      input = dialog.getByRole('textbox', { name: '输入内容', exact: true }),
      confirm = dialog.locator('.system-dialog-actions [data-action="confirm"]')
    await expect(dialog).toBeVisible()
    await waiting(page, 'write-text', 'parent-copy-before')
    await expect(dialog.locator(panel)).toHaveCount(1)
    await expect(confirm).toBeDisabled()
    await expect(dialog.locator('.system-dialog-actions [data-action="cancel"]')).toBeDisabled()
    await expect(dialog.locator('.system-dialog-actions [data-action="stop"]')).toBeEnabled()
    await expect(input).toHaveValue('parent initial')
    await expect(input).toHaveJSProperty('readOnly', true)
    await expect(mark(page, 'parent-return:parent initial')).toHaveCount(0)
    await perform(page, 'write-text', 'parent-copy-before', 'parent-copy-written')
    await perform(page, 'read-text', 'parent-copy-written', 'parent-copy-read:1')
    await expect(confirm).toBeEnabled()
    await expect(input).toHaveValue('parent initial')
    await expect(input).toHaveJSProperty('readOnly', false)
    await input.fill('parent after clipboard')
    await confirm.click()
    await expect(mark(page, 'parent-return:parent after clipboard')).toBeVisible()
    successful(await evidence(page, info, setup.grants), ['writeText', 'read'])
  } finally {
    await stop(page, setup.errors)
  }
})

test('page-owned initial read records missing activation and the actual rejection before any automation evaluation', async ({
  page,
}, info) => {
  await observe(page)
  await page.route('**/clipboard-no-activation.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><title>Initial clipboard read</title>
<script>
navigator.clipboard.read().then(
  () => console.log("clipboard-initial-settled"),
  () => console.log("clipboard-initial-settled")
);
</script>`,
    }),
  )
  // A console event is a passive completion signal. Evaluating while waiting
  // would manufacture user activation in Playwright's browser drivers.
  const settled = page.waitForEvent('console', {
    predicate: (message) => message.text() === 'clipboard-initial-settled',
  })
  await Promise.all([settled, page.goto('/clipboard-no-activation.html')])
  const calls = await evidence(page, info, [])
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toBe('read')
  expect(calls[0].active).toBe(false)
  expect(calls[0].hasBeenActive).toBe(false)
  expect(calls[0].secure).toBe(true)
  expect(calls[0].state).toBe('rejected')
  expect(calls[0].error?.name).toBe('NotAllowedError')
})

test('production loader rejects a real manifest missing nativeClipboard before startup and retires its Worker', async ({
  page,
  browserName,
}, info) => {
  const setup = await prepare(page, 'asyncify', browserName, false),
    manifestBytes = await readFile(resolve('.generated/wasm/manifest.json')),
    manifestHash = createHash('sha256').update(manifestBytes).digest('hex'),
    // vite.config.ts emits this exact content-addressed filename and defines
    // src/player/build-info.ts's wasmManifestFile; SessionClient passes its
    // document-relative URL to the production createSession loader.
    manifestPath = `/wasm/manifest-${manifestHash.slice(0, 16)}.json`,
    matchManifest = (url: URL) => url.pathname === manifestPath,
    intercepted: { url: string; original: WasmManifest; served: WasmManifest }[] = [],
    routeErrors: string[] = [],
    workers: { url: string; closed: boolean }[] = []
  page.on('worker', (worker) => {
    if (!/\/session\.worker[-.]/.test(new URL(worker.url()).pathname)) return
    const entry = { url: worker.url(), closed: false }
    workers.push(entry)
    worker.on('close', () => (entry.closed = true))
  })
  await page.context().route(matchManifest, async (route) => {
    try {
      const response = await route.fetch(),
        bytes = await response.body()
      if (!response.ok() || !bytes.equals(manifestBytes))
        throw new Error('The served WASM manifest does not match the exact hosted test build')
      const original = JSON.parse(bytes.toString('utf8')) as WasmManifest,
        served = structuredClone(original)
      if (served.capabilities?.nativeClipboard !== 1)
        throw new Error('The unmodified hosted manifest lacks nativeClipboard=1')
      delete served.capabilities.nativeClipboard
      intercepted.push({ url: route.request().url(), original, served })
      await route.fulfill({ response, json: served })
    } catch (error) {
      routeErrors.push(String(error))
      await route.abort('failed')
    }
  })
  try {
    await load(
      page,
      false,
      `Debug.message("${prefix}manifest-startup-must-not-run");Clipboard.asText="unreachable text";`,
    )
    await expect(page.locator('#logs')).toContainText(
      'WASM manifest is missing native Clipboard support',
    )
    await expect(page.locator('#status')).toHaveText('运行失败')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await expect(page.locator('#stop')).toBeDisabled()
    await expect(page.locator('#evaluate')).toBeDisabled()
    await expect(page.locator(panel)).toHaveCount(0)
    await expect(mark(page, 'manifest-startup-must-not-run')).toHaveCount(0)
    await expect.poll(() => workers.map((worker) => worker.closed)).toEqual([true])
    expect(intercepted).toHaveLength(1)
    expect(routeErrors).toEqual([])
    const rejected = intercepted[0]
    expect({
      ...rejected.served,
      capabilities: { ...rejected.served.capabilities, nativeClipboard: 1 },
    }).toEqual(rejected.original)
    const failedLogs = await page.locator('#logs').innerText()
    await info.attach('missing-native-clipboard-loader-logs', {
      contentType: 'text/plain',
      body: failedLogs,
    })
    expect(failedLogs).not.toContain('Worker did not stop in time')
    expect(failedLogs).not.toContain('RPC client has been disposed')
    expect(await evidence(page, info, setup.grants)).toEqual([])
    expect(setup.errors).toEqual([])

    // Remove only this manifest intervention. The same application can then
    // create a fresh real Worker from the intact build without clipboard use.
    await page.context().unroute(matchManifest)
    await load(
      page,
      false,
      `var w=new Window();w.visible=true;Debug.message("${prefix}manifest-recovered");`,
    )
    await expect(mark(page, 'manifest-recovered')).toBeVisible()
    await expect(page.locator('#evaluate')).toBeEnabled()
    await expect(page.locator(panel)).toHaveCount(0)
    expect(await page.evaluate(() => window.clipboardProof.calls)).toEqual([])
  } finally {
    await info.attach('missing-native-clipboard-manifest-intervention', {
      contentType: 'application/json',
      body: JSON.stringify(
        { manifestPath, manifestHash, intercepted, routeErrors, workers },
        null,
        2,
      ),
    })
    await page.context().unroute(matchManifest)
    if (await page.locator('#stop').isEnabled()) await stop(page, setup.errors)
  }
})

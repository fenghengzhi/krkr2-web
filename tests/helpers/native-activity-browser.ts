import { test as base, expect, chromium, type Page, type CDPSession } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

type NativeActivity = {
  page: Page
  cdp: CDPSession
  hide(): Promise<void>
  show(): Promise<void>
  freeze(): Promise<void>
  thaw(): Promise<void>
}

// Playwright normally forces document focus/visibility through CDP. Use an owned
// raw browser and its default context with noDefaults to exercise trusted events.
export const test = base.extend<{ native: NativeActivity }>({
  native: [
    async ({}, use, testInfo) => {
      const profile = await mkdtemp(join(tmpdir(), 'krkr-native-activity-'))
      const child = spawn(
        chromium.executablePath(),
        [
          '--headless=new',
          // Match Playwright's Chromium sandbox setting on disposable Linux CI
          // runners, where unprivileged user namespaces can be unavailable.
          ...(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux'
            ? ['--no-sandbox']
            : []),
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-extensions',
          '--password-store=basic',
          '--use-mock-keychain',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      const exited = once(child, 'exit').catch(() => undefined)
      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
      try {
        const endpoint = await new Promise<string>((resolve, reject) => {
          let output = ''
          const timer = setTimeout(
            () => finish(new Error('Native Chromium did not expose CDP')),
            10_000,
          )
          const onData = (chunk: Buffer) => {
            output += chunk.toString()
            const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
            if (match) finish(undefined, match[1]!)
          }
          const onError = (error: Error) => finish(error)
          const onExit = () =>
            finish(
              new Error(
                `Native Chromium exited: ${output.length > 8000 ? output.slice(0, 4000) + '\n...\n' + output.slice(-4000) : output}`,
              ),
            )
          function finish(error?: Error, endpoint?: string) {
            clearTimeout(timer)
            child.stderr.off('data', onData)
            child.off('error', onError)
            child.off('exit', onExit)
            if (error) reject(error)
            else resolve(endpoint!)
          }
          child.stderr.on('data', onData)
          child.once('error', onError)
          child.once('exit', onExit)
        })
        browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
        const context = browser.contexts()[0]!,
          page = context.pages()[0]!
        const cdp = await context.newCDPSession(page)
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        const bounds = (windowState: 'minimized' | 'normal') =>
          cdp
            .send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
            .then(() => undefined)
        const lifecycle = (state: 'frozen' | 'active') =>
          cdp.send('Page.setWebLifecycleState', { state }).then(() => undefined)
        await page.addInitScript(() => {
          const state = window as unknown as {
            nativeLifecycle: { event: string; trusted: boolean; visibility: string; time: number }[]
          }
          state.nativeLifecycle = []
          const record = (event: Event) =>
            state.nativeLifecycle.push({
              event: event.type,
              trusted: event.isTrusted,
              visibility: document.visibilityState,
              time: performance.now(),
            })
          for (const name of ['visibilitychange', 'freeze', 'resume'])
            document.addEventListener(name, record, { capture: true })
          for (const name of ['pagehide', 'pageshow'])
            window.addEventListener(name, record, { capture: true })
        })
        try {
          await use({
            page,
            cdp,
            async hide() {
              await bounds('minimized')
              await page.waitForFunction(() => document.hidden, undefined, { polling: 50 })
            },
            async show() {
              await bounds('normal')
              await page.waitForFunction(() => !document.hidden, undefined, { polling: 50 })
            },
            freeze: () => lifecycle('frozen'),
            thaw: () => lifecycle('active'),
          })
        } finally {
          await lifecycle('active').catch(() => {})
          await bounds('normal').catch(() => {})
          if (!page.isClosed()) {
            const events = await page
              .evaluate(() => (window as unknown as { nativeLifecycle: unknown }).nativeLifecycle)
              .catch(() => undefined)
            await testInfo.attach('trusted-lifecycle', {
              body: JSON.stringify(events ?? [], null, 2),
              contentType: 'application/json',
            })
            if (testInfo.status !== testInfo.expectedStatus) {
              const state = await page
                .evaluate(() => ({
                  at: performance.now(),
                  visibility: document.visibilityState,
                  status: document.querySelector('#status')?.textContent,
                  logs: document.querySelector('#logs')?.textContent,
                  sound: document.querySelector('#sound-status')?.textContent,
                  audioState: (
                    globalThis as typeof globalThis & { __audioProbe?: AudioWorkletNode }
                  ).__audioProbe?.context.state,
                  videos: [...document.querySelectorAll('video')].map((video) => ({
                    currentTime: video.currentTime,
                    paused: video.paused,
                    readyState: video.readyState,
                    error: video.error?.message,
                  })),
                }))
                .catch((error) => ({ unavailable: String(error) }))
              await testInfo.attach('native-page-state', {
                body: JSON.stringify(state, null, 2),
                contentType: 'application/json',
              })
              await testInfo.attach('native-failure', {
                body: await page.screenshot(),
                contentType: 'image/png',
              })
            }
          }
        }
      } finally {
        // connectOverCDP().close() disconnects this client. Ask the owned
        // browser to shut down gracefully so its profile writers can finish.
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
        try {
          if (child.exitCode === null && child.signalCode === null) {
            if (browser?.isConnected()) {
              await browser
                .newBrowserCDPSession()
                .then((session) => session.send('Browser.close'))
                .catch(() => {})
            } else child.kill('SIGTERM')
          }
          await exited
        } finally {
          clearTimeout(timer)
          await browser?.close().catch(() => {})
        }
        // Filesystem cleanup may briefly race the last subprocess write even
        // after the browser exits. This retries removal, never the test body.
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    { timeout: 30_000 },
  ],
})
export { expect }
export async function nativeEvents(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          nativeLifecycle: { event: string; trusted: boolean; visibility: string; time: number }[]
        }
      ).nativeLifecycle,
  )
}

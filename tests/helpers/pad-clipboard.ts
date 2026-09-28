import { test, expect } from '@playwright/test'
import { evaluate } from './browser-expression.ts'
import { launchPads, padSource, padSurface } from './web-pad.ts'

interface PadClipboardCall {
  method: string
  active: boolean
  state: string
  delivery: string
  representation?: string
  error?: string
}
interface PadClipboardGate {
  next?: 'read' | 'writeText'
  release?: () => void
  events: { call: number; method: string; phase: string }[]
}
interface PadClipboardEvidence {
  padClipboardCalls: PadClipboardCall[]
  padClipboardGate: PadClipboardGate
}

/** Register only from clipboard.spec.ts: headed Firefox workers share the
 * display clipboard, so all real clipboard content cases need one test file. */
export function registerPadClipboardTests(): void {
  for (const backend of ['asyncify', 'jspi']) {
    for (const binary of [false, true]) {
      const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

      test(`${variant}: Pad menu clipboard actions use the real API and undo stays in its own editor`, async ({
        page,
        browserName,
      }, info) => {
        await page.addInitScript(() => {
          const calls: PadClipboardCall[] = [],
            gate: PadClipboardGate = { events: [] },
            hold = <T>(call: PadClipboardCall, value: T): Promise<T> =>
              new Promise<T>((resolve) => {
                call.delivery = 'held'
                const number = calls.indexOf(call) + 1
                gate.events.push({ call: number, method: call.method, phase: 'held' })
                gate.release = () => {
                  gate.release = undefined
                  call.delivery = 'released'
                  gate.events.push({ call: number, method: call.method, phase: 'released' })
                  resolve(value)
                }
              })
          Object.assign(window, { padClipboardCalls: calls, padClipboardGate: gate })
          for (const method of ['read', 'writeText'] as const) {
            const clipboard = navigator.clipboard,
              original = clipboard[method]
            Object.defineProperty(clipboard, method, {
              configurable: true,
              value: function (this: Clipboard, ...args: unknown[]) {
                const delayed = gate.next === method,
                  call: PadClipboardCall = {
                    method,
                    active: navigator.userActivation.isActive,
                    state: 'pending',
                    delivery: delayed ? 'awaiting-native' : 'direct',
                  }
                if (delayed) gate.next = undefined
                calls.push(call)
                try {
                  return Promise.resolve(Reflect.apply(original, this, args)).then(
                    (value) => {
                      call.state = 'fulfilled'
                      if (delayed && method === 'read') {
                        for (const item of value as ClipboardItem[]) {
                          const getType = item.getType
                          Object.defineProperty(item, 'getType', {
                            configurable: true,
                            value: function (this: ClipboardItem, type: string) {
                              call.representation = 'type-pending'
                              return Reflect.apply(getType, this, [type]).then((blob: Blob) => {
                                call.representation = 'type-fulfilled'
                                const text = blob.text
                                Object.defineProperty(blob, 'text', {
                                  configurable: true,
                                  value: function (this: Blob) {
                                    call.representation = 'text-pending'
                                    return Reflect.apply(text, this, []).then((result: string) => {
                                      call.representation = 'text-fulfilled'
                                      return result
                                    })
                                  },
                                })
                                return blob
                              })
                            },
                          })
                        }
                      }
                      // Native APIs and representation reads execute exactly once
                      // with their real receiver/result. Only delivery is held.
                      return delayed ? hold(call, value) : value
                    },
                    (error: unknown) => {
                      call.state = 'rejected'
                      call.error = error instanceof Error ? error.name : String(error)
                      throw error
                    },
                  )
                } catch (error) {
                  call.state = 'rejected'
                  call.error = error instanceof Error ? error.name : String(error)
                  throw error
                }
              },
            })
          }
        })
        const game = await launchPads(page, backend, binary, padSource),
          first = padSurface(page, 'First pad'),
          second = padSurface(page, 'Second pad'),
          value = `Pad clipboard ${variant} 雪😀`,
          grants =
            browserName === 'chromium'
              ? ['clipboard-read', 'clipboard-write']
              : browserName === 'webkit'
                ? ['clipboard-read']
                : []
        try {
          await first.locator('textarea').fill(value)
          await page.keyboard.press('ControlOrMeta+a')
          await first.locator('[data-action="menu"]').click()
          await first.locator('[data-action="copy"]').click()
          if (browserName === 'chromium') {
            await expect(first.locator('.game-pad-notice')).toContainText('NotAllowedError:')
            await expect(first.locator('textarea')).toHaveValue(value)
          } else await expect(first.locator('.game-pad-notice')).toHaveText('已复制。')
          if (grants.length)
            await page.context().grantPermissions(grants, { origin: new URL(page.url()).origin })
          await first.locator('[data-action="copy"]').click()
          await expect(first.locator('.game-pad-notice')).toHaveText('已复制。')
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (window as unknown as { padClipboardCalls: { state: string }[] })
                    .padClipboardCalls[1]?.state,
              ),
            )
            .toBe('fulfilled')
          await first.locator('textarea').focus()
          await page.keyboard.press('ArrowRight')
          expect(
            await first.locator('textarea').evaluate((element) => {
              const text = element as HTMLTextAreaElement
              return text.selectionStart === text.selectionEnd
            }),
          ).toBe(true)
          for (const action of ['copy', 'cut']) {
            await first.locator(`[data-action="${action}"]`).click()
            expect(
              await page.evaluate(
                () =>
                  (window as unknown as { padClipboardCalls: unknown[] }).padClipboardCalls.length,
              ),
            ).toBe(2)
            await expect(first.locator('textarea')).toHaveValue(value)
          }
          // Read the actual clipboard through the second editor after both
          // collapsed-selection commands; neither may clear its existing text.
          await second.locator('textarea').fill('')
          await second.locator('[data-action="menu"]').click()
          await second.locator('[data-action="paste"]').click()
          await expect(second.locator('textarea')).toHaveValue(value)
          await second.locator('textarea').focus()
          await page.keyboard.press('ControlOrMeta+a')
          await second.locator('[data-action="cut"]').click()
          await expect(second.locator('textarea')).toHaveValue('')
          await second.locator('[data-action="undo"]').click()
          await expect(second.locator('textarea')).toHaveValue(value)
          await second.locator('[data-action="redo"]').click()
          await expect(second.locator('textarea')).toHaveValue('')
          await expect(first.locator('textarea')).toHaveValue(value)
          await evaluate(page, `first.text==${JSON.stringify(value)} && second.text==""`, '1')

          // Cut has already written the real clipboard when its result is held.
          // Moving to the other editor must prevent a late deletion/focus steal.
          await first.locator('textarea').focus()
          await page.keyboard.press('ControlOrMeta+a')
          await page.evaluate(() => {
            ;(window as unknown as PadClipboardEvidence).padClipboardGate.next = 'writeText'
          })
          await first.locator('[data-action="cut"]').click()
          await expect
            .poll(() =>
              page.evaluate(() => {
                const call = (window as unknown as PadClipboardEvidence).padClipboardCalls[4]
                return [call?.state, call?.delivery]
              }),
            )
            .toEqual(['fulfilled', 'held'])
          await second.locator('textarea').focus()
          await expect(second.locator('textarea')).toBeFocused()
          await page.evaluate(() =>
            (window as unknown as PadClipboardEvidence).padClipboardGate.release!(),
          )
          await expect(first.locator('textarea')).toHaveValue(value)
          await expect(second.locator('textarea')).toBeFocused()

          // A fulfilled real read is delivered only after the user chooses a new
          // caret position in the same Pad. The old replacement range is stale.
          await first.locator('textarea').fill('selection stays intact')
          await expect(first).toHaveAttribute('data-edit-pending', 'false')
          await first.locator('textarea').focus()
          await page.keyboard.press('ControlOrMeta+a')
          await page.evaluate(() => {
            ;(window as unknown as PadClipboardEvidence).padClipboardGate.next = 'read'
          })
          await first.locator('[data-action="paste"]').click()
          await expect
            .poll(() =>
              page.evaluate(() => {
                const call = (window as unknown as PadClipboardEvidence).padClipboardCalls[5]
                return [call?.state, call?.delivery]
              }),
            )
            .toEqual(['fulfilled', 'held'])
          await first.locator('textarea').focus()
          await page.keyboard.press('ArrowRight')
          await page.keyboard.press('ArrowLeft')
          const chosen = await first.locator('textarea').evaluate((element) => {
            const text = element as HTMLTextAreaElement
            return [text.selectionStart, text.selectionEnd, text.selectionDirection]
          })
          expect(chosen[0]).toBe(chosen[1])
          await page.evaluate(() =>
            (window as unknown as PadClipboardEvidence).padClipboardGate.release!(),
          )
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (window as unknown as PadClipboardEvidence).padClipboardCalls[5]?.representation,
              ),
            )
            .toBe('text-fulfilled')
          await expect(first.locator('textarea')).toHaveValue('selection stays intact')
          await expect(first.locator('textarea')).toBeFocused()
          expect(
            await first.locator('textarea').evaluate((element) => {
              const text = element as HTMLTextAreaElement
              return [text.selectionStart, text.selectionEnd, text.selectionDirection]
            }),
          ).toEqual(chosen)
          await evaluate(page, 'first.text=="selection stays intact" && second.text==""', '1')

          const proof = await page.evaluate(() => ({
              calls: (window as unknown as PadClipboardEvidence).padClipboardCalls,
              gates: (window as unknown as PadClipboardEvidence).padClipboardGate.events,
            })),
            calls = proof.calls
          await info.attach('pad-real-clipboard.json', {
            body: JSON.stringify({ browser: browserName, grants, ...proof }, null, 2),
            contentType: 'application/json',
          })
          expect(calls.map((call) => call.method)).toEqual([
            'writeText',
            'writeText',
            'read',
            'writeText',
            'writeText',
            'read',
          ])
          expect(calls.every((call) => call.active)).toBe(true)
          expect(calls.map((call) => call.state)).toEqual([
            browserName === 'chromium' ? 'rejected' : 'fulfilled',
            'fulfilled',
            'fulfilled',
            'fulfilled',
            'fulfilled',
            'fulfilled',
          ])
          expect(calls.slice(4).map((call) => call.delivery)).toEqual(['released', 'released'])
          expect(proof.gates).toEqual([
            { call: 5, method: 'writeText', phase: 'held' },
            { call: 5, method: 'writeText', phase: 'released' },
            { call: 6, method: 'read', phase: 'held' },
            { call: 6, method: 'read', phase: 'released' },
          ])
          if (browserName === 'chromium') expect(calls[0].error).toBe('NotAllowedError')
        } finally {
          await game.stop()
        }
      })
    }
  }
}

import { expect, test } from '@playwright/test'
import { originalIntroduction } from '../helpers/kag-intro-package.ts'
import { kagIntroSource, kagIntroStateExpression } from '../helpers/kag-intro-observation.ts'

interface Reading {
  label: string; waiting: boolean; line: boolean; page: boolean
  row: number; column: number; status: number; links: number; background: string; tag: string
}
interface HistoryView {
  shown: boolean; visible: boolean; modal: boolean; focused: boolean; everyPage: boolean; canScroll: boolean
  start: number; lines: number; count: number; previous: boolean; next: boolean
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: unchanged Introduction supports keyboard choices, long history paging and return to the same reading position`, async ({ page }, info) => {
    test.setTimeout(240000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [], pressed = new Set<string>(),
      canvas = page.locator('#stage canvas[data-window-id]'), input = page.locator('#stage textarea.game-text-input')
    let sequence = 0, loaded = false, exited = false
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const read = async (expression: string) => {
      const prefix = `intro-history-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      // The real console focuses its own input. Observations run only after
      // releasing the player's key, never while relying on its pressed state.
      await page.evaluate((source) => {
        const field = document.querySelector<HTMLInputElement>('#expression')!,
          button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Introduction observer is unavailable')
        field.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: sequence === 1 ? 30000 : 5000 })
      return ((await line.textContent()) ?? '').slice(prefix.length)
    }
    const reading = async (): Promise<Reading | undefined> => {
      const raw = await read(kagIntroStateExpression)
      if (raw === 'pending') return
      const fields = raw.split('|'); expect(fields).toHaveLength(11)
      return { label: fields[0]!, waiting: fields[1] === '1', line: fields[2] === '1', page: fields[3] === '1',
        row: Number(fields[4]), column: Number(fields[5]), status: Number(fields[6]), links: Number(fields[7]),
        background: fields[8]!, tag: fields[10]! }
    }
    const cursor = (value: Reading) => [value.label, value.row, value.column, value.status, value.tag, value.background]
    const at = async (label: string, kind: 'line' | 'page' | 'choice', before?: Reading) => {
      let found: Reading | undefined
      await expect.poll(async () => {
        found = await reading()
        return !!found && found.label === label && (!before || found.row !== before.row || found.column !== before.column || found.label !== before.label) &&
          (kind === 'choice' ? found.status === 0 && found.links > 0
            : found.waiting && found[kind] && found.tag === (kind === 'line' ? 'l' : 'p'))
      }, { timeout: 15000 }).toBe(true)
      observations.push({ reading: found })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
      return found!
    }
    const key = async <T,>(name: string, observe: () => Promise<T>, shift = false): Promise<T> => {
      await canvas.focus(); await expect(input).toBeFocused()
      const problems: unknown[] = []
      let result!: T
      try {
        // Stock KAG checks whether the reading key is physically held. Use
        // one explicit human-duration press; do not retry it or poll the VM
        // through the focus-taking console while the key is down.
        if (shift) pressed.add('Shift')
        pressed.add(name)
        await page.keyboard.press(shift ? `Shift+${name}` : name, { delay: 200 })
        pressed.delete(name); if (shift) pressed.delete('Shift')
        result = await observe()
      } catch (error) { problems.push(error) }
      for (const release of shift ? [name, 'Shift'] : [name]) {
        if (!pressed.has(release)) continue
        try { await page.keyboard.up(release); pressed.delete(release) }
        catch (error) { problems.push(error) }
      }
      observations.push({ key: name, shift, holdMilliseconds: 200 })
      if (problems.length === 1) throw problems[0]
      if (problems.length) throw new AggregateError(problems, 'Original game key or release failed', { cause: problems[0] })
      return result
    }
    const selected = async () => {
      const values = (await read('[int(kag.focusedLayer===kag.current),kag.current.keyLink].join("|")')).split('|')
      expect(values).toHaveLength(2)
      return { focused: values[0] === '1', index: Number(values[1]) }
    }
    const tab = async (count: number, expected?: number, shift = false) => key('Tab', async () => {
      let chosen = -1
      await expect.poll(async () => {
        const value = await selected(); chosen = value.index
        return value.focused && chosen >= 0 && chosen < count && (expected === undefined || chosen === expected)
      }, { timeout: 15000 }).toBe(true)
      return chosen
    }, shift)
    const select = async (index: number, target: string, count: number) => {
      let current = (await selected()).index
      if (current < 0 || !(await selected()).focused) current = await tab(count)
      for (let step = 0; current !== index && step < count; step++) current = await tab(count, (current + 1) % count)
      expect(current).toBe(index)
      expect(await read(`kag.current.links[${index}].target===void?"":kag.current.links[${index}].target`)).toBe(target)
    }
    const advance = (before: Reading, label: string, kind: 'line' | 'page' | 'choice') =>
      key('Enter', () => at(label, kind, before))
    const finishPage = async (label: string, remaining: number, before: Reading) => {
      let current = before
      for (let i = 0; i < remaining; i++) current = await advance(current, label, i + 1 === remaining ? 'page' : 'line')
      return current
    }
    const history = async (): Promise<HistoryView> => {
      const values = (await read(`(function(){var h=kag.historyLayer;return [int(kag.historyShowing),int(h.visible),
        int(kag.currentModalLayer===h),int(kag.focusedLayer===h),int(h.everypage),int(h.canScroll),
        h.dispStart,h.dispLines,h.dataLines,int(h.prevPageButton.enabled),int(h.nextPageButton.enabled)].join("|");})()`)).split('|')
      expect(values).toHaveLength(11)
      return { shown: values[0] === '1', visible: values[1] === '1', modal: values[2] === '1', focused: values[3] === '1',
        everyPage: values[4] === '1', canScroll: values[5] === '1', start: Number(values[6]), lines: Number(values[7]),
        count: Number(values[8]), previous: values[9] === '1', next: values[10] === '1' }
    }
    const historyAt = async (start: number) => {
      let view: HistoryView | undefined
      await expect.poll(async () => { view = await history(); return view.shown && view.focused && view.start === start },
        { timeout: 15000 }).toBe(true)
      expect(view!.visible).toBe(true); expect(view!.modal).toBe(true); expect(view!.everyPage).toBe(false)
      expect(view!.previous).toBe(start !== 0); expect(view!.next).toBe(start < view!.count - view!.lines)
      observations.push({ history: view }); return view!
    }
    const historyText = () => read(String.raw`(function(){var h=kag.historyLayer,lines=[];
      for(var i=0;i<h.dataLines;i++)lines.add(string(h.getLine(i)));return lines.join("\n");})()`)
    const screenshot = async (name: string) => {
      await canvas.scrollIntoViewIfNeeded()
      await info.attach(name, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
    }
    try {
      const bytes = await originalIntroduction()
      await info.attach('original-introduction.xp3', { body: bytes, contentType: 'application/octet-stream' })
      await page.locator('#files').setInputFiles({ name: 'kag3_intro.xp3', mimeType: 'application/octet-stream', buffer: bytes }); loaded = true
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const fullscreen = page.locator('.leave-fullscreen'); if (await fullscreen.isVisible()) await fullscreen.press('Enter')
      await expect(canvas).toHaveCount(1); await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      const menu = await at('*syokai_start', 'choice'); expect(menu.links).toBe(3)
      const first = await tab(3)
      await tab(3, (first + 1) % 3); await tab(3, first, true)
      await select(0, '*about_kirikiri', 3)
      let current = await key('Enter', () => at('*about_kirikiri', 'line'))
      current = await finishPage('*about_kirikiri', 3, current)
      current = await advance(current, '*about_kirikiri2', 'line')
      current = await finishPage('*about_kirikiri2', 4, current)
      current = await advance(current, '*about_kirikiri3', 'line')
      const readingBeforeHistory = current
      await key('r', async () => {
        await expect.poll(async () => (await history()).shown, { timeout: 15000 }).toBe(true)
      })
      const initial = await history()
      expect(initial.canScroll).toBe(true); expect(initial.count).toBeGreaterThan(initial.lines)
      expect(initial.lines).toBeGreaterThan(0)
      const bottom = initial.count - initial.lines
      await historyAt(bottom)
      const originalHistory = await historyText(), normalized = originalHistory.replace(/\s+/g, ' ').trim()
      expect(normalized).toContain('using a script language called TJS.')
      expect(normalized).toContain('Kirikiri composes screens by overlaying multiple sheets called layers.')
      expect(normalized).toContain('PCM, with independent volume control for each.')
      await info.attach('original-history-retained-text', { body: originalHistory, contentType: 'text/plain' })
      expect(cursor((await reading())!)).toEqual(cursor(readingBeforeHistory))
      await screenshot('original-history-bottom')
      await key('ArrowUp', () => historyAt(bottom - 1))
      await key('ArrowDown', () => historyAt(bottom))
      let start = bottom
      for (let pages = 0; start > 0 && pages < 32; pages++) {
        start = Math.max(0, start - initial.lines)
        await key('PageUp', () => historyAt(start))
      }
      expect(start).toBe(0)
      await screenshot('original-history-first-page')
      for (let pages = 0; start < bottom && pages < 32; pages++) {
        start = Math.min(bottom, start + initial.lines)
        await key('PageDown', () => historyAt(start))
      }
      expect(start).toBe(bottom); expect(await historyText()).toBe(originalHistory)
      expect(cursor((await reading())!)).toEqual(cursor(readingBeforeHistory))
      await screenshot('original-history-returned-bottom')
      await key('Escape', async () => {
        await expect.poll(async () => (await history()).shown, { timeout: 15000 }).toBe(false)
      })
      const closed = await history(); expect(closed.visible).toBe(false); expect(closed.modal).toBe(false)
      expect(cursor((await reading())!)).toEqual(cursor(readingBeforeHistory))
      expect(await historyText()).toBe(originalHistory)
      await screenshot('reading-restored-after-history')
      current = await finishPage('*about_kirikiri3', 3, readingBeforeHistory)
      current = await advance(current, '*about_kirikiri4', 'line')
      for (let line = 0; line < 4; line++) current = await advance(current, '*about_kirikiri4', line === 3 ? 'choice' : 'line')
      expect(current.links).toBe(1)
      await select(0, '*to_syokai_start', 1)
      const returned = await key('Enter', () => at('*syokai_start', 'choice'))
      expect(returned.links).toBe(3); expect(returned.background).toBe('_24_5')
      await screenshot('original-title-after-keyboard-route')
      await select(2, '', 3); expect(await read('kag.current.links[2].exp')).toContain('kag.shutdown()')
      await key('Enter', async () => { await expect(page.locator('#status')).toHaveText('待机', { timeout: 15000 }) })
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([]); exited = true
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('original-keyboard-history', { contentType: 'application/json', body: JSON.stringify({ source: kagIntroSource, backend,
        observations, errors, exited, failures: failures.map(String),
        scope: 'One unchanged original XP3; real 200ms Tab/Shift+Tab/Enter presses, every first-route reading wait, R/arrow/PageUp/PageDown/Escape History navigation, unchanged reading cursor and complete retained History text, Return and original Exit. Console only observes after key release; every new key first restores real game focus. No repeated input on a failed wait.' }, null, 2) }),
      async () => info.attach('original-keyboard-history-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    for (const name of pressed) try { await page.keyboard.up(name) } catch (error) { failures.push(error) }
    if (loaded && !exited) try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Original keyboard history route or cleanup failed', { cause: failures[0] })
  })

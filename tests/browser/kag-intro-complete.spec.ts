import { test, expect } from '@playwright/test'
import { originalIntroduction } from '../helpers/kag-intro-package.ts'
import { kagIntroSource, kagIntroStateExpression } from '../helpers/kag-intro-observation.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { observeStartup, attachStartup } from '../helpers/startup-observation.ts'

interface ReadingState {
  raw: string; label: string; waiting: boolean; line: boolean; page: boolean
  curLine: number; curPos: number; conductor: number; links: number; lastTag: string
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: unchanged Introduction completes KAG text effects, vertical dialogue, transitions and the editable calculation before returning to its menu`, async ({ page }, info) => {
    // This route contains all eight authored 3-second transition examples,
    // normal typewriter text and over fifty explicit reading waits. Keep each
    // individual wait at 15s; the larger whole-route budget does not skip time.
    test.setTimeout(360000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [], stages: string[] = [],
      canvas = page.locator('#stage canvas[data-window-id]'), { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 })
    let loaded = false, exited = false, previous = ''
    const automaticPages = new Set<string>()
    page.on('pageerror', (error) => errors.push(error.message))
    await observeStartup(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const state = async (): Promise<ReadingState | undefined> => {
      const raw = await read(kagIntroStateExpression)
      if (raw === 'pending') return
      const fields = raw.split('|'); expect(fields).toHaveLength(11)
      const result = { raw, label: fields[0]!, waiting: fields[1] === '1', line: fields[2] === '1', page: fields[3] === '1',
        curLine: Number(fields[4]), curPos: Number(fields[5]), conductor: Number(fields[6]), links: Number(fields[7]), lastTag: fields[10]! }
      if (raw !== previous && (result.waiting || result.conductor === 0)) {
        previous = raw; observations.push({ wait: result })
      }
      return result
    }
    const at = async (label: string, kind: 'line' | 'page' | 'choice', changed?: ReadingState) => {
      let found: ReadingState | undefined
      await expect.poll(async () => {
        found = await state()
        // Long original transition chapters paginate according to the host
        // font. This is a separate real reading action, never a replacement
        // for the authored [l]/[p] checkpoint or an accepted menu boundary.
        if (found && found.label === label && kind !== 'choice' && found.waiting && found.page && found.lastTag !== 'p') {
          if (!automaticPages.has(found.raw)) {
            expect(automaticPages.size).toBeLessThan(32)
            automaticPages.add(found.raw); observations.push({ automaticPage: found })
            await readingClick(found)
          }
          return false
        }
        return !!found && found.label === label && found.raw !== changed?.raw && (kind === 'choice'
          ? found.conductor === 0 && found.links > 0
          : found.waiting && found[kind] && found.lastTag === (kind === 'line' ? 'l' : 'p'))
      }, { timeout: 15000 }).toBe(true)
      expect(errors).toEqual([]); await expect(page.locator('#logs .error')).toHaveCount(0)
      return found!
    }
    const capture = async (name: string) => {
      stages.push(name); await canvas.scrollIntoViewIfNeeded()
      await info.attach(name, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
    }
    const readingClick = async (before: ReadingState) => {
      // The original framed message1 has a smaller extent than message0.
      // Click inside the current, visible message rather than the old canvas
      // corner. These reading checkpoints contain no active selection links.
      const coordinates = (await read(`(function(){var m=kag.current,x=0,y=0;
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [Math.min(640,x+m.width)-16,Math.min(480,y+m.height)-16,int(m.visible)].join("|");})()`)).split('|')
      expect(coordinates).toHaveLength(3); expect(coordinates[2]).toBe('1')
      const x = Number(coordinates[0]), y = Number(coordinates[1])
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      observations.push({ readingClick: { before, x, y, box } })
      await canvas.click({ position: { x: x * box!.width / 640, y: y * box!.height / 480 } })
    }
    const advance = async (before: ReadingState, label: string, kind: 'line' | 'page' | 'choice') => {
      await readingClick(before)
      return at(label, kind, before)
    }
    const pageEnd = async (label: string, lines: number, first: ReadingState) => {
      let current = first
      for (let i = 0; i < lines; i++) current = await advance(current, label, i + 1 === lines ? 'page' : 'line')
      return current
    }
    const enterAnswer = async (answer: string, expectedBefore: string) => {
      const data = (await read(`(function(){var m=kag.current,l=m.links[0],o=l.object,x=o.width/2,y=o.height/2;
        for(var p=o;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,o.text,f.input,int(o.enabled),int(o instanceof "LinkEditLayer")].join("|");})()`)).split('|')
      expect(data).toHaveLength(6); expect(data[2]).toBe(expectedBefore); expect(data[3]).toBe(expectedBefore)
      expect(data.slice(4)).toEqual(['1', '1'])
      for (const [index, limit] of [[0,640],[1,480]] as const) {
        expect(Number(data[index])).toBeGreaterThanOrEqual(0); expect(Number(data[index])).toBeLessThan(limit)
      }
      await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: Number(data[0]) * box!.width / 640, y: Number(data[1]) * box!.height / 480 } })
      await page.keyboard.press('Control+a'); await page.keyboard.type(answer)
      await expect.poll(() => read('kag.current.links[0].object.text+"|"+f.input'), { timeout: 15000 }).toBe(answer + '|' + expectedBefore)
      observations.push({ answerInput: answer, before: expectedBefore, via: 'original EditLayer, actual Control+A and digit keys' })
    }
    try {
      const bytes = await originalIntroduction()
      await info.attach('original-kag-intro.xp3', { body: bytes, contentType: 'application/octet-stream' })
      await page.locator('#files').setInputFiles({ name: 'kag3_intro.xp3', mimeType: 'application/octet-stream', buffer: bytes }); loaded = true
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const fullscreen = page.locator('.leave-fullscreen'); if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      const menu = await at('*syokai_start', 'choice'); expect(menu.links).toBe(3)
      await clickLink(1, '*about_kag')
      let current = await pageEnd('*about_kag', 4, await at('*about_kag', 'line'))
      current = await advance(current, '*about_kag3', 'line')
      current = await advance(current, '*about_kag3', 'line') // Large font, second [l].
      await capture('large-original-text')
      current = await advance(current, '*about_kag3', 'line') // Ruby, third [l].
      await capture('original-ruby')
      current = await advance(current, '*about_kag3', 'line') // Outlined text, fourth [l].
      expect(await read('kag.current.edgeEmphasis')).toBe('512')
      await capture('original-outlined-text-512')
      current = await pageEnd('*about_kag3', 4, current) // Center, right, graph, then [p].
      current = await advance(current, '*about_kag4', 'line')
      expect(await read('int(kag.current.vertical)')).toBe('1'); await capture('original-vertical-dialogue')
      current = await advance(current, '*about_kag4', 'page')
      current = await advance(current, '*about_kag4', 'line')
      expect(await read('int(kag.current===kag.fore.messages[1])+"|"+int(kag.current.vertical)')).toBe('1|0')
      await capture('original-framed-dialogue')
      current = await advance(current, '*about_kag4', 'page')
      current = await advance(current, '*about_kag5', 'line')
      expect(await read('kag.fore.layers[0].opacity+"|"+kag.fore.layers[0].Anim_loadParams.storage')).toBe('255|uni')
      current = await advance(current, '*about_kag5', 'line')
      expect(await read('kag.fore.layers[0].opacity')).toBe('128'); await capture('original-translucent-character')
      current = await advance(current, '*about_kag5', 'page')
      current = await advance(current, '*about_kag6', 'line')
      current = await pageEnd('*about_kag6', 11, current)
      await capture('original-three-transition-families')
      current = await advance(current, '*about_kag7', 'line')
      current = await pageEnd('*about_kag7', 5, current)
      current = await advance(current, '*about_kag8', 'line')
      current = await pageEnd('*about_kag8', 3, current)
      current = await advance(current, '*about_kag_var_0', 'choice'); expect(current.links).toBe(3)
      const operands = (await read('[f.v1,f.v2,f.ans].join("|")')).split('|').map(Number)
      expect(operands).toHaveLength(3)
      for (const operand of operands.slice(0,2)) { expect(Number.isInteger(operand)).toBe(true); expect(operand).toBeGreaterThanOrEqual(1); expect(operand).toBeLessThanOrEqual(9) }
      expect(operands[2]).toBe(operands[0]! * operands[1]!)
      const wrong = String(operands[2]! + 1), correct = String(operands[2])
      await enterAnswer(wrong, ''); await clickLink(1, '*about_kag_var_1')
      current = await at('*about_kag_var_1', 'line'); expect(await read('f.input')).toBe(wrong)
      await capture('original-wrong-answer')
      current = await advance(current, '*about_kag_var_1', 'page')
      current = await advance(current, '*about_kag_var_0', 'choice')
      await enterAnswer(correct, wrong); await clickLink(1, '*about_kag_var_1')
      current = await at('*about_kag_var_correct', 'page'); expect(await read('f.input')).toBe(correct)
      await capture('original-correct-answer')
      current = await advance(current, '*about_kag_9', 'line')
      current = await pageEnd('*about_kag_9', 4, current)
      current = await advance(current, '*about_kag_fin', 'line')
      current = await advance(current, '*about_kag_fin', 'line')
      current = await advance(current, '*about_kag_fin', 'choice'); expect(current.links).toBe(2)
      await capture('original-kag-ending')
      await clickLink(1, '*to_syokai_start')
      const returned = await at('*syokai_start', 'choice'); expect(returned.links).toBe(3)
      await capture('returned-to-original-title')
      expect(await read('kag.current.links[2].exp')).toContain('kag.shutdown()')
      await clickLink(2, '')
      await expect(page.locator('#status')).toHaveText('待机', { timeout: 15000 })
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
      exited = true; stages.push('original-exit')
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('original-kag-complete-evidence', { contentType: 'application/json', body: JSON.stringify({ source: kagIntroSource, backend,
        stages, observations, errors, exited, failures: failures.map(String),
        scope: 'One unchanged XP3; actual second-route links, every authored explicit reading wait, normal transitions, original EditLayer wrong/correct calculation, return-to-menu and Exit. Console reads only observe. No scenario jumping, replacement handler, speed change, synthetic clipboard or plugin execution.' }, null, 2) }),
      async () => info.attach('original-kag-complete-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      () => attachStartup(page, info, 'original-kag-complete', errors),
    ]) try { await report() } catch (error) { failures.push(error) }
    if (loaded && !exited) try {
      const modalStop = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modalStop.count()) await modalStop.last().click()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original KAG second route or cleanup failed', { cause: failures[0] })
  })

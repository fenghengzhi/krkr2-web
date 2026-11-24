import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { observeStartup, attachStartup } from '../helpers/startup-observation.ts'
import { kagIntroSource as source, kagIntroStateExpression as stateExpression,
  kagIntroLayoutExpression, kagIntroLayoutFields } from '../helpers/kag-intro-observation.ts'

let packageRequest: Promise<Buffer> | undefined
function originalPackage(): Promise<Buffer> {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Original KAG introduction acquisition and verification require a GitHub-hosted runner')
  return packageRequest ??= (async () => {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('Original introduction download returned HTTP ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBe(source.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256)
    return bytes
  })()
}

interface State {
  label: string; waiting: boolean; line: boolean; page: boolean
  curLine: number; curPos: number; conductor: number; links: number; background: string; storage: string; lastTag: string
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: original Introduction package completes its first route with bookmark and refresh restoration`, async ({ page }, info) => {
    test.setTimeout(180000)
    const errors: string[] = [], failures: unknown[] = [], steps: string[] = [], observations: unknown[] = [], inputs: unknown[] = []
    let evaluation = 0, loaded = false, exited = false, previousState = '', waitObservations = 0
    const evidence: Record<string, unknown> = {
      source, backend, browser: info.project.name, steps, observations, inputs, pageErrors: errors,
      scope: 'Runs the pinned Introduction to Kirikiri and KAG distribution sample through its original menu, page waits, bookmark methods and Exit link. Imports one unchanged XP3 and executes its original source scripts with the selected WASM backend.',
      importedFiles: ['kag3_intro.xp3'], originalScenarioUnmodified: true,
      layoutFields: kagIntroLayoutFields,
      waitEvidence: 'lastTagName is the original Conductor field also consulted by MainWindow.showPageBreakAndClear; automatic pagination is recorded but never accepted as an explicit [p] reading checkpoint.',
    }
    page.on('pageerror', (error) => errors.push(error.message))
    await observeStartup(page)
    const canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `intro-read-${++evaluation}:`
      await page.locator('#expression').fill(`${JSON.stringify(prefix)}+string(${expression})`)
      await page.locator('#evaluate').click()
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      return ((await output.textContent()) ?? '').slice(prefix.length)
    }
    const state = async (): Promise<State | undefined> => {
      const value = await read(stateExpression)
      if (value === 'pending') return undefined
      const [label, waiting, line, pageWait, curLine, curPos, conductor, links, background, storage, lastTag] = value.split('|')
      expect(value.split('|')).toHaveLength(11)
      const result = { label: label!, waiting: waiting === '1', line: line === '1', page: pageWait === '1',
        curLine: Number(curLine), curPos: Number(curPos), conductor: Number(conductor), links: Number(links),
        background: background!, storage: storage!, lastTag: lastTag! }
      // Retain the first blocked wait as well as successful checkpoints. Old
      // evidence had no observations when the initial menu itself paginated.
      if (value !== previousState && waitObservations < 96 && (result.waiting || result.conductor === 0)) {
        previousState = value
        waitObservations++
        const observation: Record<string, unknown> = { stage: 'observed-wait', state: result,
          waitKind: result.page ? result.lastTag === 'p' ? 'explicit-p' : 'automatic-page'
            : result.line ? result.lastTag === 'l' ? 'explicit-l' : 'other-line' : 'choice' }
        observations.push(observation)
        // A diagnostic read must not replace the route's primary assertion.
        try {
          const layout = (await read(kagIntroLayoutExpression)).split('|')
          expect(layout).toHaveLength(kagIntroLayoutFields.length)
          observation.layout = Object.fromEntries(kagIntroLayoutFields.map((key, index) => [key, layout[index]]))
        } catch (error) { observation.layoutError = String(error) }
      }
      return result
    }
    const at = async (label: string, kind: 'line' | 'page' | 'choice', changedFrom?: State): Promise<State> => {
      let observed: State | undefined
      await expect.poll(async () => {
        observed = await state()
        if (!observed || observed.label !== label) return false
        if (changedFrom && observed.curLine === changedFrom.curLine && observed.curPos === changedFrom.curPos &&
            observed.label === changedFrom.label) return false
        return kind === 'choice' ? observed.conductor === 0 && observed.links > 0
          : observed.waiting && observed[kind] && observed.lastTag === (kind === 'line' ? 'l' : 'p')
      }, { timeout: 15000 }).toBe(true)
      expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
      return observed!
    }
    const capture = async (stage: string, observed?: State) => {
      observations.push({ stage, state: observed ?? await state() })
      if (['original-menu', 'route-page-2-bookmark', 'original-bookmark-restored',
        'fresh-session-original-menu', 'refresh-bookmark-restored', 'returned-to-original-menu'].includes(stage)) {
        await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
        await info.attach(stage, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      }
      steps.push(stage)
    }
    const readyConsole = async () => {
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const fullscreen = page.locator('.leave-fullscreen')
      if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(page.locator('#stage')).not.toHaveClass(/window-fullscreen/)
      await expect(canvas).toHaveCount(1)
    }
    const advance = async (before: State, label: string, kind: 'line' | 'page' | 'choice') => {
      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox()
      expect(box).not.toBeNull()
      // These pages have no selectable link at this interior point. Dispatch a
      // single real click only after observing the original [l]/[p] wait.
      const point = { x: 620 * box!.width / 640, y: 460 * box!.height / 480 }
      inputs.push({ type: 'mouse-click', before, logicalPoint: [620, 460] })
      await canvas.click({ position: point })
      return at(label, kind, before)
    }
    const link = async (index: number, target: string, exit = false) => {
      const raw = await read(`(function(){var m=kag.current,l=m.links[${index}];
        var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],string(l.target),string(l.exp),int(m.selProcessLock)].join("|");
      })()`), parts = raw.split('|'), x = Number(parts[0]), y = Number(parts[1])
      expect(parts).toHaveLength(7)
      expect(Number(parts[2])).toBeGreaterThan(0); expect(Number(parts[3])).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      expect(parts[6]).toBe('0')
      if (exit) expect(parts[5]).toContain('kag.shutdown()')
      else expect(parts[4]).toBe(target)
      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox()
      expect(box).not.toBeNull()
      inputs.push({ type: 'original-link-click', index, target: parts[4], expression: parts[5], logicalPoint: [x, y], rawGeometry: raw })
      await canvas.click({ position: { x: x * box!.width / 640, y: y * box!.height / 480 } })
    }
    const basePixels = () => read(`(function(){var l=kag.fore.base,a=[],points=[[0,0],[100,100],[320,240],[639,479]];
      for(var i=0;i<points.count;i++){a.add(l.getMainPixel(points[i][0],points[i][1]));a.add(l.getMaskPixel(points[i][0],points[i][1]));}
      return [l.imageWidth,l.imageHeight,l.Anim_loadParams.storage,a.join(",")].join("|");})()`)
    const finishPage = async (label: string, lineWaits: number, first: State) => {
      let current = first
      for (let line = 0; line < lineWaits; line++)
        current = await advance(current, label, line === lineWaits - 1 ? 'page' : 'line')
      return current
    }
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      const bytes = await originalPackage(), file = { name: 'kag3_intro.xp3', mimeType: 'application/octet-stream', buffer: bytes }
      await info.attach('original-kag-intro.xp3', { body: bytes, contentType: 'application/octet-stream' })
      await page.locator('#files').setInputFiles(file)
      loaded = true
      await readyConsole()
      const menu = await at('*syokai_start', 'choice')
      expect(menu.links).toBe(3)
      expect(menu.background).toBe('_24_5')
      await capture('original-menu', menu)
      await link(0, '*about_kirikiri')
      let current = await at('*about_kirikiri', 'line')
      expect(current.background).toBe('_24_4')
      await capture('route-page-1', current)
      current = await finishPage('*about_kirikiri', 3, current)
      await capture('route-page-1-complete', current)
      current = await advance(current, '*about_kirikiri2', 'line')
      await capture('route-page-2-bookmark', current)
      const savedPixels = await basePixels()
      expect(savedPixels).toMatch(/^640\|480\|_24_4\|/)
      expect(await read('kag.saveBookMark(0)')).toBe('1')
      const savedPayload = await read(`(function(){var d=Scripts.evalStorage(kag.getBookMarkFileNameAtNum(0));
        return [d.core.currentLabel,d.core.foreBaseLayer.loadParams.storage,d.user.bg].join("|");})()`)
      expect(savedPayload).toBe('*about_kirikiri2|_24_4|_24_4')
      const downloadEvent = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const download = await downloadEvent
      const backup = await readFile((await download.path())!)
      await info.attach('original-bookmark-backup.json', { body: backup, contentType: 'application/json' })
      evidence.bookmark = { savedPayload, savedPixels, backupBytes: backup.length,
        backupSha256: createHash('sha256').update(backup).digest('hex') }
      steps.push('saved-original-bookmark')
      current = await finishPage('*about_kirikiri2', 4, current)
      current = await advance(current, '*about_kirikiri3', 'line')
      await capture('route-page-3-before-load', current)
      expect(await read('kag.loadBookMark(0)')).toBe('1')
      current = await at('*about_kirikiri2', 'line')
      expect(await basePixels()).toBe(savedPixels)
      await capture('original-bookmark-restored', current)
      await page.reload()
      await page.locator('#files').setInputFiles(file)
      await readyConsole()
      const freshMenu = await at('*syokai_start', 'choice')
      expect(freshMenu.links).toBe(3)
      await capture('fresh-session-original-menu', freshMenu)
      // Only the original bookmark method changes the scenario here. No
      // loadScenario/goToLabel/tag replacement simulates restored gameplay.
      expect(await read('kag.loadBookMark(0)')).toBe('1')
      current = await at('*about_kirikiri2', 'line')
      expect(await basePixels()).toBe(savedPixels)
      await capture('refresh-bookmark-restored', current)
      current = await finishPage('*about_kirikiri2', 4, current)
      await capture('route-page-2-complete', current)
      current = await advance(current, '*about_kirikiri3', 'line')
      current = await finishPage('*about_kirikiri3', 3, current)
      await capture('route-page-3-complete', current)
      current = await advance(current, '*about_kirikiri4', 'line')
      for (let line = 0; line < 4; line++) current = await advance(current, '*about_kirikiri4', line === 3 ? 'choice' : 'line')
      expect(current.links).toBe(1)
      await capture('route-page-4-return-choice', current)
      await link(0, '*to_syokai_start')
      const returned = await at('*syokai_start', 'choice')
      expect(returned.links).toBe(3)
      await capture('returned-to-original-menu', returned)
      await link(2, '', true)
      await expect(page.locator('#status')).toHaveText('待机', { timeout: 15000 })
      await expect(canvas).toHaveCount(0)
      await expect(page.locator('.game-window')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
      exited = true
      steps.push('original-exit-stopped-session')
      await info.attach('original-exit', { body: await page.screenshot({ fullPage: true, timeout: 5000 }), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    try {
      evidence.exitedThroughOriginalLink = exited
      evidence.status = await page.locator('#status').textContent()
      evidence.logs = await page.locator('#logs').innerText()
      evidence.failures = failures.map((error) => error instanceof Error ? error.message : String(error))
      await info.attach('original-introduction-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
      if (failures.length) await info.attach('original-introduction-failure', { body: await page.screenshot({ fullPage: true, timeout: 5000 }), contentType: 'image/png' })
      await attachStartup(page, info, 'original-introduction', errors)
    } catch (error) { failures.push(error) }
    if (loaded && !exited) try {
      const modalStop = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modalStop.count()) await modalStop.last().click()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original introduction gameplay or cleanup failed', { cause: failures[0] })
  })

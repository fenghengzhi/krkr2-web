import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { observeStartup, attachStartup } from '../helpers/startup-observation.ts'
import { kagIntroSource as source, kagIntroStateExpression as stateExpression,
  kagIntroLayoutExpression, kagIntroLayoutFields,
  kagIntroFontMetricExpression, kagIntroFontMetricFields } from '../helpers/kag-intro-observation.ts'

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
    const errors: string[] = [], failures: unknown[] = [], steps: string[] = [], observations: unknown[] = [], inputs: unknown[] = [], consoleReads: unknown[] = []
    let evaluation = 0, loaded = false, exited = false, previousState = '', waitObservations = 0, startupRead = true, fontMetricsObserved = false
    let fontMetricFailure: unknown
    const evidence: Record<string, unknown> = {
      source, backend, browser: info.project.name, steps, observations, inputs, consoleReads, pageErrors: errors,
      scope: 'Runs the pinned Introduction to Kirikiri and KAG distribution sample through its original route links, page waits, Save/Load menus, slot 0 and Confirm-window Yes buttons, then its Exit link. Imports one unchanged XP3 and executes its original source scripts with the selected WASM backend. Console reads observe game state; they never invoke bookmark save/load methods.',
      importedFiles: ['kag3_intro.xp3'], originalScenarioUnmodified: true,
      layoutFields: kagIntroLayoutFields,
      fontMetricFields: kagIntroFontMetricFields,
      fontMetricScope: 'One separate never-shown Layer/Font is created after the original wait and layout are recorded, then destroyed. It measures normal/bold at 24/40 without changing the game message Font. Whole-string and per-code-unit widths are separate observations.',
      queryScope: 'Read-only state and changed-wait diagnostics share one console transaction. Programmatic activation of the actual console button leaves the physical pointer in place; it is never counted as game input. All route links, reading clicks, menu slots and Confirm Yes remain actual pointer actions.',
      waitEvidence: 'lastTagName is the original Conductor field also consulted by MainWindow.showPageBreakAndClear; automatic pagination is recorded but never accepted as an explicit [p] reading checkpoint.',
    }
    page.on('pageerror', (error) => errors.push(error.message))
    await observeStartup(page)
    const canvas = page.locator('#stage canvas[data-window-id]')
    const read = async (expression: string): Promise<string> => {
      const prefix = `intro-read-${++evaluation}:`, first = startupRead, began = Date.now(),
        observation = { prefix, phase: first ? 'startup' : 'gameplay', budgetMs: first ? 30000 : 5000, elapsedMs: 0, complete: false }
      startupRead = false
      if (consoleReads.length < 256) consoleReads.push(observation)
      try {
        await expect(page.locator('#evaluate')).toBeEnabled()
        // A query should not move the physical pointer out of the game or
        // scroll the canvas. Keep the actual console handler and its RPC;
        // only its UI-only button activation is programmatic.
        await page.evaluate((source) => {
          const input = document.querySelector<HTMLInputElement>('#expression')!,
            button = document.querySelector<HTMLButtonElement>('#evaluate')!
          if (button.disabled) throw new Error('Introduction observation console is not ready')
          input.focus({ preventScroll: true })
          input.value = source
          button.click()
        }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
        const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
        // The first read can queue behind the original startup's background
        // decode. It uses the existing startup budget; every subsequent read
        // retains the 5-second transaction bound, with no retry or new click.
        await expect(output).toBeVisible({ timeout: observation.budgetMs })
        const value = ((await output.textContent()) ?? '').slice(prefix.length)
        observation.complete = true
        return value
      } finally { observation.elapsedMs = Date.now() - began }
    }
    const state = async (): Promise<State | undefined> => {
      const separator = '\u001e'
      // Preserve every changed wait, including automatic pagination. Compute
      // its layout only when needed, in the same VM call as the state, then
      // take the separate hidden Font sample after those strings are saved.
      // Each diagnostic catches its own error so it cannot hide game state.
      const parts = (await read(`(function(){
        var observedState=(${stateExpression});
        if(observedState=="pending" || observedState==${JSON.stringify(previousState)} ||
          ${waitObservations >= 96 ? 'true' : 'false'} || !(kag.clickWaiting || kag.conductor.status==0))return observedState;
        var layout="",metrics="";
        try{layout="ok:"+(${kagIntroLayoutExpression});}catch(e){layout="error:"+e.message;}
        ${fontMetricsObserved ? '' : `try{metrics="ok:"+(${kagIntroFontMetricExpression});}catch(e){metrics="error:"+e.message;}`}
        return observedState+${JSON.stringify(separator)}+layout+${JSON.stringify(separator)}+metrics;
      })()`)).split(separator), value = parts[0]!
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
        const diagnostic = (index: number, name: string) => {
          const field = parts[index]
          if (!field?.startsWith('ok:'))
            throw new Error(field?.startsWith('error:') ? field.slice(6) : `Missing ${name} observation`)
          return field.slice(3)
        }
        // A diagnostic read must not replace the route's primary assertion.
        try {
          expect(parts).toHaveLength(3)
          const layout = diagnostic(1, 'layout').split('|')
          expect(layout).toHaveLength(kagIntroLayoutFields.length)
          observation.layout = Object.fromEntries(kagIntroLayoutFields.map((key, index) => [key, layout[index]]))
        } catch (error) { observation.layoutError = String(error) }
        if (!fontMetricsObserved) {
          fontMetricsObserved = true
          try {
            const raw = diagnostic(2, 'font metrics'), rows = raw.split(';').map((row) => row.split(','))
            observation.fontMetricsRaw = raw
            expect(rows).toHaveLength(4)
            for (const row of rows) {
              expect(row).toHaveLength(kagIntroFontMetricFields.length)
              expect(row.every((value) => value.length > 0 && Number.isFinite(Number(value)))).toBe(true)
            }
            observation.fontMetrics = rows.map((row) => Object.fromEntries(kagIntroFontMetricFields.map((key, index) => [key, Number(row[index])])))
            observation.fontMetricsComplete = true
          } catch (error) {
            fontMetricFailure = error
            observation.fontMetricsComplete = false; observation.fontMetricsError = String(error)
          }
        }
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
      startupRead = true
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
    const bookmark = async (action: 'Save' | 'Load', stage: string) => {
      // Read only before the original handler enters showModal. Its local
      // YesNoDialogWindow has no global handle, and the modal interval below
      // uses only the presented DOM and real pointer input.
      const raw = await read(`(function(){var m=kag.${action === 'Save' ? 'storeMenu' : 'restoreMenu'},s=m.children[0];
        return [kag.__windowId,global.Window.mainWindow.__windowId,kag.zoomNumer,kag.zoomDenom,
          int(kag.fullScreen),int(kag.freeSaveDataMode),m.children.count,s.bmNum,s.caption,int(s.enabled)].join("|");})()`)
      const parts = raw.split('|'), ownerId = parts[0]!, numer = Number(parts[2]), denom = Number(parts[3]),
        record: Record<string, unknown> = { type: 'original-bookmark-menu', stage, action, slot: 0, rawBefore: raw,
          consoleReadCountBeforeModal: evaluation, menuClicked: false, slotClicked: false, yesClicked: false, modalRetired: false }
      inputs.push(record)
      expect(parts).toHaveLength(10)
      expect(ownerId).toMatch(/^[1-9]\d*$/)
      expect(parts[1]).toBe(ownerId)
      expect(Number.isInteger(numer) && numer > 0 && Number.isInteger(denom) && denom > 0).toBe(true)
      expect(parts[4]).toBe('0') // The route explicitly leaves fullscreen before interacting.
      expect(parts[5]).toBe('0') // This original package exposes numbered menu slots.
      expect(Number(parts[6])).toBeGreaterThan(0)
      expect(parts[7]).toBe('0')
      expect(parts[9]).toBe('1')
      await expect(canvas).toHaveAttribute('data-window-id', ownerId)
      const owner = page.locator(`.game-window[data-window-id="${ownerId}"]`),
        menu = owner.locator('.game-window-menu details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${action}$`) }) }),
        summary = menu.locator(':scope > summary'), slots = menu.locator(':scope > .game-menu-group > button'),
        modal = page.locator('.game-window[data-window-id][aria-label="Confirm"]'), dialogCanvas = modal.locator('canvas[data-window-id]')
      await expect(menu).toHaveCount(1)
      await expect(summary).toHaveAttribute('aria-disabled', 'false')
      await summary.click()
      record.menuClicked = true
      await expect(menu).toHaveAttribute('open', '')
      await expect(slots).toHaveCount(Number(parts[6]))
      await expect(slots.first().locator('span')).toHaveText(parts[8]!)
      await expect(slots.first()).toBeEnabled()
      await slots.first().click()
      record.slotClicked = true
      await expect(modal).toHaveCount(1)
      await expect(modal).toBeVisible()
      await expect(owner).toHaveAttribute('data-blocked', 'true')
      await expect(modal).toHaveAttribute('data-blocked', 'false')
      await expect(modal).toHaveAttribute('data-zoom', `${numer}/${denom}`)
      record.modalWindowId = await modal.getAttribute('data-window-id')
      expect(record.modalWindowId).not.toBe(ownerId)
      await dialogCanvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      // A new canvas initially has browser-default backing dimensions. Wait
      // until its real frame matches the measured viewport before deriving the
      // original Yes button's position; do not click against that placeholder.
      await expect.poll(() => dialogCanvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement, content = canvas.parentElement!
        return canvas.width > 0 && canvas.height > 0 &&
          canvas.width === Math.round(Number.parseFloat(content.style.width)) &&
          canvas.height === Math.round(Number.parseFloat(content.style.height))
      })).toBe(true)
      const size = await dialogCanvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement
        return { width: canvas.width, height: canvas.height }
      }),
        primaryWidth = Math.round(size.width * denom / numer), primaryHeight = Math.round(size.height * denom / numer),
        // YesNoDialog.tjs: w=max(200,textWidth+40), h=2*textHeight+60;
        // Yes is 70x25 at ((w-150)>>1,textHeight+35).
        logicalPoint = { x: Math.floor((primaryWidth - 150) / 2) + 35, y: (primaryHeight - 60) / 2 + 35 + 12.5 },
        box = await dialogCanvas.boundingBox()
      Object.assign(record, { backingSize: size, zoom: [numer, denom], inferredPrimarySize: [primaryWidth, primaryHeight], logicalPoint, box })
      expect(primaryWidth).toBeGreaterThanOrEqual(200)
      expect(primaryHeight).toBeGreaterThan(60)
      expect(box).not.toBeNull()
      expect(logicalPoint.x).toBeGreaterThan(0); expect(logicalPoint.x).toBeLessThan(primaryWidth)
      expect(logicalPoint.y).toBeGreaterThan(0); expect(logicalPoint.y).toBeLessThan(primaryHeight)
      await info.attach(`${stage}-confirm`, { body: await dialogCanvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      const position = { x: logicalPoint.x * numer / denom * box!.width / size.width,
        y: logicalPoint.y * numer / denom * box!.height / size.height }
      record.cssPoint = position
      await dialogCanvas.click({ position })
      record.yesClicked = true
      await expect(modal).toHaveCount(0)
      await expect(owner).toHaveAttribute('data-blocked', 'false')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('data-window-id', ownerId)
      expect(evaluation).toBe(record.consoleReadCountBeforeModal)
      record.modalRetired = true
      steps.push(`${stage}-through-original-menu-and-confirm`)
    }
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
      await bookmark('Save', 'save-slot-0')
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
      await bookmark('Load', 'load-slot-0')
      current = await at('*about_kirikiri2', 'line')
      expect(await basePixels()).toBe(savedPixels)
      await capture('original-bookmark-restored', current)
      await page.reload()
      await page.locator('#files').setInputFiles(file)
      await readyConsole()
      const freshMenu = await at('*syokai_start', 'choice')
      expect(freshMenu.links).toBe(3)
      await capture('fresh-session-original-menu', freshMenu)
      // The original menu and confirmation handler perform the restore. No
      // console save/load, loadScenario/goToLabel or replacement tag changes it.
      await bookmark('Load', 'refresh-load-slot-0')
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
    // Keep a gameplay failure first, while never treating a missing separate
    // measurement as a successful font comparison.
    if (fontMetricFailure !== undefined) failures.push(fontMetricFailure)
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

import { test, expect, type Page } from '@playwright/test'
import { httpServer } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
import { centralRecords } from '../helpers/zip-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'

interface InputEvidence {
  type: string
  key?: number
  acknowledged: boolean
  status?: string
}

async function observeAdmission(page: Page) {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage,
      evidence: { type: string; key?: number; acknowledged: boolean; status?: string }[] = []
    Reflect.set(window, 'inputAdmissionEvidence', evidence)
    Worker.prototype.postMessage = function (
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as {
        id?: string
        type?: string
        argumentList?: { value?: unknown }[]
      }
      if (request.type === 'APPLY' && request.argumentList?.[0]?.value === 'input') {
        const packet = request.argumentList?.[1]?.value as { type: string; key?: number },
          record = {
            type: packet.type,
            key: packet.key,
            acknowledged: false,
            status: undefined as string | undefined,
          }
        evidence.push(record)
        const replied = (event: MessageEvent) => {
          if (event.data?.id !== request.id) return
          this.removeEventListener('message', replied)
          record.acknowledged = true
          record.status = event.data?.value?.status
        }
        this.addEventListener('message', replied)
      }
      return Reflect.apply(post, this, [message, transferOrOptions])
    }
  })
}

const evidence = (page: Page): Promise<InputEvidence[]> =>
  page.evaluate(() => Reflect.get(window, 'inputAdmissionEvidence'))

async function launch(page: Page, backend: string, binary: boolean, failAfterRead = false) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await observeAdmission(page)
  const bytes = remoteArchive('zip'),
    late = centralRecords(bytes).records.find((entry) => entry.name === 'late.tjs')!
  let armed = false,
    held = 0,
    release: (() => void) | undefined
  const server = await httpServer({
    '/input.zip': {
      bytes,
      etag: '"input-admission-v1"',
      intercept: (request, response) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!armed || !range || request.method !== 'GET') return false
        const from = Number(range[1]),
          to = Math.min(bytes.length - 1, Number(range[2]))
        if (from > late.data || to < late.data) return false
        held++
        release = () => {
          armed = false
          response.writeHead(206, {
            ETag: '"input-admission-v1"',
            'Content-Range': `bytes ${from}-${to}/${bytes.length}`,
            'Content-Length': to - from + 1,
          })
          response.end(bytes.subarray(from, to + 1))
          release = undefined
        }
        return true
      },
    },
  })
  try {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#remote-url').fill(server.url + '/input.zip')
    await page.locator('#load-url').click()
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    await expect(page.locator('#evaluate')).toBeEnabled()
    const script = String.raw`
global.admissionTrace=[];
global.w.setInnerSize(160,80);
global.w.onMouseDown=function(x,y,button,shift){
  global.admissionTrace.add("down-enter");Debug.message("input-admission-enter");
  var lines=[];lines.load("late.tjs","utf-8");
  global.admissionTrace.add("down-exit:"+lines[0]);Debug.message("input-admission-exit");
  ${failAfterRead ? 'throw new Exception("admitted-input-failure");' : ''}
};
global.w.onKeyDown=function(key,shift){if(key==65)global.admissionTrace.add("key:"+key);};
global.w.onMouseUp=function(x,y,button,shift){
  global.admissionTrace.add("up");Debug.message("input-admission-order:"+global.admissionTrace.join("|"));
};
`
    await evaluate(
      page,
      binary
        ? `(function(){var code=[${JSON.stringify(script)}];code.save("savedata/admission.tjs","utf-8");Scripts.compileStorage("savedata/admission.tjs","savedata/admission.cjs",false,true,false);Scripts.execStorage("savedata/admission.cjs");return 1;})()`
        : `(function(){Scripts.exec(${JSON.stringify(script)});return 1;})()`,
      '1',
    )
    const canvas = page.locator('canvas[data-window-id]')
    await expect(canvas).toHaveJSProperty('width', 160)
    await canvas.focus()
    // Focusing a canvas does not scroll it into view in WebKit. The subsequent
    // raw pointer actions must target the visible game rather than old page coordinates.
    await canvas.scrollIntoViewIfNeeded()
    await expect(canvas).toBeInViewport({ ratio: 1 })
    const bounds = (await canvas.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    armed = true
    await page.mouse.down()
    await expect(page.getByText('input-admission-enter', { exact: true })).toBeVisible()
    await expect.poll(() => held).toBe(1)
    return {
      errors,
      requests: server.requests,
      release: () => release?.(),
      pending: () => !!release,
      close: async () => {
        release?.()
        await server.close()
      },
    }
  } catch (error) {
    release?.()
    await server.close()
    throw error
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true])
    test(`${backend}/${binary ? 'bytecode' : 'source'}: input ACK admits keys and mouse-up while an earlier callback waits for storage`, async ({
      page,
    }, testInfo) => {
      const game = await launch(page, backend, binary)
      try {
        await page.keyboard.press('a')
        await page.mouse.up()
        const relevant = (records: InputEvidence[]) =>
          records.filter(
            (record) =>
              record.type === 'down' ||
              record.type === 'up' ||
              (record.type === 'keyDown' && record.key === 65),
          )
        await expect
          .poll(async () => relevant(await evidence(page)))
          .toEqual([
            { type: 'down', key: undefined, acknowledged: true, status: 'accepted' },
            { type: 'keyDown', key: 65, acknowledged: true, status: 'accepted' },
            { type: 'up', key: undefined, acknowledged: true, status: 'accepted' },
          ])
        expect(game.pending()).toBe(true)
        await expect(page.getByText('input-admission-exit', { exact: true })).toHaveCount(0)
        await expect(page.getByText(/^input-admission-order:/)).toHaveCount(0)
        await testInfo.attach('admitted-before-storage-completion', {
          body: JSON.stringify(
            { input: await evidence(page), http: game.requests, storagePending: game.pending() },
            null,
            2,
          ),
          contentType: 'application/json',
        })
        game.release()
        await expect(
          page.getByText('input-admission-order:down-enter|down-exit:73|key:65|up', {
            exact: true,
          }),
        ).toBeVisible()
        expect(game.errors).toEqual([])
        await page.locator('#stop').click()
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      } finally {
        await game.close()
      }
    })

  test(`${backend}: an unhandled script error after input ACK disables events while preserving the Session and VM`, async ({
    page,
  }) => {
    const game = await launch(page, backend, false, true)
    try {
      await expect
        .poll(async () => (await evidence(page)).find((record) => record.type === 'down')?.status)
        .toBe('accepted')
      expect(game.pending()).toBe(true)
      game.release()
      await expect(page.locator('#status')).toHaveText('事件已停止')
      await expect(
        page.locator('#logs .error').filter({ hasText: 'admitted-input-failure' }).first(),
      ).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      expect(game.errors).toEqual([])
      await page.mouse.up()
      await evaluate(page, 'System.eventDisabled', '1')
      await evaluate(page, '(isvalid global.w) ? 6*7 : -1', '42')
      await expect(page.locator('#status')).toHaveText('事件已停止')
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-text-input')).toHaveCount(0)
    } finally {
      await game.close()
    }
  })
}

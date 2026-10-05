import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { systemMessagesSource } from '../helpers/system-messages-script.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual Worker message assignment changes runtime and compiler diagnostics and resets on restart`, async ({ page }, info) => {
    test.setTimeout(90000)
    const source = systemMessagesSource + String.raw`
var window=new Window();window.caption="Native messages";window.setInnerSize(80,48);window.visible=true;
var layer=new Layer(window,null);window.add(layer);layer.setSize(80,48);layer.fillRect(0,0,80,48,0xff234567);
`, files = [{ name: 'warning.tjs', mimeType: 'text/plain', buffer: Buffer.from('var value=0;if(value=1){}') }],
      game = await launchWindowAttention(page, backend, binary, source, files), failures: unknown[] = []
    let stop = game.stop
    try {
      await evaluate(page, 'missingMessage()', 'Member "missing" does not exist')
      await evaluate(page, 'translatedMessage()', '1|找不到『missing』 雪 😀')
      await evaluate(page, 'messageCalls()', '5|kept missing|discarded missing|1|1|bound missing|1')
      await evaluate(page, 'compilerMessages()', '2|1')
      await expect(page.locator('#logs')).toContainText('translated assignment warning')
      await info.attach('native-message-live-worker', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
      await stop()
      const fresh = await launchWindowAttention(page, backend, binary, source, files, true)
      stop = fresh.stop
      await evaluate(page, 'missingMessage()', 'Member "missing" does not exist')
      await evaluate(page, '(function(){try{Scripts.exec("var = ;");}catch(error){return int(error.message.indexOf("translated parser:")<0);}})()', '1')
      await expect(fresh.surface('Native messages')).toBeVisible()
    } catch (error) { failures.push(error) }
    try { await info.attach('native-message-final', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Native messages or cleanup failed', { cause: failures[0] })
  })
}

import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  clickGame,
  expectAttentionAnchor,
  finishComposition,
  launchWindowAttention,
  startComposition,
} from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var trapKeys=[],trapUps=[],trapClicks=[],trapFlow="",c=null,rootC=null;
class TrapWindow extends Window {
  var tag,typed="";
  function TrapWindow(tag,left){super.Window();this.tag=tag;caption="Trap "+tag;setInnerSize(160,90);setPos(left,0);visible=true;}
  function onKeyDown(key,shift){global.trapKeys.add("W"+tag+":"+key);}
  function onKeyUp(key,shift){if(key>=65 && key<=90){global.trapUps.add(tag+":"+key+":"+int(System.getKeyState(key)));Debug.message("trap-ups:"+global.trapUps.join("|"));}}
  function onKeyPress(key){typed+=key;Debug.message("trap-text:"+tag+":"+typed);}
  function onMouseDown(){
    global.trapClicks.add(tag);
    var flow=global.trapFlow;global.trapFlow="";
    if(flow=="system")Debug.message("trap-system:"+System.inputString("Trap system input","Host text remains editable",""));
    if(flow=="font")Debug.message("trap-font:"+global.rootA.font.doUserSelect(fsfTrueTypeOnly,"Trap font","Host font choice","AV")+":"+global.rootA.font.face);
    if(flow=="clipboard"){
      try{var text=Clipboard.asText;Debug.message("trap-clipboard-unexpected:"+text);}
      catch(error){Debug.message("trap-clipboard-cancelled");}
    }
    if(flow=="switch"){global.b.trapKey=false;global.a.trapKey=true;Debug.message("trap-route-switched");}
    Debug.message("trap-clicks:"+global.trapClicks.join("|"));
  }
}
class TrapLayer extends Layer {
  var tag,typed="";
  function TrapLayer(window,tag){super.Layer(window,null);this.tag=tag;type=ltOpaque;setSize(160,90);fillRect(0,0,160,90,0xff304060);focusable=true;imeMode=imOpen;useAttention=true;setAttentionPos(40,25);focus();}
  function onKeyDown(key,shift,process){global.trapKeys.add("L"+tag+":"+key);Debug.message("trap-keys:"+global.trapKeys.join("|"));}
  function onKeyPress(key,process){typed+=key;}
}
var a=new TrapWindow("A",0),rootA=new TrapLayer(a,"A");
var b=new TrapWindow("B",230),rootB=new TrapLayer(b,"B");
b.focusable=false;b.trapKey=true;
function createTrapper(){global.c=new TrapWindow("C",460);global.rootC=new TrapLayer(c,"C");c.focusable=false;c.trapKey=true;return 1;}
`

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: real game keys use the newest visible trapper without moving DOM focus; postInput stays direct`, async ({
      page,
    }) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        a = game.surface('Trap A'),
        b = game.surface('Trap B')
      try {
        await clickGame(a)
        await page.keyboard.press('a')
        await expect(page.getByText('trap-keys:WB:65|LB:65', { exact: true })).toBeVisible()
        await expect(a.locator('.game-text-input')).toBeFocused()
        await expect(b).toHaveAttribute('data-active', 'false')
        await expectAttentionAnchor(a, 0, 0)
        await expect(a.locator('.game-text-input')).toHaveCSS('font-size', '16px')
        await evaluate(
          page,
          'a.typed+","+b.typed+","+rootB.typed+","+int(b.focusable)+","+trapClicks.join("|")',
          ',a,a,0,A',
        )

        await evaluate(page, '(a.trapKey=true,createTrapper())', '1')
        await clickGame(a)
        await page.keyboard.press('b')
        await expect(
          page.getByText('trap-keys:WB:65|LB:65|WC:66|LC:66', { exact: true }),
        ).toBeVisible()
        // Setting older A last cannot reorder the creation-ordered trap search.
        await evaluate(page, '(c.visible=false,a.trapKey=true,0)', '0')
        await clickGame(a)
        await page.keyboard.press('c')
        await expect(
          page.getByText('trap-keys:WB:65|LB:65|WC:66|LC:66|WB:67|LB:67', { exact: true }),
        ).toBeVisible()
        await evaluate(page, '(c.visible=true,0)', '0')
        await clickGame(a)
        await page.keyboard.press('d')
        await expect(
          page.getByText('trap-keys:WB:65|LB:65|WC:66|LC:66|WB:67|LB:67|WC:68|LC:68', {
            exact: true,
          }),
        ).toBeVisible()
        await evaluate(page, '(function(){invalidate c;return 0;})()', '0')
        await expect(game.surface('Trap C')).toHaveCount(0)
        await clickGame(a)
        await page.keyboard.press('e')
        await expect(
          page.getByText('trap-keys:WB:65|LB:65|WC:66|LC:66|WB:67|LB:67|WC:68|LC:68|WB:69|LB:69', {
            exact: true,
          }),
        ).toBeVisible()
        await expect(a.locator('.game-text-input')).toBeFocused()
        await expect(b).toHaveAttribute('data-active', 'false')

        await evaluate(
          page,
          '(function(){a.postInputEvent("onKeyDown",%[key:90,shift:0]);a.postInputEvent("onKeyPress",%[key:"直"]);a.postInputEvent("onKeyUp",%[key:90,shift:0]);return 1;})()',
          '1',
        )
        await expect(page.getByText('trap-text:A:直', { exact: true })).toBeVisible()
        await expect(page.getByText(/^trap-ups:.*A:90:0$/)).toBeVisible()
        await evaluate(
          page,
          'a.typed+","+b.typed+","+rootA.typed+","+trapKeys[trapKeys.count-2]+"|"+trapKeys[trapKeys.count-1]',
          '直,ace,直,WA:90|LA:90',
        )
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: real isolated keyUp, unarmed text and repeated trap setters preserve the native gate`, async ({
      page,
    }) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        a = game.surface('Trap A')
      try {
        await clickGame(a)
        // Playwright emits actual key-up protocol events even without a held key.
        await page.keyboard.up('a')
        await page.keyboard.up('a')
        await expect(page.getByText('trap-ups:B:65:0', { exact: true })).toBeVisible()
        await evaluate(page, 'trapUps.join("|")+","+int(System.getKeyState(65))', 'B:65:0,0')
        await evaluate(page, '(b.trapKey=true,0)', '0')
        await clickGame(a)
        await page.keyboard.insertText('discarded')
        await page.keyboard.press('b')
        await expect(page.getByText('trap-text:B:b', { exact: true })).toBeVisible()
        await evaluate(page, 'a.typed+","+b.typed+","+rootB.typed', ',b,b')
        // Hide/show preserves the armed gate; assigning true resets it again.
        await evaluate(page, '(b.visible=false,b.visible=true,0)', '0')
        await clickGame(a)
        await page.keyboard.insertText('保留')
        await expect(page.getByText('trap-text:B:b保留', { exact: true })).toBeVisible()
        await evaluate(page, '(b.trapKey=false,a.trapKey=true,0)', '0')
        await clickGame(a)
        await page.keyboard.insertText('self-discarded')
        await page.keyboard.press('c')
        await expect(page.getByText('trap-text:A:c', { exact: true })).toBeVisible()
        await evaluate(page, 'a.typed+","+b.typed+","+rootA.typed', 'c,b保留,c')
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: Console, System, Font and Clipboard host controls keep real keyboard ownership`, async ({
      page,
    }) => {
      const fonts = await Promise.all(
          ['latin.ttf', 'mono.ttf'].map(async (name) => ({
            name,
            mimeType: 'font/ttf',
            buffer: await readFile('tests/fixtures/font-selection/' + name),
          })),
        ),
        game = await launchWindowAttention(page, backend, binary, source, fonts),
        a = game.surface('Trap A')
      try {
        await clickGame(a)
        await page.keyboard.press('a')
        await expect(page.getByText('trap-keys:WB:65|LB:65', { exact: true })).toBeVisible()
        const consoleInput = page.locator('#expression')
        await consoleInput.click()
        await consoleInput.fill('')
        await page.keyboard.type('HostConsole')
        await expect(consoleInput).toHaveValue('HostConsole')
        await evaluate(page, 'trapKeys.join("|")+","+b.typed', 'WB:65|LB:65,a')

        await evaluate(page, '(trapFlow="system",0)', '0')
        // The pointer remains addressed to A even though all game keys trap to B.
        await a.locator('canvas[data-window-id]').click({ position: { x: 8, y: 8 } })
        const dialog = page.getByRole('dialog', { name: 'Trap system input', exact: true }),
          input = dialog.getByRole('textbox')
        await expect(input).toBeFocused()
        await page.keyboard.type('HostSystem')
        await page.keyboard.insertText('雪😀')
        await expect(input).toHaveValue('HostSystem雪😀')
        await page.keyboard.press('Enter')
        await expect(page.getByText('trap-system:HostSystem雪😀', { exact: true })).toBeVisible()
        await expect(dialog).toHaveCount(0)
        await evaluate(page, '(rootA.font.face="Selection Latin",trapFlow="font",0)', '0')
        await a.locator('canvas[data-window-id]').click({ position: { x: 8, y: 8 } })
        const font = page.getByRole('dialog', { name: 'Trap font', exact: true })
        await expect(font.getByRole('option')).toHaveCount(2)
        await font.getByRole('option', { name: 'Selection Latin', exact: true }).click()
        await page.keyboard.press('ArrowDown')
        await expect(
          font.getByRole('option', { name: 'Selection Mono', exact: true }),
        ).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByText('trap-font:1:Selection Mono', { exact: true })).toBeVisible()
        await expect(font).toHaveCount(0)
        await evaluate(page, '(trapFlow="clipboard",0)', '0')
        await a.locator('canvas[data-window-id]').click({ position: { x: 8, y: 8 } })
        const clipboard = page.getByRole('region', { name: '游戏剪贴板请求', exact: true })
        await expect(clipboard).toBeVisible()
        // Focus a real host action and invoke it through a real key. This case
        // cancels before calling the browser clipboard and needs no grant.
        await clipboard.getByRole('button', { name: '取消', exact: true }).focus()
        await page.keyboard.press('Enter')
        await expect(page.getByText('trap-clipboard-cancelled', { exact: true })).toBeVisible()
        await expect(clipboard).toHaveCount(0)
        await evaluate(
          page,
          'trapKeys.join("|")+","+a.typed+","+b.typed+","+rootB.typed',
          'WB:65|LB:65,,a,a',
        )
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: constructed composition cannot cross a changed trap route or a stopped surface`, async ({
      page,
    }) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        a = game.surface('Trap A'),
        text = a.locator('.game-text-input')
      try {
        await evaluate(page, '(trapFlow="switch",0)', '0')
        // Focus without clicking: the following actual click is reserved for
        // switching the route while the same textarea owns composition.
        await a.locator('canvas[data-window-id]').focus()
        await expect(text).toBeFocused()
        await page.keyboard.press('z')
        await expect(page.getByText('trap-text:B:z', { exact: true })).toBeVisible()
        await startComposition(text, '旧😀')
        await clickGame(a)
        await expect(page.getByText('trap-route-switched', { exact: true })).toBeVisible()
        await expectAttentionAnchor(a, 40 / 160, 25 / 90)
        await finishComposition(text, '旧😀')
        // A fresh ordinary key arms the new trapper, and real insertText tests
        // the actual browser editing path independently of constructed IME.
        await page.keyboard.press('x')
        await page.keyboard.insertText('新😀')
        await expect(page.getByText('trap-text:A:x新😀', { exact: true })).toBeVisible()
        await startComposition(text, '合😀')
        await finishComposition(text, '合😀')
        await expect(page.getByText('trap-text:A:x新😀合😀', { exact: true })).toBeVisible()
        await evaluate(page, 'a.typed+","+b.typed+","+rootA.typed', 'x新😀合😀,z,x新😀合😀')
        await clickGame(a)
        await startComposition(text, '停止後')
        const retired = await text.elementHandle()
        expect(retired).not.toBeNull()
        await game.stop()
        // Start the replacement without navigation so the old DOM handle stays
        // alive; late events target the retired textarea after new IDs exist.
        const next = await launchWindowAttention(page, backend, binary, source, [], true)
        try {
          await clickGame(next.surface('Trap A'))
          await retired!.evaluate((element) => {
            const input = element as HTMLTextAreaElement
            input.dispatchEvent(
              new CompositionEvent('compositionend', { data: '停止後', bubbles: true }),
            )
            input.value = '停止後'
            input.dispatchEvent(
              new InputEvent('input', {
                data: '停止後',
                inputType: 'insertFromComposition',
                bubbles: true,
              }),
            )
          })
          await page.keyboard.press('n')
          await expect(page.getByText('trap-text:B:n', { exact: true })).toBeVisible()
          await evaluate(page, 'a.typed+","+b.typed+","+rootB.typed', ',n,n')
        } finally {
          await next.stop()
        }
        await retired!.dispose()
      } finally {
        await game.stop()
      }
    })
  }
}

import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { expectAttentionAnchor, launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var attentionText="",w=new Window();w.caption="Attention";w.setInnerSize(200,100);w.setPos(37,29);w.visible=true;
var root=new Layer(w,null);root.type=ltOpaque;root.setSize(200,100);root.fillRect(0,0,200,100,0xff304050);
root.setAttentionPos(-20,5);root.font.face="serif";root.font.height=36;
var parent=new Layer(w,root);parent.setSize(100,70);parent.setPos(20,10);parent.visible=true;
parent.setAttentionPos(8,6);parent.font.face="serif";parent.font.height=32;
var child=new Layer(w,parent);child.setSize(60,30);child.setPos(3,4);child.visible=true;child.focusable=true;child.imeMode=imOpen;
child.setAttentionPos(2,3);child.font.face="monospace";child.font.height=22;child.font.bold=true;child.font.italic=true;child.font.underline=true;child.font.strikeout=true;
child.onKeyPress=function(key,process){global.attentionText+=key;Debug.message("attention-text:"+global.attentionText);};
var other=new Layer(w,root);other.setSize(20,20);other.setPos(130,50);other.visible=true;other.focusable=true;other.imeMode=imDisable;
child.focus();
`

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: nullable attention samples the first enabled ancestor only at native refresh points`, async ({
      page,
    }) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Attention'),
        text = surface.locator('.game-text-input')
      try {
        await expectAttentionAnchor(surface, 0, 0)
        await expect(text).toHaveAttribute('inputmode', 'text')
        await expect(text).toHaveCSS('font-size', '16px')
        await evaluate(
          page,
          'int(root.useAttention)+","+int(parent.useAttention)+","+int(child.useAttention)',
          '0,0,0',
        )
        // Primary Layer coordinates are fixed at zero. Nonzero positions are
        // rejected by the original API, so they are not valid setup geometry.
        await evaluate(
          page,
          '(function(){try{root.setPos(70,60);}catch(error){return root.left+","+root.top;}return "unexpected-primary-move";})()',
          '0,0',
        )
        await evaluate(page, '(parent.useAttention=true,0)', '0')
        await expectAttentionAnchor(surface, 0, 0)
        await evaluate(page, '(child.useAttention=child.useAttention,0)', '0')
        await expectAttentionAnchor(surface, 28 / 200, 16 / 100)
        await expect(text).toHaveCSS('font-family', 'monospace')
        await expect(text).toHaveCSS('font-size', '22px')
        await expect(text).toHaveCSS('font-weight', '700')
        await expect(text).toHaveCSS('font-style', 'italic')
        await expect(text).toHaveCSS('text-decoration-line', 'underline line-through')
        // Ancestor geometry/attention edits and same-layer focus do not replace
        // the sampled point, even though the browser receives newer snapshots.
        await evaluate(
          page,
          '(parent.setAttentionPos(38,16),parent.setPos(30,12),child.focus(),0)',
          '0',
        )
        await expectAttentionAnchor(surface, 28 / 200, 16 / 100)
        await evaluate(page, '(child.useAttention=false,0)', '0')
        await expectAttentionAnchor(surface, 68 / 200, 28 / 100)
        await evaluate(page, '(child.useAttention=true,0)', '0')
        await expectAttentionAnchor(surface, 35 / 200, 19 / 100)
        await evaluate(
          page,
          '(function(){var result=child.setAttentionPos(-7,8,999);return typeof result+","+int(child.useAttention);})()',
          'void,1',
        )
        await expectAttentionAnchor(surface, 26 / 200, 24 / 100)
        await evaluate(
          page,
          '(child.useAttention=false,parent.useAttention=false,child.useAttention=false,0)',
          '0',
        )
        await expectAttentionAnchor(surface, 0, 0)
        await expect(text).toHaveCSS('font-size', '16px')
        expect(
          await text.evaluate((element) => {
            const style = (element as HTMLTextAreaElement).style
            return [style.fontFamily, style.fontWeight, style.fontStyle, style.textDecorationLine]
          }),
        ).toEqual(['', '', '', ''])
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: attention DOM projection handles zoom, negative coordinates, window movement and CSS-only resize`, async ({
      page,
    }, info) => {
      // A sole primary is embedded at CSS (0,0), ignoring Window.setPos. A
      // second visible Window makes this a real movable floating surface.
      const game = await launchWindowAttention(
          page,
          backend,
          binary,
          source +
            String.raw`
var witness=new Window();witness.caption="Attention witness";witness.setInnerSize(60,40);witness.setPos(500,0);witness.visible=true;
var witnessRoot=new Layer(witness,null);witnessRoot.setSize(60,40);
`,
        ),
        surface = game.surface('Attention'),
        text = surface.locator('.game-text-input')
      try {
        await evaluate(
          page,
          '(parent.useAttention=true,child.useAttention=false,w.setZoom(3,2),w.setLayerPos(7,11),0)',
          '0',
        )
        // Web policy follows the actually rendered canvas: layer offset plus
        // sampled primary point times zoom, then CSS projection. The primary
        // stays at (0,0); outer Window left/top must not be added a second time.
        await expectAttentionAnchor(surface, 49 / 200, 35 / 100)
        await evaluate(
          page,
          '(child.setImageSize(150,70),child.setImagePos(-90,-40),child.setClip(2,3,10,11),child.opacity=41,child.imageLeft+","+child.imageTop)',
          '-90,-40',
        )
        await evaluate(page, 'root.left+","+root.top', '0,0')
        await expectAttentionAnchor(surface, 49 / 200, 35 / 100)
        await evaluate(
          page,
          '(parent.setAttentionPos(-40,-20),child.attentionLeft=child.attentionLeft,0)',
          '0',
        )
        await expectAttentionAnchor(surface, -23 / 200, -4 / 100)
        const beforeMove = (await surface.locator('canvas[data-window-id]').boundingBox())!
        await evaluate(page, '(w.setPos(190,75),0)', '0')
        await expect
          .poll(async () => {
            const after = (await surface.locator('canvas[data-window-id]').boundingBox())!
            return Math.abs(after.x - beforeMove.x) + Math.abs(after.y - beforeMove.y)
          })
          .toBeGreaterThan(10)
        await expectAttentionAnchor(surface, -23 / 200, -4 / 100)
        const width = (await surface.locator('canvas[data-window-id]').boundingBox())!.width
        await page.addStyleTag({
          content: '.game-window[aria-label="Attention"] { width: 27vw !important; }',
        })
        await expect
          .poll(async () => (await surface.locator('canvas[data-window-id]').boundingBox())!.width)
          .not.toBe(width)
        await expectAttentionAnchor(surface, -23 / 200, -4 / 100)
        await page.setViewportSize({ width: 1030, height: 710 })
        await expectAttentionAnchor(surface, -23 / 200, -4 / 100)
        await expect(text).toHaveCSS('font-size', '22px')
        await info.attach('dom-attention-projection', {
          contentType: 'application/json',
          body: JSON.stringify(
            await surface.evaluate((element) => {
              const canvas = element.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!,
                input = element.querySelector<HTMLTextAreaElement>('.game-text-input')!
              return {
                scope: 'Hidden textarea DOM anchor; not an OS IME candidate window',
                canvas: canvas.getBoundingClientRect().toJSON(),
                textarea: input.getBoundingClientRect().toJSON(),
                style: input.getAttribute('style'),
              }
            }),
            null,
            2,
          ),
        })
      } finally {
        await game.stop()
      }
    })

    test(`${variant}: no-main-image font fallback, focus changes and retirement clear the old attention state`, async ({
      page,
    }) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        surface = game.surface('Attention'),
        text = surface.locator('.game-text-input')
      try {
        await evaluate(page, '(parent.useAttention=true,child.useAttention=false,0)', '0')
        await expectAttentionAnchor(surface, 28 / 200, 16 / 100)
        await expect(text).toHaveCSS('font-size', '22px')
        await evaluate(page, '(child.hasImage=false,child.useAttention=false,0)', '0')
        await expectAttentionAnchor(surface, 28 / 200, 16 / 100)
        await expect(text).toHaveCSS('font-size', '16px')
        expect(
          await text.evaluate((element) => (element as HTMLTextAreaElement).style.fontFamily),
        ).toBe('')
        await evaluate(page, '(root.useAttention=true,other.focus(),0)', '0')
        await expectAttentionAnchor(surface, -20 / 200, 5 / 100)
        await expect(text).toHaveAttribute('inputmode', 'none')
        await evaluate(page, '(root.useAttention=false,child.focus(),0)', '0')
        await expectAttentionAnchor(surface, 28 / 200, 16 / 100)
        await expect(text).toHaveAttribute('inputmode', 'text')
        // Null attention leaves the actual text entry alive and focusable.
        await evaluate(page, '(parent.useAttention=false,child.useAttention=false,0)', '0')
        await expectAttentionAnchor(surface, 0, 0)
        await surface.locator('canvas[data-window-id]').focus()
        await expect(text).toBeFocused()
        await page.keyboard.insertText('still editable')
        await expect(page.getByText('attention-text:still editable', { exact: true })).toBeVisible()
        await expect(text).toBeFocused()
        await evaluate(page, '(function(){invalidate child;invalidate other;return 0;})()', '0')
        await expectAttentionAnchor(surface, 0, 0)
        await expect(text).toHaveCSS('font-size', '16px')
        await game.stop()
        await expect(text).toHaveCount(0)
      } finally {
        await game.stop()
      }
    })
  }
}

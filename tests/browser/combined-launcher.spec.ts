import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'

function chapter(name: string, binary: boolean) {
  const script = `
var chapterName=${JSON.stringify(name)},chapterWindow=new Window();
chapterWindow.caption=chapterName;chapterWindow.setInnerSize(120,64);chapterWindow.visible=true;
var chapterRoot=new Layer(chapterWindow,null);chapterWindow.add(chapterRoot);
chapterRoot.holdAlpha=false;chapterRoot.setSize(120,64);chapterRoot.fillRect(0,0,120,64,0xff205030);
chapterRoot.onClick=function(){
 var lines=[global.chapterName+"|"+global.System.getArgument("-edition")];
 lines.save(global.System.dataPath+"progress.txt","utf-8");global.Debug.message("chapter-saved:"+global.chapterName);
};
Debug.message("chapter-open:"+chapterName);
`
  return embedXp3(xp3Fixture({ 'chapter.tjs': script, 'startup.tjs': binary
    ? 'Scripts.compileStorage("chapter.tjs",System.dataPath+"chapter.cjs",false,true,false);Scripts.execStorage(System.dataPath+"chapter.cjs");'
    : 'Scripts.execStorage("chapter.tjs");' }, { compressed: true }).bytes, 256)
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: import a game EXE beside setup and choose an edition when both contain games`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    await page.locator('#project-mode').selectOption('auto')
    const file = (name: string, buffer: Buffer) => ({ name, buffer, mimeType: 'application/octet-stream' })
    const common = [file('Setup.exe', Buffer.from([77, 90, 0])), file('Novel.exe', chapter('Novel', binary)),
      file('Novel.cf', Buffer.from('edition=original\r\ndatapath=$(exepath)/NovelSlots\r\n')),
      file('Setup.cf', Buffer.from('edition=wrong'))]
    const both = [...common, file('Bonus.EXE', chapter('Bonus', binary)),
      file('Bonus.cf', Buffer.from('edition=bonus\r\ndatapath=$(exepath)/BonusSlots\r\n'))]
    const play = async (name: string, exe: string, edition: string) => {
      await expect(page.getByText('chapter-open:' + name, { exact: true })).toBeVisible()
      const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: new RegExp('^' + name + '$') }) }).locator('canvas')
      await expect(canvas).toHaveCount(1)
      await evaluate(page, '[System.exeName,Storages.getPlacedPath("chapter.tjs"),System.dataPath].join("|")',
        'game://./' + exe + '|game://./' + exe + '>chapter.tjs|game://./' + name + 'Slots/')
      await canvas.click()
      await expect(page.getByText('chapter-saved:' + name, { exact: true })).toBeVisible()
      await evaluate(page, '[].load(System.dataPath+"progress.txt","utf-8")[0]', name + '|' + edition)
      await info.attach('combined-' + name, { body: await canvas.screenshot(), contentType: 'image/png' })
      await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
    }
    try {
      await page.locator('#files').setInputFiles(common)
      await play('Novel', 'Novel.exe', 'original')
      await page.locator('#files').setInputFiles(both)
      await expect(page.locator('#logs')).toContainText('多个内嵌 XP3')
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('.game-window')).toHaveCount(0)
      await page.locator('#project-executable').fill('bonus.exe')
      await page.locator('#files').setInputFiles(both)
      await play('Bonus', 'Bonus.EXE', 'bonus')
      expect(errors).toEqual([])
    } finally {
      await info.attach('combined-launcher-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
    }
  })
}

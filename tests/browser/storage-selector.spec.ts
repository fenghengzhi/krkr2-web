import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { prepareSystemPage } from '../helpers/web-system-core.ts'
import { zipFixture } from '../helpers/zip-fixtures.ts'

const prefix = 'storage-selector-proof:'
const mark = (page: Page, value: string) => page.getByText(prefix + value, { exact: true })
const textFile = (name: string, source: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(source),
})

function files(binary: boolean, source: string) {
  return [
    textFile(
      'startup.tjs',
      binary
        ? 'Scripts.compileStorage("StorageSelector.tjs","savedata/StorageSelector.cjs",false,true,false);Scripts.execStorage("savedata/StorageSelector.cjs");'
        : 'Scripts.execStorage("StorageSelector.tjs");',
    ),
    textFile('StorageSelector.tjs', source),
  ]
}

const prelude = String.raw`
System.exitOnWindowClose=false;
function selectorMark(value){Debug.message("storage-selector-proof:"+value);}
function selectorCheck(value,message){if(!value)throw new Exception("storage-selector-proof:"+message);}
var selectorKeys=0,selectorCalls=0;
class SelectorWindow extends Window {
  function SelectorWindow(){super.Window();caption="Storage selector owner";setInnerSize(180,100);setPos(0,0);visible=true;}
  function onMouseDown(){global.selectorCalls++;if(global.selectorCalls==1)global.selectorRun();}
  function onKeyDown(key,shift){if(key==65){global.selectorKeys++;global.selectorMark("game-key:"+global.selectorKeys);}}
}
var selectorWindow=new SelectorWindow(),selectorLayer=new Layer(selectorWindow,null);
selectorLayer.type=ltOpaque;selectorLayer.setSize(180,100);selectorLayer.fillRect(0,0,180,100,0xff305070);
`

const roundTrip =
  prelude +
  String.raw`
var oldState=%["value"=>7],newState=%["value"=>42,"text"=>"保存の文字 雪 😀"];
(Dictionary.saveStruct incontextof oldState)("savedata/existing.kdt","b");
["not a dictionary"].save("savedata/note.txt","utf-8");
["child"].save("savedata/sub/child.kdt","utf-8");
function selectorRun(){
  var save=%["title"=>"Save selector proof","save"=>true,"initialDir"=>"game://./savedata/","name"=>"game://./savedata/new-slot","filter"=>["存档|*.kdt","全部|*.*"],"filterIndex"=>1,"defaultExt"=>"kdt"];
  selectorCheck(Storages.selectFile(save)===1,"save-result");
  selectorCheck(save.name=="game://./savedata/existing.kdt" && save.filterIndex==2,"save-name-filter");
  selectorCheck(Dictionary.loadStruct(save.name).value==7,"selector-did-not-write");
  (Dictionary.saveStruct incontextof newState)(save.name,"b");
  selectorMark("saved:"+save.name+":"+save.filterIndex);
  var open=%["title"=>"Open selector proof","initialDir"=>"game://./savedata/","filter"=>["存档|*.kdt","全部|*.*"],"filterIndex"=>1];
  selectorCheck(Storages.selectFile(open)===1,"open-result");
  selectorCheck(open.name==save.name && open.filterIndex==1,"open-name-filter");
  var loaded=Dictionary.loadStruct(open.name);
  selectorCheck(loaded.value==42 && loaded.text=="保存の文字 雪 😀","dictionary-roundtrip");
  selectorMark("loaded:"+loaded.value+":"+loaded.text);
  var dot=%["title"=>"Trailing dot selector","save"=>true,"initialDir"=>"game://./savedata/","defaultExt"=>"kdt"];
  selectorCheck(Storages.selectFile(dot)===1,"dot-result");
  selectorCheck(dot.name=="game://./savedata/no-extension" && dot.filterIndex==0,"trailing-dot-suppresses-default");
  selectorCheck(!Storages.isExistentStorage(dot.name),"selector-does-not-create");
  ["extension proof"].save(dot.name,"utf-8");
  selectorMark("dot:"+dot.name);
  selectorMark("after");
}
selectorMark("ready");
`

const cancelFlow =
  prelude +
  String.raw`
var selectorTimers=0;
function selectorTick(){selectorClock.enabled=false;selectorTimers++;selectorMark("timer:"+selectorTimers);}
var selectorClock=new Timer(global,"selectorTick");selectorClock.interval=50;
var originalFilters=["存档|*.kdt","全部|*.*"],sentinel=%["retained"=>19];
var cancelOptions=%["title"=>"Cancel selector proof","save"=>true,"name"=>"game://./savedata/untouched.kdt","initialDir"=>"game://./savedata/","filter"=>originalFilters,"filterIndex"=>2,"defaultExt"=>"kdt","sentinel"=>sentinel];
function cancelUnchanged(){
  selectorCheck(cancelOptions.name=="game://./savedata/untouched.kdt" && cancelOptions.filterIndex==2,"cancel-name-filter-unchanged");
  selectorCheck(cancelOptions.filter===originalFilters && cancelOptions.sentinel===sentinel && sentinel.retained==19,"cancel-object-identity");
  selectorCheck(cancelOptions.title=="Cancel selector proof" && cancelOptions.save===true && cancelOptions.initialDir=="game://./savedata/" && cancelOptions.defaultExt=="kdt","cancel-options-unchanged");
  selectorCheck(!Storages.isExistentStorage(cancelOptions.name),"cancel-did-not-create");
}
function selectorRun(){
  selectorClock.enabled=true;
  selectorMark("before");
  selectorCheck(Storages.selectFile(cancelOptions)===0,"escape-result");cancelUnchanged();
  selectorMark("escape-return");
  selectorCheck(Storages.selectFile(cancelOptions)===0,"button-result");cancelUnchanged();
  selectorMark("button-return");
  selectorCheck(selectorKeys==0,"modal-game-input-blocked");
  selectorMark("after");
}
selectorMark("ready");
`

const archiveFlow =
  prelude +
  String.raw`
function selectorRun(){
  var archive=%["title"=>"Archive selector proof","initialDir"=>"game://./","filter"=>"脚本|*.tjs","filterIndex"=>1];
  selectorCheck(Storages.selectFile(archive)===1,"archive-result");
  selectorCheck(archive.name=="game://./bundle.data>シーン/value.tjs","archive-canonical-name");
  selectorCheck(Scripts.evalStorage(archive.name)==42,"archive-selected-read");
  selectorMark("archive:"+archive.name);
  var mismatch=%["title"=>"Typed extension selector","initialDir"=>"game://./","filter"=>"脚本|*.tjs","filterIndex"=>1];
  selectorCheck(Storages.selectFile(mismatch)===1,"typed-result");
  selectorCheck(mismatch.name=="game://./note.txt" && [].load(mismatch.name,"utf-8")[0]=="literal typed file","typed-extension-is-not-a-write-filter");
  selectorMark("typed:"+mismatch.name);
  var save=%["title"=>"Save excludes archive folders","save"=>true,"initialDir"=>"game://./","filter"=>"全部|*.*"];
  selectorCheck(Storages.selectFile(save)===0,"archive-save-cancel");
  selectorMark("after");
}
selectorMark("ready");
`

function controls(page: Page, errors: string[]) {
  const owner = page.locator('.game-window[aria-label="Storage selector owner"]'),
    canvas = owner.locator('canvas[data-window-id]')
  return {
    owner,
    canvas,
    async open() {
      await expect(mark(page, 'ready')).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      await canvas.click({ position: { x: 90, y: 50 } })
      await expect(owner).toHaveAttribute('data-blocked', 'true')
      await expect(mark(page, 'after')).toHaveCount(0)
    },
    async stopped() {
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      expect(errors).toEqual([])
    },
    async stop() {
      // This is the app's existing command and also reaches a startup-owned
      // modal when the normal page control is outside the focus trap.
      if (await page.locator('#stop').isEnabled())
        await page.locator('#stop').dispatchEvent('click')
      await this.stopped()
    },
  }
}

async function attachLogs(page: Page, info: TestInfo) {
  await info.attach('storage-selector-worker-logs', {
    body: await page.locator('#logs').innerText(),
    contentType: 'text/plain',
  })
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: real storage selectors round-trip a Dictionary with filters, default extensions and overwrite confirmation`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        game = controls(page, setup.errors)
      try {
        await page.locator('#files').setInputFiles(files(binary, roundTrip))
        await game.open()
        const save = page.getByRole('dialog', { name: 'Save selector proof', exact: true }),
          filename = save.getByRole('textbox', { name: '文件名', exact: true }),
          filter = save.getByLabel('文件类型', { exact: true })
        await expect(save).toBeVisible()
        await expect(save.getByLabel('目录', { exact: true })).toHaveValue('game://./savedata/')
        await expect(
          save.locator('[data-entry-name="game://./savedata/existing.kdt"]'),
        ).toBeVisible()
        await expect(save.locator('[data-entry-name="game://./savedata/note.txt"]')).toHaveCount(0)
        await expect(save.locator('[data-directory="game://./savedata/sub/"]')).toBeVisible()
        await filter.selectOption('2')
        await expect(save.locator('[data-entry-name="game://./savedata/note.txt"]')).toBeVisible()
        await filename.fill('existing')
        await save.getByRole('button', { name: '保存', exact: true }).click()
        const overwrite = save.getByRole('group', { name: '确认覆盖', exact: true })
        await expect(overwrite).toBeVisible()
        await expect(overwrite).toContainText('existing.kdt')
        await expect(mark(page, 'saved:game://./savedata/existing.kdt:2')).toHaveCount(0)
        await filter.selectOption('1')
        await expect(overwrite).not.toBeVisible()
        await expect(save.locator('[data-entry-name="game://./savedata/note.txt"]')).toHaveCount(0)
        await filter.selectOption('2')
        await save.getByRole('button', { name: '保存', exact: true }).click()
        await expect(overwrite).toBeVisible()
        await overwrite.getByRole('button', { name: '返回', exact: true }).click()
        await expect(overwrite).not.toBeVisible()
        await expect(save).toBeVisible()
        await expect(filename).toHaveValue('existing')
        await save.getByRole('button', { name: '保存', exact: true }).click()
        await overwrite.getByRole('button', { name: '覆盖', exact: true }).click()
        await expect(mark(page, 'saved:game://./savedata/existing.kdt:2')).toBeVisible()
        const open = page.getByRole('dialog', { name: 'Open selector proof', exact: true })
        await expect(open).toBeVisible()
        await expect(open.locator('[data-entry-name="game://./savedata/note.txt"]')).toHaveCount(0)
        await open.locator('[data-entry-name="game://./savedata/existing.kdt"]').click()
        await expect(open.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue(
          'existing.kdt',
        )
        await open.getByRole('button', { name: '打开', exact: true }).click()
        await expect(mark(page, 'loaded:42:保存の文字 雪 😀')).toBeVisible()
        const dot = page.getByRole('dialog', { name: 'Trailing dot selector', exact: true })
        await dot.getByRole('textbox', { name: '文件名', exact: true }).fill('no-extension.')
        await dot.getByRole('button', { name: '保存', exact: true }).click()
        await expect(mark(page, 'dot:game://./savedata/no-extension')).toBeVisible()
        await expect(mark(page, 'after')).toBeVisible()
        await expect(game.owner).toHaveAttribute('data-blocked', 'false')
        await evaluate(page, 'Storages.isExistentStorage("savedata/no-extension.kdt")', '0')
      } finally {
        await attachLogs(page, info)
        await game.stop()
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })

    test(`${variant}: a storage modal pumps Timer and cancellation preserves every supplied option`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        game = controls(page, setup.errors)
      try {
        await page.locator('#files').setInputFiles(files(binary, cancelFlow))
        await game.open()
        const dialog = page.getByRole('dialog', { name: 'Cancel selector proof', exact: true }),
          filename = dialog.getByRole('textbox', { name: '文件名', exact: true })
        await expect(dialog).toBeVisible()
        await expect(mark(page, 'timer:1')).toBeVisible()
        await expect(mark(page, 'escape-return')).toHaveCount(0)
        await filename.fill('edited-but-cancelled')
        await dialog.getByLabel('文件类型', { exact: true }).selectOption('1')
        await filename.focus()
        await page.keyboard.press('a')
        await expect(mark(page, 'game-key:1')).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(mark(page, 'escape-return')).toBeVisible()
        await expect(dialog).toBeVisible()
        await expect(filename).toHaveValue('untouched.kdt')
        await expect(dialog.getByLabel('文件类型', { exact: true })).toHaveValue('2')
        await filename.fill('another-cancelled-name')
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        await expect(mark(page, 'button-return')).toBeVisible()
        await expect(mark(page, 'after')).toBeVisible()
        await expect(game.owner).toHaveAttribute('data-blocked', 'false')
        await evaluate(page, '[selectorCalls,selectorTimers,selectorKeys].join(",")', '1,1,0')
        await game.canvas.focus()
        await page.keyboard.press('a')
        await expect(mark(page, 'game-key:1')).toBeVisible()
      } finally {
        await attachLogs(page, info)
        await game.stop()
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })

    test(`${variant}: open selectors navigate actual archive entries and allow a typed file outside the display filter`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        game = controls(page, setup.errors)
      try {
        await page
          .locator('#files')
          .setInputFiles([
            { name: 'bundle.data', mimeType: 'application/octet-stream', buffer: zipFixture() },
            ...files(binary, archiveFlow),
            textFile('note.txt', 'literal typed file'),
          ])
        await game.open()
        const archive = page.getByRole('dialog', { name: 'Archive selector proof', exact: true })
        await archive.getByLabel('目录', { exact: true }).selectOption('game://./bundle.data>')
        await archive.locator('[data-directory="game://./bundle.data>シーン/"]').click()
        await expect(archive.getByLabel('目录', { exact: true })).toHaveValue(
          'game://./bundle.data>シーン/',
        )
        await archive.locator('[data-entry-name="game://./bundle.data>シーン/value.tjs"]').click()
        await archive.getByRole('button', { name: '打开', exact: true }).click()
        await expect(mark(page, 'archive:game://./bundle.data>シーン/value.tjs')).toBeVisible()
        const typed = page.getByRole('dialog', { name: 'Typed extension selector', exact: true })
        await expect(typed.locator('[data-entry-name="game://./note.txt"]')).toHaveCount(0)
        await typed.getByRole('textbox', { name: '文件名', exact: true }).fill('note.txt')
        await typed.getByRole('button', { name: '打开', exact: true }).click()
        await expect(mark(page, 'typed:game://./note.txt')).toBeVisible()
        const save = page.getByRole('dialog', {
          name: 'Save excludes archive folders',
          exact: true,
        })
        await expect(save).toBeVisible()
        expect(
          await save
            .getByLabel('目录', { exact: true })
            .locator('option')
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
        ).not.toContain('game://./bundle.data>')
        await expect(save.locator('[data-directory*="bundle.data>"]')).toHaveCount(0)
        await save.getByRole('button', { name: '取消', exact: true }).click()
        await expect(mark(page, 'after')).toBeVisible()
      } finally {
        await attachLogs(page, info)
        await game.stop()
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })

    test(`${variant}: Stop retires a startup selector and its detached controls cannot answer a fresh session`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        game = controls(page, setup.errors)
      try {
        await page.locator('#files').setInputFiles(
          files(
            binary,
            String.raw`
var interrupted=%["title"=>"Startup storage selector","save"=>true,"name"=>"savedata/old.kdt","defaultExt"=>"kdt"];
Storages.selectFile(interrupted);
Debug.message("storage-selector-proof:stopped-startup-must-not-resume");
`,
          ),
        )
        const old = page.getByRole('dialog', { name: 'Startup storage selector', exact: true })
        await expect(old).toBeVisible()
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        const oldForm = await old.locator('form').elementHandle(),
          oldSave = await old.getByRole('button', { name: '保存', exact: true }).elementHandle(),
          oldCancel = await old.getByRole('button', { name: '取消', exact: true }).elementHandle(),
          oldStop = await old.getByRole('button', { name: '停止游戏', exact: true }).elementHandle()
        expect(oldForm).not.toBeNull()
        expect(oldSave).not.toBeNull()
        expect(oldCancel).not.toBeNull()
        expect(oldStop).not.toBeNull()
        await old.getByRole('button', { name: '停止游戏', exact: true }).click()
        await game.stopped()
        await expect(mark(page, 'stopped-startup-must-not-resume')).toHaveCount(0)
        for (const handle of [oldForm!, oldSave!, oldCancel!, oldStop!])
          expect(await handle.evaluate((element) => element.isConnected)).toBe(false)
        await page.locator('#files').setInputFiles(
          files(
            binary,
            String.raw`
var fresh=%["title"=>"Fresh storage selector","save"=>true,"initialDir"=>"game://./savedata/","defaultExt"=>"kdt"];
if(Storages.selectFile(fresh)!==1)throw new Exception("fresh selector did not confirm");
if(fresh.name!="game://./savedata/fresh.kdt")throw new Exception("fresh selector received an old answer");
var freshWindow=new Window();freshWindow.visible=true;
Debug.message("storage-selector-proof:fresh-return:"+fresh.name);
`,
          ),
        )
        const fresh = page.getByRole('dialog', { name: 'Fresh storage selector', exact: true })
        await expect(fresh).toBeVisible()
        await fresh.getByRole('textbox', { name: '文件名', exact: true }).fill('fresh')
        // Dispatch real events on the detached elements, rather than relying on
        // HTMLElement.click(), which is a no-op for a disabled old button.
        expect(
          await oldForm!.evaluate((element) =>
            element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
          ),
        ).toBe(false)
        for (const handle of [oldSave!, oldCancel!, oldStop!])
          await handle.evaluate((element) =>
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
          )
        await expect(fresh).toBeVisible()
        await expect(fresh.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue(
          'fresh',
        )
        await expect(mark(page, 'stopped-startup-must-not-resume')).toHaveCount(0)
        await expect(mark(page, 'fresh-return:game://./savedata/fresh.kdt')).toHaveCount(0)
        await fresh.getByRole('button', { name: '保存', exact: true }).click()
        await expect(mark(page, 'fresh-return:game://./savedata/fresh.kdt')).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(1)
        await evaluate(
          page,
          'Storages.isExistentStorage("savedata/old.kdt")||Storages.isExistentStorage("savedata/fresh.kdt")',
          '0',
        )
      } finally {
        await attachLogs(page, info)
        await game.stop()
        await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      }
    })
  }
}

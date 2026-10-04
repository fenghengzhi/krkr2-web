import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  exportSystemSaves,
  prepareSystemPage,
  stopSystemPage,
  type SystemBackup,
} from '../helpers/web-system-core.ts'
import { binaryValue } from '../helpers/binary-scripts.ts'

const seed = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const program = `
var count=0;
if(Storages.isExistentStorage("savedata/target-count.txt"))count=int([].load("savedata/target-count.txt")[0]);
if(!count){
  [${JSON.stringify(seed)}].save("Data/Text.dat","utf-8");
  [${JSON.stringify(seed)}].save("Data/Binary.dat","utf-8");
  [${JSON.stringify(seed)}].save("Direct.dat","utf-8");
}
Storages.addAutoPath("Data/");
var blocked=0;
try{["must-not-write"].save("missing.txt","o0");}catch(e){if(e.message.indexOf("Update target not found:")>=0)blocked++;}
if(blocked!=1)throw "UPDATE must fail at the save call";
if(Storages.isExistentStorage("missing.txt"))throw "UPDATE created a missing target";
if(!count){
  ["T"].save("text.DAT","utf-8o010");
  ["B"].saveStruct("BINARY.dat","bo0");
  ["D"].save("dIRECT.DAT","utf-8");
  // WRITE deliberately creates a root file even though autoPath has Text.dat.
  ["R"].save("text.dat","utf-8");
}
if([].load("Data/Text.dat","o010")[0]!="T")throw "bound text did not persist";
if(Dictionary.loadStruct("Data/Binary.dat")[0]!="B")throw "bound binary did not persist";
count++;[count].save("savedata/target-count.txt","utf-8");
Debug.message("write-targets:ready:"+count);
`
const textFile = (name: string, source: string) => ({
  name, mimeType: 'text/plain', buffer: Buffer.from(source),
})
function saved(backup: SystemBackup, path: string) {
  const file = backup.files.find((entry) => entry.path === path)
  expect(file, path).toBeDefined()
  return Buffer.from(file!.base64, 'base64')
}

for (const backend of ['asyncify', 'jspi'] as const)
  for (const binary of [false, true])
    test(`${backend}/${binary ? 'bytecode' : 'source'}: native UPDATE binds actual save keys and persists without case or auto-path shadows`, async ({ page }, info) => {
      const setup = await prepareSystemPage(page, backend),
        backups: SystemBackup[] = [],
        input = [
          textFile('startup.tjs', binary
            ? 'Scripts.compileStorage("write-targets.tjs","savedata/targets.cjs",false,true,false);Scripts.execStorage("savedata/targets.cjs");'
            : 'Scripts.execStorage("write-targets.tjs");'),
          textFile('write-targets.tjs', program),
        ]
      try {
        for (const count of [1, 2]) {
          await page.locator('#files').setInputFiles(input)
          await expect(page.getByText(`write-targets:ready:${count}`, { exact: true })).toBeVisible()
          await evaluate(page, 'Storages.getPlacedPath("Data/text.DAT")', 'game://./Data/Text.dat')
          await evaluate(page, 'Storages.getPlacedPath("binary.DAT")', 'game://./Data/Binary.dat')
          const backup = await exportSystemSaves(page)
          backups.push(backup)
          expect(backup.files.map(({ path }) => path).sort()).toEqual([
            'Data/Binary.dat', 'Data/Text.dat', 'Direct.dat', 'savedata/target-count.txt',
            ...(binary ? ['savedata/targets.cjs'] : []), 'text.dat',
          ].sort())
          const text = Buffer.from(seed + '\r\n'), bytes = Buffer.from(seed + '\r\n')
          Buffer.from('T\r\n').copy(text, 8)
          Buffer.from(binaryValue(['B'])).copy(bytes)
          expect(saved(backup, 'Data/Text.dat')).toEqual(text)
          expect(saved(backup, 'Data/Binary.dat')).toEqual(bytes)
          expect(saved(backup, 'Direct.dat')).toEqual(Buffer.from('D\r\n'))
          expect(saved(backup, 'text.dat')).toEqual(Buffer.from('R\r\n'))
          expect(saved(backup, 'savedata/target-count.txt')).toEqual(Buffer.from(`${count}\r\n`))
          await stopSystemPage(page, setup.errors)
          await expect.poll(() => setup.workers.filter(({ closed }) => closed).length).toBe(count)
          if (count === 1) await page.reload()
        }
        expect(backups[1]!.gameId).toBe(backups[0]!.gameId)
        expect(setup.workers).toHaveLength(2)
      } finally {
        await info.attach('write-targets-persistent-exports', {
          body: JSON.stringify(backups), contentType: 'application/json',
        })
        await info.attach('write-targets-worker-logs', {
          body: await page.locator('#logs').innerText(), contentType: 'text/plain',
        })
        await stopSystemPage(page, setup.errors)
      }
    })

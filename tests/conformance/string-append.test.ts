import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const source = String.raw`
function repeat(value,count){var output="";while(count>0){if(count&1)output+=value;count>>=1;if(count>0)value+=value;}return output;}
var small="x";small+=small;small+=small;
var boundary="abcdefghij";boundary+=boundary;var shortLength=boundary.length;
boundary+=boundary;var saved=boundary;boundary+=boundary;
var unicode="雪😀";unicode+=unicode;
var large=repeat("x",262145),tail=large.substr(262140);
var result=[small,shortLength,boundary.length,saved.length,unicode,large.length,tail].join("|");
delete global.large;delete global.boundary;delete global.saved;
`

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: native string self append preserves short, growing, shared and large values`, { timeout: 60000 }, async () => {
    const { session } = await headless({ 'startup.tjs': '', 'append.tjs': source })
    try {
      await session.start()
      if (binary) {
        await session.evaluate('Scripts.compileStorage("append.tjs","savedata/append.cjs",false,true,false)')
        await session.evaluate('Scripts.execStorage("savedata/append.cjs")')
      } else await session.evaluate('Scripts.execStorage("append.tjs")')
      assert.equal(await session.evaluate('result'), 'xxxx|20|80|40|雪😀雪😀|262145|xxxxx')
      assert.equal(await session.evaluate('6*7'), '42')
    } finally { await session.stop() }
    assert.equal(session.snapshot().handles, 0)
    assert.equal(session.snapshot().bitmapBytes, 0)
    assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  })
}

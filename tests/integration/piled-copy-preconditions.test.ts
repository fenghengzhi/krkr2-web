import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

for (const binary of [false, true]) {
  for (const missing of ['source', 'target']) {
    test(`${binary ? 'bytecode' : 'source'}: piledCopy rejects an image-less ${missing} before drawing callbacks can repair it`, async () => {
      const body = String.raw`
var win=new Window(),root=new Layer(win,null);
var source=new Layer(win,root),target=new Layer(win,root);
source.setSize(2,1);target.setSize(2,1);
${missing}.hasImage=false;
var paints=0,rejected=0;
source.onPaint=function(){paints++;global.${missing}.hasImage=true;};
source.callOnPaint=true;
try{target.piledCopy(0,0,source,0,0,1,1);}catch(error){rejected++;}
var beforeCompletion=rejected+","+paints+","+int(source.callOnPaint)+","+int(${missing}.hasImage);
`,
        { session } = await headless({ 'startup.tjs': '', 'copy-preconditions.tjs': body })
      try {
        await session.start()
        if (binary) {
          await session.evaluate(
            'Scripts.compileStorage("copy-preconditions.tjs","savedata/copy-preconditions.cjs",false,true,false)',
          )
          await session.evaluate('Scripts.execStorage("savedata/copy-preconditions.cjs")')
        } else await session.evaluate('Scripts.execStorage("copy-preconditions.tjs")')
        assert.equal(await session.evaluate('beforeCompletion'), '1,0,1,0')
        // The rejected copy leaves the pending paint for the ordinary frame.
        assert.equal(await session.evaluate('paints'), '1')
        assert.equal(await session.evaluate(`int(${missing}.hasImage)`), '1')
      } finally {
        await session.stop()
        assert.equal(session.snapshot().handles, 0)
      }
    })
  }
}

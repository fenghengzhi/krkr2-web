import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'
const reference = JSON.parse(
  readFileSync(new URL('../fixtures/font-geometry/reference.json', import.meta.url), 'utf8'),
) as {
  rectangles: {
    a: number[]
    b: number[]
    clip: number[]
    union: number[]
    relations: number[]
    size: number[]
  }[]
}
test('Rect geometry matches 337 native pairs, including empty and inverted rectangles', async () => {
  const { session } = await headless({
    'startup.tjs': `
var inputs=${JSON.stringify(reference.rectangles.map((r) => [r.a, r.b]))},results=[];
for(var i=0;i<inputs.count;i++) {
  var a=new Rect(inputs[i][0]*),b=new Rect(inputs[i][1]*),c=new Rect(a),u=new Rect(a);
  var clipped=c.clip(b),united=u.union(b);
  results.add([clipped,c.left,c.top,c.right,c.bottom,united,u.left,u.top,u.right,u.bottom,a.isEmpty(),b.isEmpty(),a.intersects(b),a.included(b),b.included(a),a.equal(b),a.width,a.height].join(","));
}
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate('results.join(";")'),
      reference.rectangles
        .map((r) => [...r.clip, ...r.union, ...r.relations, ...r.size].join(','))
        .join(';'),
    )
  } finally {
    await session.stop()
  }
})
test('Rect constructors, properties, offsets and copies preserve native script-visible semantics', async () => {
  const { session } = await headless({ 'startup.tjs': 'var a=new Rect(1,2,7,9),b=new Rect(a);' })
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        '(function(){a.width=10;a.height=-4;a.addOffset(2,-3);a.setOffset(-5,8);return [a.left,a.top,a.right,a.bottom,b.left,b.top,b.right,b.bottom].join(",");})()',
      ),
      '-5,8,5,4,1,2,7,9',
    )
    assert.equal(
      await session.evaluate(
        '(function(){a.setSize(4,6);a.left=10;return [a.left,a.top,a.right,a.bottom,a.width,a.height].join(",");})()',
      ),
      '10,8,-1,14,-11,6',
    )
    assert.equal(
      await session.evaluate(
        '(function(){var r=new Rect(0,0,2,2);return [r.includedPos(0,0),r.includedPos(1,1),r.includedPos(2,1),r.includedPos(1,2),r.includedPos(-1,0)].join(",");})()',
      ),
      '1,1,0,0,0',
    )
    assert.equal(
      await session.evaluate(
        '(function(){var b=new Rect(1,2),c=new Rect(1,2,3),d=new Rect(1,2,3,4,5),z=new Rect();a.clear();return [b.equal(z),c.equal(z),d.equal(z),a.equal(z)].join(",");})()',
      ),
      '1,1,1,1',
    )
    assert.equal(
      await session.evaluate(
        '(function(){a.set(4294967295,2147483648,-2147483649,4294967296);return [a.left,a.top,a.right,a.bottom].join(",");})()',
      ),
      '-1,-2147483648,2147483647,0',
    )
    assert.equal(
      await session.evaluate(
        '(function(){var r=new Rect(0,0,10,10);r.union(new Rect(5,5,20,20));return typeof r.left+","+typeof r.top+","+typeof r.right+","+typeof r.bottom;})()',
      ),
      'Integer,Integer,Integer,Integer',
    )
  } finally {
    await session.stop()
  }
})
test('Rect rejects wrong objects and missing arguments, supports null no-ops and invalidation', async () => {
  const { session } = await headless({ 'startup.tjs': 'var r=new Rect(1,2,3,4);' })
  try {
    await session.start()
    for (const source of [
      'new Rect(null)',
      'new Rect(%[left:1,top:2,right:3,bottom:4])',
      'r.clip(%[])',
      'r.union(1)',
      'r.intersects(void)',
      'r.included()',
      'r.equal([])',
      'r.set(1,2,3)',
      'r.setSize(1)',
      'r.setOffset()',
      'r.addOffset(1)',
      'r.includedPos(1)',
    ])
      assert.equal(
        await session.evaluate(`(function(){try{${source};return 0;}catch(e){return 1;}})()`),
        '1',
        source,
      )
    assert.equal(
      await session.evaluate(
        '[r.clip(null)===void,r.union(null)===void,r.intersects(null)===void,r.included(null)===void,r.equal(null)===void,r.left,r.top,r.right,r.bottom].join(",")',
      ),
      '1,1,1,1,1,1,2,3,4',
    )
    assert.match(
      await session.evaluate(
        '(function(){try{return r.nativeArray;}catch(e){return e.message;}})()',
      ),
      /native plugin pointer/,
    )
    await session.evaluate('invalidate r')
    assert.equal(
      await session.evaluate('(function(){try{return r.left;}catch(e){return "invalidated";}})()'),
      'invalidated',
    )
  } finally {
    await session.stop()
  }
})

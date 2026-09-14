import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const setup = String.raw`
var callbacks=[];
class Probe extends KAGParser {
  var localValue=42;
  function Probe() { super.KAGParser(); debugLevel=tkdlNone; }
  function onLabel(label,page) { callbacks.add(label+"|"+string(page)); }
  function onScript(source,name,line) { Scripts.exec(source,name,line,this); }
  function onAfterReturn() { callbacks.add("returned"); }
}
var parser = new Probe(); parser.loadScenario("main.ks");
function drain() {
  var output="", count=0, tag;
  while((tag=parser.getNextTag()) !== void) {
    if(++count>200) throw new Exception("Parser did not finish");
    if(tag.tagname=="ch") output+=tag.text;
    else if(tag.tagname=="r") output+="/";
    else output+="<"+tag.tagname+">";
  }
  return output;
}
`

test('KAG tags preserve quoting, attribute order, reusable dictionaries, labels and line rules', async () => {
  const { session } = await headless({
    'startup.tjs': setup,
    'main.ks':
      '; comment\n*start|Page\n\t@EMIT Flag A="space `"quote`"" value=&localValue\n[[字[p]\nlast\\\n',
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate('(function(){global.first=parser.getNextTag();return first.a;})()'),
      'space "quote"',
    )
    assert.equal(await session.evaluate('first.value'), '42')
    assert.equal(await session.evaluate('first.flag'), 'true')
    assert.equal(await session.evaluate('first.taglist.join(",")'), 'tagname,flag,a,value')
    assert.equal(
      await session.evaluate(
        '(function(){var next=parser.getNextTag();return next===first && first.text=="[";})()',
      ),
      '1',
    )
    assert.equal(await session.evaluate('drain()'), '字<p>last')
    assert.equal(await session.evaluate('callbacks.join(",")'), '*start|Page')
    assert.equal(await session.evaluate('parser.getNextTag()===void'), '1')
  } finally {
    await session.stop()
  }
})

test('KAG macro arguments are live, nested forwarding preserves order, and expansion unwinds', async () => {
  const source =
    '[macro name=outer][emit p=%name|guest][inner *][endmacro]\\\n[macro name=inner][emit * name=%name|missing][endmacro]\\\n[outer name=Alice count=7]\\\n'
  const { session } = await headless({ 'startup.tjs': setup, 'main.ks': source })
  try {
    await session.start()
    assert.equal(await session.evaluate('parser.getNextTag().p'), 'Alice')
    assert.equal(await session.evaluate('parser.mp.taglist===void'), '1')
    await session.evaluate('parser.mp.name="Bob"')
    assert.equal(
      await session.evaluate('(function(){global.next=parser.getNextTag();return next.name;})()'),
      'Bob',
    )
    assert.equal(await session.evaluate('next.taglist.join(",")'), 'tagname,name,count,name')
    assert.equal(await session.evaluate('next.count'), '7')
    assert.equal(await session.evaluate('drain()'), '')
    assert.equal(await session.evaluate('parser.macroParams===null'), '1')
    assert.equal(await session.evaluate('parser.macros.outer.indexOf("[macropop]")>=0'), '1')
  } finally {
    await session.stop()
  }
})

test('KAG saved call frames restore across storages and reject malformed condition state', async () => {
  const { session } = await headless({
    'startup.tjs': setup,
    'main.ks': '*start\n[call storage=sub.ks target=*sub]Q\\\n',
    'sub.ks': '*sub\nS[return]\\\n',
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('parser.getNextTag().text'), 'S')
    assert.equal(
      await session.evaluate(
        '(function(){global.saved=parser.store();return saved.callStack.count;})()',
      ),
      '1',
    )
    await session.evaluate('(function(){parser.restore(saved);return 0;})()')
    assert.equal(await session.evaluate('drain()'), 'SQ')
    assert.match(
      await session.evaluate(
        '(function(){saved.IfLevelExecutedStack="101";try{parser.restore(saved);}catch(error){return error.message;}})()',
      ),
      /Malformed KAG condition nesting/,
    )
  } finally {
    await session.stop()
  }
})

test('KAG label aliases, disabled control processing and callback veto are observable', async () => {
  const { session } = await headless({
    'startup.tjs': setup,
    'main.ks': '*a\nA\\\n*|Second\n[if exp=false]B[endif][jump target=*missing]\\\n*a\nC\\\n',
  })
  try {
    await session.start()
    await session.evaluate(
      '(function(){parser.goToLabel("*a:2");parser.processSpecialTags=false;return 0;})()',
    )
    assert.equal(await session.evaluate('parser.getNextTag().tagname'), 'if')
    assert.equal(await session.evaluate('parser.curLabel'), '*a:2')
    await session.evaluate(
      '(function(){parser.processSpecialTags=true;parser.onJump=function(tag){return false;};return 0;})()',
    )
    assert.equal(await session.evaluate('drain()'), 'BC')
    assert.equal(await session.evaluate('parser.curLabel'), '*a:3')
  } finally {
    await session.stop()
  }
})

test('KAG conditions, cond, emb and inline TJS execute in the subclass context', async () => {
  const source =
    '[if exp="false"][if exp="missingFunction()"]X[endif][elsif exp="localValue==42"]Y[else]N[endif][ignore exp="true"]N[endignore][emit cond="false"][emb exp="\'[x]\'"]\\\n@iscript\nlocalValue+=1;\n@endscript\n[emb exp="localValue"]\\\n'
  const { session } = await headless({ 'startup.tjs': setup, 'main.ks': source })
  try {
    await session.start()
    assert.equal(await session.evaluate('drain()'), 'Y[x]43')
    assert.equal(await session.evaluate('parser.localValue'), '43')
  } finally {
    await session.stop()
  }
})

test('KAG call/return resumes the calling line and jump passes labels in order', async () => {
  const { session } = await headless({
    'startup.tjs': setup,
    'main.ks': '*start|Page\nA[call storage=other.ks target=*sub]B[jump target=*end]X\n*end\nZ\\\n',
    'other.ks': '*sub\nS[return]Q\n',
  })
  try {
    await session.start()
    assert.equal(await session.evaluate('drain()'), 'ASBZ')
    assert.equal(await session.evaluate('callbacks.join(",")'), '*start|Page,*sub|,returned,*end|')
    assert.equal(await session.evaluate('parser.callStackDepth'), '0')
  } finally {
    await session.stop()
  }
})

test('KAG assign copies the exact position; persistent store/restore resumes the saved label', async () => {
  const { session } = await headless({ 'startup.tjs': setup, 'main.ks': '*start\nAB\\\n' })
  try {
    await session.start()
    assert.equal(await session.evaluate('parser.getNextTag().text'), 'A')
    await session.evaluate(
      '(function(){global.copy=new Probe();copy.assign(parser);global.saved=parser.store();(Dictionary.saveStruct incontextof saved)("savedata/parser.bin","b");return 0;})()',
    )
    assert.equal(await session.evaluate('copy.getNextTag().text'), 'B')
    await session.evaluate(
      '(function(){parser.restore(Dictionary.loadStruct("savedata/parser.bin"));return 0;})()',
    )
    assert.equal(await session.evaluate('parser.getNextTag().text'), 'A')
    assert.equal(
      await session.evaluate(
        '(function(){parser.interrupt();return parser.getNextTag().tagname;})()',
      ),
      'interrupt',
    )
    assert.equal(await session.evaluate('parser.getNextTag().text'), 'B')
  } finally {
    await session.stop()
  }
})

test('System app locks are exclusive across live sessions and exit flushes before releasing them', async () => {
  const first = await headless({ 'startup.tjs': 'var locked=System.createAppLock("test-kag");' })
  const second = await headless({ 'startup.tjs': 'var locked=System.createAppLock("test-kag");' })
  try {
    await first.session.start()
    await second.session.start()
    assert.equal(await first.session.evaluate('locked'), '1')
    assert.equal(await second.session.evaluate('locked'), '0')
    await first.session.evaluate(
      '(function(){["finished"].save("savedata/exit.txt");System.exit();throw new Exception("after exit");})()',
    )
    await first.session.stop()
    assert.equal(first.session.snapshot().state, 'stopped')
    assert.equal(first.session.exportSaves().length, 1)
    assert.equal(await second.session.evaluate('System.createAppLock("test-kag")'), '1')
    assert.ok(!first.logs.some((text) => text.includes('cancelled') || text.includes('after exit')))
  } finally {
    await first.session.stop()
    await second.session.stop()
  }
})

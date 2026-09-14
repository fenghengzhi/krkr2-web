import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
const scene = String.raw`
var window=new Window();window.setInnerSize(200,100);window.visible=true;
var root=new Layer(window,null);root.setSize(200,100);root.fillRect(0,0,200,100,0xff000000);
var events=[];
class Control extends Layer {
  function Control(parent,name,x){super.Layer(global.window,parent);this.name=name;left=x;visible=true;focusable=true;fillRect(0,0,32,32,0xffffffff);}
  function onBeforeFocus(layer,previous,direction){events.add("before:"+name);super.onBeforeFocus(layer,previous,direction);}
  function onFocus(previous,direction){events.add("focus:"+name+":"+(previous===null?"-":previous.name));}
  function onBlur(next){events.add("blur:"+name+":"+(next===null?"-":next.name));}
  function onMouseDown(x,y,button,shift){events.add("down:"+name+":"+x+","+y);}
  function onMouseUp(x,y,button,shift){events.add("up:"+name+":"+x+","+y);}
  function onClick(x,y){events.add("click:"+name);}
  function onMouseEnter(){events.add("enter:"+name);}
  function onMouseLeave(){events.add("leave:"+name);}
}
var a=new Control(root,"a",0),b=new Control(root,"b",50);
var modal=new Layer(window,root);modal.setSize(40,40);modal.left=120;var c=new Control(modal,"c",0);
`
test('focus callbacks, modal enabled state and Tab navigation preserve TJS object identity', async () => {
  const { session } = await headless({ 'startup.tjs': scene })
  try {
    await session.start()
    await session.evaluate('a.focus()')
    assert.equal(await session.evaluate('events.join("|")'), 'before:a|focus:a:-')
    await session.input({ type: 'keyDown', key: 9, shift: 0 })
    assert.equal(await session.evaluate('window.focusedLayer===b'), '1')
    await session.evaluate('modal.setMode()')
    assert.equal(
      await session.evaluate(
        '[a.nodeEnabled,b.nodeEnabled,c.nodeEnabled,window.currentModalLayer===modal,window.focusedLayer===c].join(",")',
      ),
      '0,0,1,1,1',
    )
    await session.click(5, 5)
    assert.equal(await session.evaluate('events.find("click:a")<0'), '1')
    await session.click(125, 5)
    assert.equal(await session.evaluate('events.find("click:c")>=0'), '1')
    await session.evaluate('modal.removeMode()')
    assert.equal(
      await session.evaluate('window.currentModalLayer===null&&a.nodeEnabled&&b.nodeEnabled'),
      '1',
    )
    await session.evaluate('c.visible=false')
    assert.equal(await session.evaluate('window.focusedLayer===a'), '1')
  } finally {
    await session.stop()
  }
})
test('before-focus redirects, nested focus errors unlock, and detached focus recovers', async () => {
  const { session } = await headless({
    'startup.tjs':
      scene +
      String.raw`
a.onBeforeFocus=function(layer,previous,direction){(global.Layer.onBeforeFocus incontextof this)(b,previous,direction);};
`,
  })
  try {
    await session.start()
    await session.evaluate('a.focus()')
    assert.equal(await session.evaluate('window.focusedLayer===b'), '1')
    await session.evaluate(
      '(function(){a.onBeforeFocus=function(layer,previous,direction){(global.Layer.onBeforeFocus incontextof this)(layer,previous,direction);};b.onBlur=function(next){try{b.focus();}catch(error){events.add("locked");}};return 0;})()',
    )
    await session.evaluate('a.focus()')
    assert.equal(await session.evaluate('events.find("locked")>=0&&window.focusedLayer===a'), '1')
    await session.evaluate('b.focus()')
    assert.equal(await session.evaluate('window.focusedLayer===b'), '1')
    await session.evaluate('b.parent=null')
    assert.equal(await session.evaluate('window.focusedLayer===a && b.parent===null'), '1')
  } finally {
    await session.stop()
  }
})
test('mouse capture holds a drag target; disabled opaque layers block input underneath', async () => {
  const { session } = await headless({ 'startup.tjs': scene })
  try {
    await session.start()
    await session.input({ type: 'down', x: 5, y: 5, button: 0, shift: 8, clicks: 0 })
    await session.input({ type: 'move', x: 55, y: 5, button: 0, shift: 8, clicks: 0 })
    await session.input({ type: 'up', x: 55, y: 5, button: 0, shift: 0, clicks: 1 })
    assert.equal(
      await session.evaluate('events.find("up:a:55,5")>=0 && events.find("click:b")<0'),
      '1',
    )
    await session.evaluate('(function(){b.left=0;b.enabled=false;events.clear();return 0;})()')
    await session.click(5, 5)
    assert.equal(await session.evaluate('events.find("click:a")<0'), '1')
    await session.evaluate('(function(){b.visible=false;a.opacity=0;return 0;})()')
    await session.click(5, 5)
    assert.equal(await session.evaluate('events.find("click:a")>=0'), '1')
  } finally {
    await session.stop()
  }
})
test('script hit tests veto masks, honor province pixels and expose disabled hits explicitly', async () => {
  const { session } = await headless({
    'startup.tjs':
      scene +
      String.raw`
b.left=0;b.onHitTest=function(x,y,hit){(global.Layer.onHitTest incontextof this)(x,y,x>=16);};
`,
  })
  try {
    await session.start()
    assert.equal(
      await session.evaluate('root.getLayerAt(5,5)===a && root.getLayerAt(20,5)===b'),
      '1',
    )
    await session.click(5, 5)
    await session.click(20, 5)
    assert.equal(
      await session.evaluate('events.find("click:a")>=0&&events.find("click:b")>=0'),
      '1',
    )
    await session.evaluate('b.enabled=false')
    assert.equal(
      await session.evaluate(
        'root.getLayerAt(20,5)===null && root.getLayerAt(20,5,false,true)===b',
      ),
      '1',
    )
    await session.evaluate(
      '(function(){b.enabled=true;b.hitType=htProvince;b.hitThreshold=0;b.setProvincePixel(20,5,1);return 0;})()',
    )
    assert.equal(
      await session.evaluate('root.getLayerAt(20,5)===b && root.getLayerAt(21,5)===a'),
      '1',
    )
    await session.evaluate(
      '(function(){b.hasImage=false;b.onHitTest=function(x,y,hit){};return 0;})()',
    )
    assert.equal(await session.evaluate('root.getLayerAt(20,5)===a'), '1')
    await session.evaluate('b.hitType=htMask')
    assert.equal(
      await session.evaluate('root.getLayerAt(20,5)===b && b.getLayerAt(20,5,true)===null'),
      '1',
    )
  } finally {
    await session.stop()
  }
})
test('posted key events are asynchronous, reach Window and Layer, and do not alter physical keys', async () => {
  const { session } = await headless({
    'startup.tjs':
      scene +
      String.raw`
a.focus();events.clear();
window.onKeyDown=function(key,shift){events.add("window:"+key+":"+shift);};
a.onKeyDown=function(key,shift,process){events.add("layer:"+key+":"+System.getKeyState(key));};
a.onKeyPress=function(key,process){events.add("text:"+key);};
window.postInputEvent("onKeyDown",%[key:VK_A]);
window.postInputEvent("onKeyPress",%[key:"中"]);
events.add("returned");
`,
  })
  try {
    await session.start()
    await session.idle()
    assert.equal(
      await session.evaluate('events.join("|")'),
      'returned|window:65:0|layer:65:0|text:中',
    )
    assert.equal(
      await session.evaluate(
        '(function(){try{window.postInputEvent("onClick",%[]);}catch(error){return true;}return false;})()',
      ),
      '1',
    )
  } finally {
    await session.stop()
  }
})
test('touch capture tracks each contact independently and releaseTouchCapture changes its target', async () => {
  const { session } = await headless({
    'startup.tjs':
      scene +
      String.raw`
function touch(x,y,cx,cy,id){events.add(name+":"+id+":"+x);}
a.onTouchDown=touch incontextof a;b.onTouchDown=touch incontextof b;
a.onTouchMove=touch incontextof a;b.onTouchMove=touch incontextof b;
`,
  })
  try {
    await session.start()
    await session.input({ type: 'touchDown', x: 5, y: 5, width: 2, height: 2, id: 11 })
    await session.input({ type: 'touchDown', x: 55, y: 5, width: 2, height: 2, id: 22 })
    await session.input({ type: 'touchMove', x: 65, y: 5, width: 2, height: 2, id: 11 })
    await session.input({ type: 'touchMove', x: 10, y: 5, width: 2, height: 2, id: 22 })
    await session.evaluate('a.releaseTouchCapture(11)')
    await session.input({ type: 'touchMove', x: 65, y: 5, width: 2, height: 2, id: 11 })
    assert.equal(
      await session.evaluate('events.join("|")'),
      'a:11:5|b:22:5|a:11:65|b:22:-40|b:11:15',
    )
  } finally {
    await session.stop()
  }
})

test('physical cursor observation bypasses disabled event delivery and uses current layer coordinates', async () => {
  const { session } = await headless({
    'startup.tjs': `
var w=new Window();w.visible=true;w.setZoom(2,1);w.setLayerPos(10,20);
var root=new Layer(w,null),child=new Layer(w,root);root.setSize(100,100);child.setPos(5,7);
var seen="";w.onMouseDown=function(){seen=child.cursorX+","+child.cursorY;};System.eventDisabled=true;
`,
  })
  try {
    await session.start()
    const pending = session.input({ type: 'down', x: 20, y: 40, button: 0, shift: 8, clicks: 1 })
    await session.pointerMove(50, 80)
    assert.equal(await session.evaluate('child.cursorX+","+child.cursorY'), '15,23')
    assert.equal(await session.evaluate('seen'), '')
    await session.evaluate('System.eventDisabled=false')
    await pending
    assert.equal(await session.evaluate('seen'), '15,23')
    session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
    session.pointerState(100, 120)
    session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
    assert.equal(await session.evaluate('child.cursorX+","+child.cursorY'), '15,23')
  } finally {
    await session.stop()
  }
})

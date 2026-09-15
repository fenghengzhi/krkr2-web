export const windowClass = String.raw`
function __krkrWindowInvalidate(window,id) {
  try {
    window.__windowClosing=true;
    __host("Window.detachInput",id);
    var objects=window.__windowObjects;
    if(objects!==void) {
      for(var i=0;i<objects.count;i++) {
        try { invalidate objects[i]; } catch(error) { Debug.message(error.message); }
      }
      objects.clear();
    }
    if(window.__windowMenu!==null && window.__windowMenu!==void) invalidate window.__windowMenu;
  } catch(error) {
    __host("Window.finish",id);
    throw error;
  }
  __host("Window.finish",id);
}
class Window {
  var __windowId, __windowMenu=null, __windowObjects, __windowKeys, __windowClosing=false, __windowCanClose=false;
  function Window() {
    __windowObjects=[];__windowKeys=[];
    __windowId=__host("Window.create",this,__krkrWindowInvalidate);
    __host("Input.synchronize");
  }
  function finalize() {}
  function add(object) {
    if(__windowClosing)return;
    var key=__host("Window.identity",object);
    if(__windowKeys.find(key)<0){__windowKeys.add(key);__windowObjects.add(object);}
  }
  function remove(object) {
    if(__windowClosing)return;
    var index=__windowKeys.find(__host("Window.identity",object));
    if(index>=0){__windowKeys.erase(index);__windowObjects.erase(index);}
  }
  property menu { getter() {
    if(__windowMenu===null) {
      __windowMenu=new MenuItem(this,this);
    }
    return __windowMenu;
  } }
  property primaryLayer { getter() { return __host("Window.primary",__windowId); } }
  function __windowDispatch(name,args) { return this[name](args*); }
  function close() {
    __windowCanClose=false;
    onCloseQuery(true);
    if(__windowCanClose) { var exit=global.System.exit incontextof global; invalidate this; exit(); }
  }
  function onCloseQuery(canClose) { __windowCanClose=!!canClose; }
  function setInnerSize(width,height) { __host("Window.resize",__windowId,int(width),int(height)); }
  function setSize(width,height) { setInnerSize(width,height); }
  function setPos(left,top) { this.left=left;this.top=top; }
  function setLayerPos(left,top) { layerLeft=left;layerTop=top; }
  function setZoom(numer,denom) { __host("Window.zoom",__windowId,int(numer),int(denom)); }
  function setMinSize(width,height) { minWidth=width;minHeight=height; }
  function setMaxSize(width,height) { maxWidth=width;maxHeight=height; }
  function update(type=utNormal) { __host("Window.update",__windowId); }
  function hideMouseCursor() { mouseCursorState=mcsTempHidden; }
  function postInputEvent(name,params=null) {
    if(name!="onKeyDown" && name!="onKeyUp" && name!="onKeyPress")throw new Exception("Unknown input event: "+name);
    if(params===null || params.key===void)throw new Exception("Input event requires key");
    __host("Window.postInput",__windowId,string(name),name=="onKeyPress"?string(params.key):int(params.key),int(params.shift));
  }
  function onResize() {}
  ${[
    ['onActivate', ''],
    ['onDeactivate', ''],
    ['onClick', 'x,y'],
    ['onDoubleClick', 'x,y'],
    ['onMouseDown', 'x,y,button,shift'],
    ['onMouseUp', 'x,y,button,shift'],
    ['onMouseMove', 'x,y,shift'],
    ['onMouseEnter', ''],
    ['onMouseLeave', ''],
    ['onMouseWheel', 'shift,delta,x,y'],
    ['onKeyDown', 'key,shift'],
    ['onKeyUp', 'key,shift'],
    ['onKeyPress', 'key'],
    ['onTouchDown', 'x,y,cx,cy,id'],
    ['onTouchMove', 'x,y,cx,cy,id'],
    ['onTouchUp', 'x,y,cx,cy,id'],
  ]
    .map(
      ([name, args]) =>
        `function ${name}(${args}){if(typeof this.action!="undefined")this.action(%[type:"${name}",target:this${
          args
            ? ',' +
              args
                .split(',')
                .map((arg) => arg + ':' + arg)
                .join(',')
            : ''
        }]);}`,
    )
    .join('\n')}
  property focusedLayer {getter(){return __host("Input.get",0,"focusedLayer");}setter(layer){__host("Input.focus",layer===null?0:layer.__id,1);}}
  property currentModalLayer {getter(){return __host("Input.get",0,"currentModalLayer");}}
  property mainWindow { getter() { return true; } }
  ${[
    'caption',
    'visible',
    'width',
    'height',
    'innerWidth',
    'innerHeight',
    'left',
    'top',
    'borderStyle',
    'innerSunken',
    'showScrollBars',
    'layerLeft',
    'layerTop',
    'zoomNumer',
    'zoomDenom',
    'minWidth',
    'minHeight',
    'maxWidth',
    'maxHeight',
    'focusable',
    'fullScreen',
    'mouseCursorState',
    'imeMode',
    'trapKey',
    'useMouseKey',
    'stayOnTop',
  ]
    .map(
      (name) => `property ${name} {
    getter() { return __host("Window.get",__windowId,"${name}"); }
    setter(value) { __host("Window.set",__windowId,"${name}",${name === 'caption' ? 'string' : 'int'}(value)); }
  }`,
    )
    .join('\n')}
}
`

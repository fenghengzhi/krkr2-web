export const windowClass = String.raw`
class Window {
  var primaryLayer=null, menu, __windowObjects, __windowClosing=false, __windowCanClose=false;
  function Window() {
    __windowObjects=[];
    __host("Window.create", __windowDispatch);
    menu=new MenuItem(this);
    __host("Menu.root", menu.__menuId, __menuClick);
  }
  function finalize() {
    __windowClosing=true;
    for(var i=0;i<__windowObjects.count;i++) {
      try { invalidate __windowObjects[i]; } catch(error) { Debug.message(error.message); }
    }
    __windowObjects.clear();
    if(primaryLayer!==null) invalidate primaryLayer;
    primaryLayer=null;
    invalidate menu;
    __host("Window.destroy");
  }
  function add(object) { if(!__windowClosing && __windowObjects.find(object)<0) __windowObjects.add(object); }
  function remove(object) { if(!__windowClosing) __windowObjects.remove(object); }
  function __menuClick(id) { var item=menu.__menuFind(id);if(item!==null)item.onClick(); }
  function __windowDispatch(name,args) { return this[name](args*); }
  function close() {
    __windowCanClose=false;
    onCloseQuery(true);
    if(__windowCanClose) { var exit=global.System.exit incontextof global; invalidate this; exit(); }
  }
  function onCloseQuery(canClose) { __windowCanClose=!!canClose; }
  function setInnerSize(width,height) { __host("Window.resize", int(width),int(height)); }
  function setSize(width,height) { setInnerSize(width,height); }
  function setPos(left,top) { this.left=left;this.top=top; }
  function setLayerPos(left,top) { layerLeft=left;layerTop=top; }
  function setZoom(numer,denom) { __host("Window.zoom", int(numer),int(denom)); }
  function setMinSize(width,height) { minWidth=width;minHeight=height; }
  function setMaxSize(width,height) { maxWidth=width;maxHeight=height; }
  function update(type=utNormal) { __host("Window.update"); }
  function hideMouseCursor() { mouseCursorState=mcsTempHidden; }
  function postInputEvent(name,params=null) {
    if(name!="onKeyDown" && name!="onKeyUp" && name!="onKeyPress")throw new Exception("Unknown input event: "+name);
    if(params===null || params.key===void)throw new Exception("Input event requires key");
    __host("Window.postInput",string(name),name=="onKeyPress"?string(params.key):int(params.key),int(params.shift));
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
    getter() { return __host("Window.get", "${name}"); }
    setter(value) { __host("Window.set", "${name}", ${name === 'caption' ? 'string' : 'int'}(value)); }
  }`,
    )
    .join('\n')}
}
`

export const layerClass = String.raw`
class __KrkrFont {
  var __data;
  function __KrkrFont() { __data=%[height:18,face:"sans-serif",bold:false,italic:false,underline:false,strikeout:false,angle:0,faceIsFileName:false]; }
  function mapPrerenderedFont(storage) { __host("Font.map",__data,string(storage)); }
  function unmapPrerenderedFont() { __host("Font.unmap",__data); }
  function getTextWidth(text) { return __host("Font.measure",string(text),__data).width; }
  function getTextHeight(text) { return __host("Font.measure",string(text),__data).height; }
  function getGlyphDrawRect(args*) { if(args.count<1)throw new Exception("Missing text for getGlyphDrawRect");var r=__host("Font.bounds",string(args[0]),__data);return new Rect(r.left,r.top,r.right,r.bottom); }
  function getEscWidthX(text) { return getTextWidth(text)*Math.cos(angle*Math.PI/1800); }
  function getEscWidthY(text) { return -getTextWidth(text)*Math.sin(angle*Math.PI/1800); }
  function getEscHeightX(text) { return getTextHeight(text)*Math.sin(angle*Math.PI/1800); }
  function getEscHeightY(text) { return getTextHeight(text)*Math.cos(angle*Math.PI/1800); }
  function getList(args*) { if(args.count<1)throw new Exception("Missing flags for getList");return __host("Font.list",int(args[0])&0xffffffff,__data); }
  function doUserSelect(args*) {
    if(args.count<4)throw new Exception("Missing font selection arguments");
    var selected=__host("Font.select",int(args[0])&0xffffffff,string(args[1]),string(args[2]),string(args[3]),__data);
    if(selected===null)return false;
    __data.face=selected;__data.faceIsFileName=false;return true;
  }
  ${['height', 'face', 'bold', 'italic', 'underline', 'strikeout', 'angle', 'faceIsFileName']
    .map(
      (name) => `property ${name} {
    getter() { return __data.${name}; }
    setter(value) { __data.${name}=${name === 'face' ? 'string(value)' : name === 'height' ? 'Math.abs(int(value))' : name === 'angle' ? '((int(value)%3600)+3600)%3600' : 'int(!!value)'}; }
  }`,
    )
    .join('\n')}
}
class Layer {
  var __id, __layerWindow, __parent, __children, __font;
  function Layer(window,parent) {
    __layerWindow=window;__parent=parent;__children=[];__font=new __KrkrFont();
    if(parent!==null && parent.__layerWindow!==window) throw new Exception("Parent belongs to another window");
    __id=__host("Layer.create",parent!==null?parent.__id:0);
    if(parent===null)window.primaryLayer=this;else parent.__children.add(this);
    __host("Layer.bind",__id,this);
  }
  function finalize() {
    if(__id===void)return;
    if(__parent!==null)__parent.__children.remove(this);
    for(var i=0;i<__children.count;i++)__children[i].__parent=null;
    __children.clear();
    if(__layerWindow.primaryLayer===this)__layerWindow.primaryLayer=null;
    __host("Layer.destroy",__id);
    invalidate __font;
    __layerWindow=null;__parent=null;
  }
  function __findLayer(id) {
    if(__id==id)return this;
    for(var i=0;i<__children.count;i++){var found=__children[i].__findLayer(id);if(found!==null)return found;}
    return null;
  }
  function __syncTree(){var tree=__host("Layer.relations",__id);__parent=tree.parent;__children=tree.children;if(tree.primary)__layerWindow.primaryLayer=this;}
  function __transitionTick(token){var clock=__host("Transition.callback",token);if(clock!==void)__host("Transition.tick",token,clock());}
  function beginTransition(name,withchildren=true,transsrc=null,options=%[]){
    if(transsrc===null)throw new Exception("Transition source is required");
    __host("Transition.begin",__id,string(name),int(withchildren),transsrc.__id,options.time,options.vague,options.rule,options.from,options.stay,int(options.selfupdate),options.callback);
  }
  function stopTransition(){__host("Transition.stop",__id);}
  function onClick(x,y) {
    if(typeof __layerWindow.action!="undefined")__layerWindow.action(%[type:"onClick",target:this,x:x,y:y]);
  }
  function onPaint() {}
  function onHitTest(x,y,hit){__inputAction("onHitTest",%[x:x,y:y,hit:hit]);__host("Input.hitChoice",__id,int(hit));}
  function focus(direction=true){__host("Input.focus",__id,int(direction));}
  function focusNext(){return __host("Input.moveFocus",1);}
  function focusPrev(){return __host("Input.moveFocus",0);}
  function setMode(){__host("Input.mode",__id,1);}
  function removeMode(){__host("Input.mode",__id,0);}
  function releaseCapture(){__host("Input.release",__id);}
  function releaseTouchCapture(id){__host("Input.release",__id,int(id));}
  function __inputAction(type,event){event.type=type;event.target=this;if(typeof __layerWindow.action!="undefined")__layerWindow.action(event);}
  ${[
    ['onMouseDown', 'x,y,button,shift'],
    ['onMouseUp', 'x,y,button,shift'],
    ['onMouseMove', 'x,y,shift'],
    ['onMouseEnter', ''],
    ['onMouseLeave', ''],
    ['onDoubleClick', 'x,y'],
    ['onMouseWheel', 'shift,delta,x,y'],
    ['onFocus', 'blurred,direction'],
    ['onBlur', 'focused'],
    ['onNodeEnabled', ''],
    ['onNodeDisabled', ''],
    ['onTouchDown', 'x,y,cx,cy,id'],
    ['onTouchMove', 'x,y,cx,cy,id'],
    ['onTouchUp', 'x,y,cx,cy,id'],
  ]
    .map(
      ([name, args]) =>
        `function ${name}(${args}){__inputAction("${name}",%[${
          args
            ? args
                .split(',')
                .map((arg) => arg + ':' + arg)
                .join(',')
            : ''
        }]);}`,
    )
    .join('\n')}
  function onBeforeFocus(layer,blurred,direction){__inputAction("onBeforeFocus",%[layer:layer,blurred:blurred,direction:direction]);__host("Input.choice",__id,layer===null?null:layer.__id);}
  function onSearchNextFocusable(layer){__inputAction("onSearchNextFocusable",%[layer:layer]);__host("Input.choice",__id,layer===null?null:layer.__id);}
  function onSearchPrevFocusable(layer){__inputAction("onSearchPrevFocusable",%[layer:layer]);__host("Input.choice",__id,layer===null?null:layer.__id);}
  function onKeyDown(key,shift,process=true){__inputAction("onKeyDown",%[key:key,shift:shift,process:process]);if(process)__host("Input.defaultKey",__id,"down",int(key),int(shift));}
  function onKeyUp(key,shift,process=true){__inputAction("onKeyUp",%[key:key,shift:shift,process:process]);if(process)__host("Input.defaultKey",__id,"up",int(key),int(shift));}
  function onKeyPress(key,process=true){__inputAction("onKeyPress",%[key:key,process:process]);if(process)__host("Input.defaultKey",__id,"text",string(key));}
  property nextFocusable {getter(){return __host("Input.search",__id,1);}}
  property prevFocusable {getter(){return __host("Input.search",__id,0);}}
  ${['focused', 'nodeFocusable', 'nodeEnabled'].map((name) => `property ${name}{getter(){return __host("Input.get",__id,"${name}");}}`).join('\n')}
  function onTransitionCompleted(dest,src) {__inputAction("onTransitionCompleted",%[dest:dest,src:src]);}
  function setSize(width,height) { __host("Layer.resize",__id,int(width),int(height)); }
  function setImageSize(width,height) { __host("Layer.resizeImage",__id,int(width),int(height)); }
  function setSizeToImageSize() { setSize(imageWidth,imageHeight); }
  function setPos(left,top,width=void,height=void) { this.left=left;this.top=top;if(width!==void&&height!==void)setSize(width,height); }
  function setImagePos(left,top) { __host("Layer.imagePos",__id,int(left),int(top)); }
  function setClip(left,top,width,height) { __host("Layer.clip",__id,int(left),int(top),int(width),int(height)); }
  function fillRect(x,y,width,height,color) { __host("Layer.fill",__id,int(x),int(y),int(width),int(height),int(color)); }
  function colorRect(x,y,width,height,color,opacity=255) { __host("Layer.color",__id,int(x),int(y),int(width),int(height),int(color),int(opacity)); }
  function copyRect(x,y,source,left,top,width,height) { __host("Layer.copy",__id,int(x),int(y),source.__id,int(left),int(top),int(width),int(height)); }
  function operateRect(x,y,source,left,top,width,height,mode=omAuto,opacity=255) {__host("Layer.operate",__id,int(x),int(y),source.__id,int(left),int(top),int(width),int(height),int(mode),int(opacity),0);}
  function pileRect(x,y,source,left,top,width,height,opacity=255) {__host("Layer.operate",__id,int(x),int(y),source.__id,int(left),int(top),int(width),int(height),omAlpha,int(opacity),1);}
  function blendRect(x,y,source,left,top,width,height,opacity=255) {__host("Layer.operate",__id,int(x),int(y),source.__id,int(left),int(top),int(width),int(height),omOpaque,int(opacity),1);}
  function piledCopy(x,y,source,left,top,width,height) {__host("Layer.piledCopy",__id,int(x),int(y),source.__id,int(left),int(top),int(width),int(height));}
  function stretchCopy(x,y,width,height,source,left,top,sourceWidth,sourceHeight,type=stNearest,typeopt=void){
    __host("Layer.stretch",__id,int(x),int(y),int(width),int(height),source.__id,int(left),int(top),int(sourceWidth),int(sourceHeight),int(type),typeopt===void?-1:real(typeopt));
  }
  function operateStretch(x,y,width,height,source,left,top,sourceWidth,sourceHeight,mode=omAuto,opacity=255,type=stNearest,typeopt=void){
    __host("Layer.stretchOperate",__id,int(x),int(y),int(width),int(height),source.__id,int(left),int(top),int(sourceWidth),int(sourceHeight),int(type),typeopt===void?-1:real(typeopt),int(mode),int(opacity),0);
  }
  function stretchPile(x,y,width,height,source,left,top,sourceWidth,sourceHeight,opacity=255,type=stNearest){
    __host("Layer.stretchOperate",__id,int(x),int(y),int(width),int(height),source.__id,int(left),int(top),int(sourceWidth),int(sourceHeight),int(type),-1,omAlpha,int(opacity),1);
  }
  function stretchBlend(x,y,width,height,source,left,top,sourceWidth,sourceHeight,opacity=255,type=stNearest){
    __host("Layer.stretchOperate",__id,int(x),int(y),int(width),int(height),source.__id,int(left),int(top),int(sourceWidth),int(sourceHeight),int(type),-1,omOpaque,int(opacity),1);
  }
  function affineCopy(source,left,top,width,height,matrix,a,b,c,d,tx,ty,type=stNearest,clear=false){
    __host("Layer.affineCopy",__id,source.__id,int(left),int(top),int(width),int(height),int(!!matrix),real(a),real(b),real(c),real(d),real(tx),real(ty),int(type),0,255,int(clear),0);
  }
  function operateAffine(source,left,top,width,height,matrix,a,b,c,d,tx,ty,mode=omAuto,opacity=255,type=stNearest){
    __host("Layer.affine",__id,source.__id,int(left),int(top),int(width),int(height),int(!!matrix),real(a),real(b),real(c),real(d),real(tx),real(ty),int(type),int(mode),int(opacity),0,0);
  }
  function affinePile(source,left,top,width,height,matrix,a,b,c,d,tx,ty,opacity=255,type=stNearest){
    __host("Layer.affine",__id,source.__id,int(left),int(top),int(width),int(height),int(!!matrix),real(a),real(b),real(c),real(d),real(tx),real(ty),int(type),omAlpha,int(opacity),0,1);
  }
  function affineBlend(source,left,top,width,height,matrix,a,b,c,d,tx,ty,opacity=255,type=stNearest){
    __host("Layer.affine",__id,source.__id,int(left),int(top),int(width),int(height),int(!!matrix),real(a),real(b),real(c),real(d),real(tx),real(ty),int(type),omOpaque,int(opacity),0,1);
  }
  function saveLayerImage(name,type="bmp"){__host("Layer.saveImage",__id,string(name),string(type));}
  function assignImages(source) { __host("Layer.assignImages",__id,source.__id); (Dictionary.assign incontextof __font.__data)(source.__font.__data); }
  function loadImages(name,key=clNone) { return __host("Layer.image",__id,string(name),int(key)); }
  function loadProvinceImage(name) { __host("Layer.provinceImage",__id,string(name)); }
  function drawText(x,y,text,color=0xffffff,opa=255,aa=true,shadowlevel=0,shadowcolor=0,shadowwidth=0,shadowofsx=0,shadowofsy=0) {
    __host("Layer.text",__id,int(x),int(y),string(text),int(color),__font.__data,int(opa),int(aa),int(shadowlevel),int(shadowcolor),int(shadowwidth),int(shadowofsx),int(shadowofsy));
  }
  function adjustGamma(args*) {
    if(args.count==0)return;
    __host("Layer.gamma",__id,${[1, 0, 255, 1, 0, 255, 1, 0, 255].map((fallback, index) => `${index % 3 === 0 ? 'real' : 'int'}(args[${index}]===void?${fallback}:args[${index}])`).join(',')});
  }
  function bringToFront(){order=2147483647;}
  function bringToBack(){order=0;}
  function moveBefore(layer){__host("Layer.move",__id,layer.__id,1);}
  function moveBehind(layer){__host("Layer.move",__id,layer.__id,0);}
  function flipLR(){__host("Layer.flip",__id,1);}
  function flipUD(){__host("Layer.flip",__id,0);}
  function convertType(from){__host("Layer.convertType",__id,int(from));}
  function doGrayScale(){__host("Layer.grayscale",__id);}
  function doBoxBlur(xblur=1,yblur=1){__host("Layer.boxBlur",__id,int(xblur),int(yblur));}
  function update(type=utNormal){__host("Layer.update",__id);}
  function getLayerAt(x,y,excludeSelf=false,getDisabled=false) { return __host("Input.hit",__id,int(x),int(y),int(excludeSelf),int(getDisabled)); }
  ${['Main', 'Mask', 'Province']
    .map(
      (
        plane,
      ) => `function get${plane}Pixel(x,y){return __host("Layer.pixelGet",__id,int(x),int(y),"${plane.toLowerCase()}");}
  function set${plane}Pixel(x,y,value){__host("Layer.pixelSet",__id,int(x),int(y),"${plane.toLowerCase()}",int(value));}`,
    )
    .join('\n')}
  property window { getter(){return __layerWindow;} }
  property font { getter(){return __font;} }
  property parent {
    getter(){return __parent;}
    setter(value){
      if(value!==null&&value.__layerWindow!==__layerWindow)throw new Exception("Parent belongs to another window");
      __host("Layer.parentCheck",__id,value!==null?value.__id:0);
      if(__parent!==null)__parent.__children.remove(this);
      __parent=value;if(value!==null)value.__children.add(this);
      __host("Layer.parent",__id,value!==null?value.__id:0);
    }
  }
  property children {
    getter(){var ids=__host("Layer.children",__id),result=[];for(var i=0;i<ids.count;i++)result.add(__findLayer(ids[i]));return result;}
  }
  ${[
    'left',
    'top',
    'width',
    'height',
    'imageWidth',
    'imageHeight',
    'imageLeft',
    'imageTop',
    'visible',
    'opacity',
    'type',
    'face',
    'holdAlpha',
    'hasImage',
    'imageModified',
    'enabled',
    'focusable',
    'joinFocusChain',
    'hitType',
    'hitThreshold',
    'cursor',
    'name',
    'hint',
    'showParentHint',
    'cached',
    'callOnPaint',
    'absoluteOrderMode',
    'absolute',
    'order',
    'clipLeft',
    'clipTop',
    'clipWidth',
    'clipHeight',
    'attentionLeft',
    'attentionTop',
    'useAttention',
    'imeMode',
  ]
    .map(
      (name) => `property ${name} {
    getter(){return __host("Layer.get",__id,"${name}");}
    setter(value){__host("Layer.set",__id,"${name}",${name === 'name' || name === 'hint' ? 'string' : 'int'}(value));}
  }`,
    )
    .join('\n')}
  ${['isPrimary', 'nodeVisible', 'neutralColor', 'cursorX', 'cursorY'].map((name) => `property ${name} {getter(){return __host("Layer.get",__id,"${name}");}}`).join('\n')}
}
`

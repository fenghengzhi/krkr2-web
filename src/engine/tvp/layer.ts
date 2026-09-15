export const layerClass = String.raw`
function __krkrLayerInvalidate(owner,id,state) {
  try {
    __host("Layer.stopTransitions",id);
    __host("Layer.detach",id);
    if(state.font!==null)invalidate state.font;
    state.font=null;
    __host("Layer.releaseImage",id);
    state.actionOwner=null;
    state.cache=null;
    state.clear=null;
  } catch(error) {
    __host("Layer.abort",id);
    throw error;
  }
  __host("Layer.finish",id);
}
__host("Layer.bindLifetime",__krkrLayerInvalidate);
class Layer {
  var __id;
  function Layer(window,parent) {
    var state=%[actionOwner:window,font:null,cache:null,clear:null,cacheRevision:-1,
      fontData:%[height:18,face:"sans-serif",bold:false,italic:false,underline:false,strikeout:false,angle:0,faceIsFileName:false]];
    __id=__host("Layer.create",this,window,parent,state);
  }
  function finalize() {}
  function __syncTree() {}
  property __fontData {getter(){return __host("Layer.state",__id).fontData;}}
  function __transitionTick(token){var clock=__host("Transition.callback",token);if(clock!==void)__host("Transition.tick",token,clock());}
  function beginTransition(name,withchildren=true,transsrc=null,options=%[]){
    if(transsrc===null)throw new Exception("Transition source is required");
    __host("Transition.begin",__host("Layer.identity",this),string(name),int(withchildren),__host("Layer.identity",transsrc),options.time,options.vague,options.rule,options.from,options.stay,int(options.selfupdate),options.callback,%[destination:this,source:transsrc,callback:options.callback]);
  }
  function stopTransition(){__host("Transition.stop",__id);}
  function onClick(x,y) {
    return __inputAction("onClick",%[x:x,y:y]);
  }
  function onPaint() { __inputAction("onPaint",%[]); }
  function onHitTest(x,y,hit){__inputAction("onHitTest",%[x:x,y:y,hit:hit]);__host("Input.hitChoice",__id,int(hit));}
  function focus(direction=true){__host("Input.focus",__id,int(direction));}
  function focusNext(){return __host("Input.moveFocus",1,__id);}
  function focusPrev(){return __host("Input.moveFocus",0,__id);}
  function setMode(){__host("Input.mode",__id,1);}
  function removeMode(){__host("Input.mode",__id,0);}
  function releaseCapture(){__host("Input.release",__id);}
  function releaseTouchCapture(id){__host("Input.release",__id,int(id));}
  function __inputAction(type,event){event.type=type;event.target=this;return __host("Layer.action",__host("Layer.state",__id).actionOwner,event);}
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
  function setClip(args*) {
    if(args.count==0)__host("Layer.clip",__id);
    else {
      if(args.count<4)throw new global.Exception("Layer.setClip requires zero or at least four arguments");
      __host("Layer.clip",__id,int(args[0]),int(args[1]),int(args[2]),int(args[3]));
    }
  }
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
  function assignImages(source) { __host("Layer.assignImages",__id,source.__id); }
  function loadImages(name,key=clNone) { return __host("Layer.image",__id,string(name),int(key)); }
  function loadProvinceImage(name) { __host("Layer.provinceImage",__id,string(name)); }
  function drawText(args*) {
    if(args.count<4)throw new global.Exception("Layer.drawText requires at least four arguments");
    __host("Layer.text",__id,int(args[0]),int(args[1]),string(args[2]),int(args[3]),__fontData,
      int(args[4]===void?255:args[4]),int(!!(args[5]===void?true:args[5])),
      ${[6, 7, 8, 9, 10].map((index) => `int(args[${index}]===void?0:args[${index}])`).join(',')});
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
  function update(args*){
    if(args.count==0)__host("Layer.update",__id);
    else{
      if(args.count<4)throw new global.Exception("Layer.update requires zero or at least four arguments");
      __host("Layer.update",__id,int(args[0]),int(args[1]),int(args[2]),int(args[3]));
    }
  }
  function getLayerAt(x,y,excludeSelf=false,getDisabled=false) { return __host("Input.hit",__id,int(x),int(y),int(excludeSelf),int(getDisabled)); }
  ${['Main', 'Mask', 'Province']
    .map(
      (
        plane,
      ) => `function get${plane}Pixel(x,y){return __host("Layer.pixelGet",__id,int(x),int(y),"${plane.toLowerCase()}");}
  function set${plane}Pixel(x,y,value){__host("Layer.pixelSet",__id,int(x),int(y),"${plane.toLowerCase()}",int(value));}`,
    )
    .join('\n')}
  property window { getter(){return __host("Layer.relation",__id,"window");} }
  property font { getter(){
    var state=__host("Layer.state",__id);
    if(state.font===null)state.font=new Font(this);
    return state.font;
  } }
  property parent {
    getter(){return __host("Layer.relation",__id,"parent");}
    setter(value){__host("Layer.parent",__id,value);}
  }
  property children { getter(){
    var state=__host("Layer.state",__id);
    if(state.cache===null){state.cache=[];state.clear=Array.clear incontextof null;}
    var revision=__host("Layer.childrenRevision",__id);
    if(state.cacheRevision!==revision){
      (state.clear incontextof state.cache)();
      if(isvalid state.cache){
        var items=__host("Layer.children",__id);
        for(var i=0;i<items.count;i++)state.cache[i]=items[i];
      }
      state.cacheRevision=__host("Layer.childrenRevision",__id);
    }
    return state.cache;
  } }
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
    'neutralColor',
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
  ${['isPrimary', 'nodeVisible', 'cursorX', 'cursorY'].map((name) => `property ${name} {getter(){return __host("Layer.get",__id,"${name}");}}`).join('\n')}
}
`

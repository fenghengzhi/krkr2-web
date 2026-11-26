// Hand-computed triangle and quadratic-bell outputs. The SDK runs the same
// Layer calls and reports RGB and mask bytes independently of the Web filter.
const gray = (values: number[]) => values.map((v) => [v, 255 - v, 37, v].join(',')).join('|')
export const thumbnailStretchCases = [
  { id: 'linear-up', expected: gray([0,40,80,120,160,200,240,240]) },
  { id: 'linear-down', expected: gray([40,160]) },
  { id: 'cubic-up', expected: gray([20,40,80,120,160,200,230,240]) },
  { id: 'cubic-down', expected: gray([60,155]) },
  { id: 'cubic-unit-x', expected: gray([20,80,160,230,20,80,160,230]) },
  { id: 'cubic-identity', expected: gray([0,80,160,240]) },
  { id: 'crop-offset', expected: gray([0,40,80,120,160,200,240,240]) },
  { id: 'opaque-operation', expected: gray([40,160]) },
  { id: 'in-place', expected: gray([0,0,0,0,0,32]) },
  { id: 'round-horizontal-first', expected: '1,1,37,1' },
  { id: 'stretch-error-order', expected: 'empty,empty,face:stretchCopy,face:stretchPile,face:stretchBlend,source' },
] as const

export const thumbnailStretchSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var thumbWindow=new Window(),thumbRoot=new Layer(thumbWindow,null);
var thumbSrc=new Layer(thumbWindow,thumbRoot),thumbDest=new Layer(thumbWindow,thumbRoot);
thumbWindow.add(thumbRoot);thumbWindow.add(thumbSrc);thumbWindow.add(thumbDest);
function thumbRead(layer,x,y){
 var rgb=layer.getMainPixel(x,y);
 return [(rgb>>16)&255,(rgb>>8)&255,rgb&255,layer.getMaskPixel(x,y)].join(",");
}
function thumbError(method){
 try{method();return "empty";}catch(e){return e.message;}
}
function thumbErrorOrder(){
 System.assignMessage("TVPNotDrawableFaceType","face:%1");
 System.assignMessage("TVPSourceLayerHasNoImage","source");
 thumbDest.face=dfMask;thumbDest.setClip(0,0,0,0);thumbSrc.hasImage=false;
 var results=[];
 results.add(thumbError(function(){thumbDest.stretchCopy(0,0,4,4,thumbSrc,0,0,2,2);}));
 results.add(thumbError(function(){thumbDest.operateStretch(0,0,4,4,thumbSrc,0,0,2,2,omOpaque);}));
 thumbDest.setClip();
 results.add(thumbError(function(){thumbDest.stretchCopy(0,0,4,4,thumbSrc,0,0,2,2);}));
 thumbDest.setClip(0,0,0,0);
 results.add(thumbError(function(){thumbDest.stretchPile(0,0,4,4,thumbSrc,0,0,2,2);}));
 results.add(thumbError(function(){thumbDest.stretchBlend(0,0,4,4,thumbSrc,0,0,2,2);}));
 thumbDest.face=dfAlpha;thumbDest.setClip();
 results.add(thumbError(function(){thumbDest.stretchCopy(0,0,4,4,thumbSrc,0,0,2,2);}));
 return results.join(",");
}
function thumbnailStretchRun(id){
 if(id=="stretch-error-order")return thumbErrorOrder();
 var stage=id=="round-horizontal-first",crop=id=="crop-offset",self=id=="in-place";
 var values=crop?[211,0,80,160,240,93]:self?[0,80,160,240,16,32]:stage?[0,1,0,0]:[0,80,160,240];
 var sw=stage?2:values.count,sh=stage?2:1;
 thumbSrc.setImageSize(sw,sh);thumbSrc.face=dfAlpha;
 for(var i=0;i<values.count;i++){
  var v=values[i],x=i%sw,y=i\sw;
  thumbSrc.setMainPixel(x,y,(v<<16)|((stage?v:255-v)<<8)|37);
  thumbSrc.setMaskPixel(x,y,v);
 }
 var w=stage || self || id=="cubic-unit-x" || id=="cubic-identity"?4:
  id=="linear-down" || id=="cubic-down" || id=="opaque-operation"?2:8;
 var h=stage?4:id=="cubic-unit-x"?2:1,dx=crop?2:self?1:0,dy=crop?1:0;
 var layer=self?thumbSrc:thumbDest;
 if(!self){thumbDest.setImageSize(w+dx,h+dy);thumbDest.setClip();thumbDest.face=dfAlpha;}
 var type=id.indexOf("cubic")==0?stCubic:stLinear;
 if(crop)type|=0x10000;
 if(id=="opaque-operation"){
  thumbDest.face=dfOpaque;thumbDest.holdAlpha=false;
  thumbDest.operateStretch(0,0,w,h,thumbSrc,0,0,4,1,omOpaque,255,type);
 }else layer.stretchCopy(dx,dy,w,h,thumbSrc,crop?1:0,0,self || stage?2:4,sh,type);
 if(stage)return thumbRead(layer,1,1);
 var rows=[];
 if(self){dx=0;w=6;}
 for(var yy=0;yy<h;yy++)for(var xx=0;xx<w;xx++)rows.add(thumbRead(layer,dx+xx,dy+yy));
 return rows.join("|");
}
function thumbnailStretchClose(){invalidate thumbWindow;}
`

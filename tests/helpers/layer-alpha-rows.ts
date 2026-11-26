// R and stored mask, in scanline order. 2.32's short full-opacity tail copies
// opaque pixels exactly. A mixed pair interpolates every byte by alpha / 256.
const mixed = '191/255,0/255,192/255,192/255,192/255'
const odd = '192/255,0/255,192/255,192/255,192/255'
const partial = '62/223,62/223,62/223,62/223,62/223,62/223,63/223,63/223'
export const layerAlphaRows = [
  { id: 'alpha-row-opaque', expected: '192/255' },
  { id: 'alpha-row-binder', expected: '31/231' },
  { id: 'alpha-row-paired', expected: mixed },
  { id: 'alpha-row-offset', expected: odd },
  { id: 'alpha-row-crop-after-full', expected: '191/255|192/255|191/255' },
  { id: 'alpha-row-opacity', expected: partial },
  { id: 'alpha-row-opacity-offset', expected: '63/223,62/223,62/223,62/223,62/223,62/223,62/223,63/223' },
  { id: 'alpha-row-cached-crop', expected: '63/223,62/223,62/223,62/223,62/223,62/223,62/223,63/223' },
  { id: 'alpha-row-pile', expected: mixed },
  { id: 'alpha-row-operate', expected: partial },
  { id: 'alpha-row-unit-stretch', expected: mixed },
] as const

export const layerAlphaSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var rowWin=new Window(),rowRoot=new Layer(rowWin,null);
rowWin.add(rowRoot);rowRoot.setSize(16,1);rowRoot.setImageSize(16,1);
var rowDest=new Layer(rowWin,rowRoot);rowWin.add(rowDest);rowDest.setImageSize(16,1);
function firstRowPixel(){return ((rowDest.getMainPixel(0,0)>>16)&255)+"/"+rowDest.getMaskPixel(0,0);}
function layerAlphaRun(id){
 var binder=id=="alpha-row-binder",single=binder || id=="alpha-row-opaque";
 var cached=id=="alpha-row-cached-crop";
 var faded=cached || id=="alpha-row-opacity" || id=="alpha-row-opacity-offset" || id=="alpha-row-operate";
 var width=single?1:faded?8:5,x=cached || id=="alpha-row-offset" || id=="alpha-row-opacity-offset"?1:0;
 var holder=binder || cached?new Layer(rowWin,rowRoot):rowRoot;
 if(binder){holder.type=ltBinder;holder.setSize(16,1);holder.visible=true;holder.opacity=128;}
 if(cached){
  holder.type=ltOpaque;holder.setSize(16,1);holder.face=dfAlpha;
  holder.fillRect(0,0,16,1,0xff000000);holder.cached=true;holder.visible=true;
 }
 var tile=new Layer(rowWin,holder),result,failure;
 try{
  tile.setSize(width,1);tile.setImageSize(width,1);tile.left=x;tile.type=ltAlpha;tile.face=dfAlpha;
  var value=binder?0x40ff0000:faded?0x7fff0000:0xffc00000;
  tile.fillRect(0,0,width,1,value);
  if(!single && !faded)tile.setMaskPixel(1,0,0);
  tile.opacity=binder?128:faded?129:255;
  rowRoot.face=dfAlpha;rowRoot.fillRect(0,0,16,1,0xff000000);
  rowDest.face=dfAlpha;rowDest.fillRect(0,0,16,1,0xff000000);
  var direct=id=="alpha-row-pile" || id=="alpha-row-operate" || id=="alpha-row-unit-stretch";
  if(direct){
   rowDest.face=dfOpaque;rowDest.holdAlpha=false;
   if(id=="alpha-row-pile")rowDest.pileRect(x,0,tile,0,0,width,1,255);
   else if(id=="alpha-row-operate")rowDest.operateRect(x,0,tile,0,0,width,1,omAlpha,129);
   else rowDest.operateStretch(x,0,width,1,tile,0,0,width,1,omAlpha,255,stCubic);
  }else{
   tile.visible=true;
   if(cached)rowDest.piledCopy(x,0,rowRoot,x,0,width,1);
   else rowDest.piledCopy(0,0,rowRoot,0,0,16,1);
  }
  var values=[];for(var i=x;i<x+width;i++)values.add(((rowDest.getMainPixel(i,0)>>16)&255)+"/"+rowDest.getMaskPixel(i,0));
  result=values.join(",");
  if(id=="alpha-row-crop-after-full"){
   result=firstRowPixel();rowDest.piledCopy(0,0,rowRoot,0,0,1,1);
   result+="|"+firstRowPixel();rowDest.piledCopy(0,0,rowRoot,0,0,5,1);
   result+="|"+firstRowPixel();
  }
 }catch(e){failure=e;}
 invalidate tile;if(binder || cached)invalidate holder;
 if(failure!==void)throw failure;return result;
}
function layerAlphaClose(){invalidate rowWin;}
`

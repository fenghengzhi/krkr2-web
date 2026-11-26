/** One authored game script shared by stock Windows and the Web runtimes.
 * No expected value depends on reading the application's argument map. */
export const startupScriptModesSource = String.raw`
var startupRouteName="global",startupRouteHit=0;
class StartupOperatorChoice {
 var startupRouteName="instance",startupRouteHit=0;
 property option { getter(){return 7;} }
 function observe(){
  global.startupRouteHit=0;this.startupRouteHit=0;
  var scope="this.startupRouteName"!;
  "this.startupRouteHit=1"!;
  var amp=false,star=false;
  try{amp=(&this.option) instanceof "Property";}catch(e){}
  try{star=(*this.option) instanceof "Property";}catch(e){}
  return scope+":"+this.startupRouteHit+":"+global.startupRouteHit+"|"+
    (amp && !star?"amp":star && !amp?"star":"unexpected");
 }
}
function startupScriptModes(){
 var choice=new StartupOperatorChoice(),result=choice.observe(),w=new Window(),failed=false,primary;
 try{
  var l=new Layer(w,null);l.face=dfOpaque;l.setMaskPixel(0,0,73);l.fillRect(0,0,1,1,0xff445566);
  result+="|"+int(l.holdAlpha)+"|"+l.getMaskPixel(0,0);
 }catch(e){failed=true;primary=e;}
 try{invalidate w;}catch(cleanup){if(!failed)throw cleanup;}
 if(failed)throw primary;
 return result;
}
`

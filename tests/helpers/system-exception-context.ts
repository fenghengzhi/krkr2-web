/** Real event callbacks exercise ScriptMgnIntf's closure.FuncCall(..., NULL)
 * contract. Expected strings are literal receiver/scope observations, not a
 * model of the implementation. Both source and compileStorage use this code. */
export const systemExceptionContextSource = String.raw`
System.exitOnWindowClose=false;
var contextCaught=0,contextReads=0,contextArmed=false,contextTrace=[];
var ownMarker="global-marker";
var contextHandler=function(error){
 contextCaught++;
 contextTrace.add([error,ownMarker,int(this==global.contextHandler),
  int(this===global.contextHandler),int(this===(global.contextHandler incontextof global.contextHandler)),
  int(this===global.contextReceiver)].join("|"));
 return true;
};
contextHandler.ownMarker="function-marker";
class ContextReceiver {
 var count=0,ownMarker="receiver-marker";
 function handle(error){
  count++;contextCaught++;
  contextTrace.add([error,ownMarker,int(this==global.contextHandler),
   int(this===global.contextHandler),int(this===(global.contextHandler incontextof global.contextHandler)),
   int(this===global.contextReceiver)].join("|"));
  return true;
 }
}
var contextReceiver=new ContextReceiver(),contextSelected=contextHandler;
property contextSelectedHandler {getter(){contextReads++;return contextSelected;}}
System.exceptionHandler=&contextSelectedHandler;
function armExceptionContext(bound){
 contextSelected=bound ? contextReceiver.handle : contextHandler;
 contextArmed=true;return 1;
}
function exceptionContextSnapshot(){
 return [contextCaught,contextReads,contextReceiver.count,
  typeof System.__applicationEvent,typeof System.__invokeExceptionHandler].join("|")+"|"+contextTrace.join(";");
}
var contextWindow=new Window();contextWindow.caption="Exception context";
contextWindow.setInnerSize(96,64);contextWindow.visible=true;
var contextLayer=new Layer(contextWindow,null);contextWindow.add(contextLayer);
contextLayer.setSize(96,64);contextLayer.fillRect(0,0,96,64,0xff234567);
contextLayer.onMouseDown=function(x,y,button,shift){
 if(contextArmed){contextArmed=false;throw 37;}
};
`

// === compares both Object and ObjThis in TJS. The unbound closure itself is
// therefore not strictly equal to its function object bound to itself; == is.
export const exceptionContextInitial = '0|0|0|undefined|undefined|'
export const exceptionContextAnonymous = '1|1|0|undefined|undefined|37|function-marker|1|0|1|0'
export const exceptionContextBound = '2|2|1|undefined|undefined|37|function-marker|1|0|1|0;37|receiver-marker|0|0|0|1'
export const exceptionContextRecovered = '3|3|1|undefined|undefined|37|function-marker|1|0|1|0;37|receiver-marker|0|0|0|1;37|function-marker|1|0|1|0'

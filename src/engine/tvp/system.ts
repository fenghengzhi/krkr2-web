/** Keep nested callback execution inside TJS; queue and registry live in TypeScript. */
export const systemEventsBridge = String.raw`
function __krkrMakeImmediateError(invoke){
 return function(error){
  var describe=function(value){
   try{
    if(typeof value=="Object" && value!==null && value.message!==void)return string(value.message);
    return string(value);
   }catch(ignored){return "Unprintable exception";}
  };
  var handled=false,message=describe(error);
  try{
   var handler=global.System.exceptionHandler;
   if(typeof handler=="Object" && handler!==null)handled=!!this.invoke(handler,error);
  }catch(handlerError){message+="; exception handler: "+describe(handlerError);handled=false;}
  global.__host("System.eventError",message,int(handled));
 } incontextof %[invoke:invoke];
}
// Bootstrap-only capability, captured by Video's private continuations and
// deleted before a game script can run. No new System public method.
global.__krkrImmediateError=__krkrMakeImmediateError(System.__invokeExceptionHandler);
delete global.__krkrMakeImmediateError;
function __krkrMakeSystemEventPump(application,report){
 var context=%[application:application,report:report];
 return function(token,activation=void){
  if(activation!==void){
   if(!activation)global.__host("System.applicationCompact");
   this.application(activation);return;
  }
  try{
    while(true){
      var available=global.__host("System.eventNext",token);
      // Next can settle several invalid jobs before returning a live current,
      // or zero. Retire those receipts before entering another callback.
      global.__host("Session.eventCheckpoint",token,0);
      if(!available)break;
      var failed=false;
      try{
        if(global.__host("System.eventCall",token)<0)global.__host("System.eventInvalid",token);
        else global.__host("System.eventDone",token);
      }
      catch(error){
        global.__host("System.eventFailed",token);
        this.report(error);
        failed=true;
      }
      // A failed callback is not finished until its exception handler returns.
      // This checkpoint releases resources; it never performs window updates.
      global.__host("Session.eventCheckpoint",token,1);
      if(failed)break;
    }
    // Even an explicitly skipped update phase completes an ordinary receipt's
    // tail obligation. A video frame still requires its own successful present.
    global.__host("Session.windowUpdateCheckpoint",token,global.__host("System.eventWindowUpdate",token));
  }catch(error){
    var abortedMessage="System event round aborted";
    try{abortedMessage=typeof error=="Object" && error!==null && error.message!==void ? string(error.message) : string(error);}catch(ignored){}
    global.__host("Session.abortRoundReceipts",token,abortedMessage);
    global.__host("System.eventEnd",token);throw error;
  }
  global.__host("System.eventEnd",token);
 } incontextof context;
}
global.__host("System.bindEvents",__krkrMakeSystemEventPump(System.__applicationEvent,global.__krkrImmediateError));
delete System.__applicationEvent;
delete System.__invokeExceptionHandler;
delete global.__krkrMakeSystemEventPump;
`

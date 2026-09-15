/** Keep nested callback execution inside TJS; queue and registry live in TypeScript. */
export const systemEventsBridge = String.raw`
function __krkrSystemEventPump(token){
  try{
    while(true){
      var available=__host("System.eventNext",token);
      // Next can settle several invalid jobs before returning a live current,
      // or zero. Retire those receipts before entering another callback.
      __host("Session.eventCheckpoint",token,0);
      if(!available)break;
      var failed=false;
      try{
        if(__host("System.eventCall",token)<0)__host("System.eventInvalid",token);
        else __host("System.eventDone",token);
      }
      catch(error){
        __host("System.eventFailed",token);
        var describe=function(value){
          try{
            if(typeof value=="Object" && value!==null && value.message!==void)return string(value.message);
            return string(value);
          }catch(ignored){return "Unprintable exception";}
        };
        var handled=false,message=describe(error);
        try{
          // Read the closure first, as the native exception dispatcher does.
          // Calling the member directly supplies System as objthis.
          var handler=System.exceptionHandler;
          if(typeof handler=="Object" && handler!==null)handled=!!handler(error);
        }
        catch(handlerError){message+="; exception handler: "+describe(handlerError);handled=false;}
        __host("System.eventError",message,int(handled));
        failed=true;
      }
      // A failed callback is not finished until its exception handler returns.
      // This checkpoint releases resources; it never performs window updates.
      __host("Session.eventCheckpoint",token,1);
      if(failed)break;
    }
    // Even an explicitly skipped update phase completes an ordinary receipt's
    // tail obligation. A video frame still requires its own successful present.
    __host("Session.windowUpdateCheckpoint",token,__host("System.eventWindowUpdate",token));
  }catch(error){
    var abortedMessage="System event round aborted";
    try{abortedMessage=typeof error=="Object" && error!==null && error.message!==void ? string(error.message) : string(error);}catch(ignored){}
    __host("Session.abortRoundReceipts",token,abortedMessage);
    __host("System.eventEnd",token);throw error;
  }
  __host("System.eventEnd",token);
}
__host("System.bindEvents",__krkrSystemEventPump);
delete global.__krkrSystemEventPump;
`

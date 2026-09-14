/** Keep nested callback execution inside TJS; queue and registry live in TypeScript. */
export const systemEventsBridge = String.raw`
function __krkrSystemEventPump(token){
  try{
    while(__host("System.eventNext",token)){
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
          // Calling the dictionary member directly supplies System as objthis.
          var handler=System.exceptionHandler;
          if(typeof handler=="Object" && handler!==null)handled=!!handler(error);
        }
        catch(handlerError){message+="; exception handler: "+describe(handlerError);handled=false;}
        __host("System.eventError",message,int(handled));
        break;
      }
    }
  }catch(error){__host("System.eventEnd",token);throw error;}
  __host("System.eventEnd",token);
}
__host("System.bindEvents",__krkrSystemEventPump);
delete global.__krkrSystemEventPump;
property __systemEventDisabled {
  getter(){return __host("System.eventDisabled");}
  setter(value){__host("System.eventDisabled",int(!!value));}
}
System.eventDisabled=&__systemEventDisabled;
delete global.__systemEventDisabled;
`

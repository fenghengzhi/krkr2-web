export const debugBridge = String.raw`
var Debug=%[
  message:function(args*) {
    if(args.count<1)throw new Exception("Debug.message requires a message");
    if(args.count>4096)throw new Exception("Too many Debug arguments");
    for(var i=0;i<args.count;i++)args[i]=string(args[i]);
    __host("Debug.message",args.join(", "));
  },
  notice:function(args*) {
    if(args.count<1)throw new Exception("Debug.notice requires a message");
    if(args.count>4096)throw new Exception("Too many Debug arguments");
    for(var i=0;i<args.count;i++)args[i]=string(args[i]);
    __host("Debug.notice",args.join(", "));
  },
  startLogToFile:function(clear=false){__host("Debug.start",int(!!clear));},
  logAsError:function(){__host("Debug.error");},
  getLastLog:function(args*){return __host("Debug.last",int(args.count?args[0]:2148)&0xffffffff);},
  addLoggingHandler:function(args*){
    if(args.count<1)throw new Exception("Missing logging handler");
    __host("Debug.add",args[0]);
  },
  removeLoggingHandler:function(args*){
    if(args.count<1)throw new Exception("Missing logging handler");
    __host("Debug.remove",args[0]);
  }
];
function __krkrDebugPump(token){
  try {
    while(__host("Debug.next",token)) {
      try { if(__host("Debug.call",token)<0)__host("Debug.failed",token); }
      catch(error){__host("Debug.failed",token);throw error;}
    }
  } catch(error){__host("Debug.end",token,0);throw error;}
  __host("Debug.end",token,1);
}
__host("Debug.bind",__krkrDebugPump);
delete global.__krkrDebugPump;
property __debugLocation {
  getter(){return __host("Debug.location");}
  setter(value){__host("Debug.location",string(value));}
}
property __debugAuto {
  getter(){return __host("Debug.auto");}
  setter(value){__host("Debug.auto",int(!!value));}
}
property __debugClear {
  getter(){return __host("Debug.clear");}
  setter(value){__host("Debug.clear",int(!!value));}
}
Debug.logLocation=&__debugLocation;
Debug.logToFileOnError=&__debugAuto;
Debug.clearLogFileOnError=&__debugClear;
delete global.__debugLocation;
delete global.__debugAuto;
delete global.__debugClear;
class __krkrDebugAccess {
  var consoleObject=__host("Debug.panel",0),controllerObject=__host("Debug.panel",1);
  property console{getter(){return consoleObject;}}
  property controller{getter(){return controllerObject;}}
}
var __krkrDebugAccessInstance=new __krkrDebugAccess();
Debug.console=&__krkrDebugAccessInstance.console;
Debug.controller=&__krkrDebugAccessInstance.controller;
delete global.__krkrDebugAccessInstance;
delete global.__krkrDebugAccess;
`

export const scriptsFixture = {
  'startup.tjs': String.raw`
function demand(value,message){if(!value)throw new Exception(message);}
demand(Scripts instanceof "Class" && Scripts instanceof "Scripts", "native Scripts class");
demand(Scripts.exec instanceof "Function" && Scripts.compileStorage instanceof "Function", "native methods");
var rejected=false;try{new Scripts();}catch(e){rejected=true;}demand(rejected,"no Scripts instances");
demand(Scripts.eval(42)===42,"source coercion");
var scope=%[value:6];Scripts.exec("value=9;",void,"8",scope);
demand(Scripts.eval("value+1","context.tjs",0,scope)===10,"context and integer conversion");
rejected=false;try{Scripts.exec("global.leaked=1;",void,0,42);}catch(e){rejected=true;}
demand(rejected && typeof global.leaked=="undefined","invalid context must not execute");
var methods=[Scripts.exec,Scripts.eval,Scripts.execStorage,Scripts.evalStorage,Scripts.compileStorage,Scripts.setCallMissing,Scripts.getClassNames];
for(var index=0;index<methods.count;index++){
  rejected=false;try{methods[index]();}catch(e){rejected=true;}demand(rejected,"required arguments");
}
class Base {} class Derived extends Base {}
demand(Scripts.getClassNames(new Derived()).join(",")=="Derived,Base","native class name order");
demand(Scripts.getClassNames(Scripts).count===0,"native class metadata is not fabricated");
var missingWrites="";
var object=%[missing:function(setting,name,value){if(setting)missingWrites=name+":"+string(*value);else *value="missing:"+name;return true;}];
Scripts.setCallMissing(object);demand(object.absent=="missing:absent","missing getter");
object.dynamic=21;demand(missingWrites=="dynamic:21","missing setter");Scripts.setCallMissing(null);
demand(Scripts.evalStorage("folder/value.tjs",void,scope)===18,"storage context");
var cleanTrace=Scripts.eval("Scripts.getTraceString()","nested.tjs",7);
demand(cleanTrace.indexOf("nested.tjs(8)[")==0 && cleanTrace.indexOf("krkr2-web/bootstrap.tjs")<0,"native Scripts trace");
Scripts.compileStorage("expression.tjs","savedata/native.cjs",true,true,true);
demand(Scripts.evalStorage("savedata/native.cjs")===42,"compile and immediate bytecode read");
Debug.message("native-scripts-ready");
`,
  'folder/value.tjs': 'value*2',
  'expression.tjs': '6*7',
}

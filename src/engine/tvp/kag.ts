// The engine owns parse positions and control flow. TJS owns live dictionaries
// and runs callbacks with the actual subclass instance as context. Native KAG
// expression entities, conditions and embeddings use the global TJS context.
export const kagClass = String.raw`
class KAGParser {
  var __kagId, __kagMacros, __kagParams, __kagParamNames, __kagParamDepth=0, __kagTag, __kagTagList;
  function KAGParser() {
    __kagId = __host("KAG.create");
    __kagMacros = %[]; __kagParams = []; __kagParamNames = []; __kagTag = %[]; __kagTagList = [];
  }
  function finalize() { __host("KAG.destroy", __kagId); }
  function __kagResolveTag(value, references, bindings=void) {
    if(references===void || !references.count || bindings===void)return value;
    for(var i=0;i<bindings.count;i++){
      var binding=bindings[i],index=binding[1];
      if(index<0 || index>=references.count)throw new Exception("Invalid KAG parameter reference");
      value[binding[0]]=references[index];
    }
    return value;
  }
  function __kagEncodeParams(references) {
    if(!__kagParamDepth)return null;
    var fields=[],values=%[],bindings=[];fields.assign(__kagParams[__kagParamDepth-1]);
    for(var i=0;i<fields.count;i+=2){
      var value=fields[i+1],kind=typeof value;
      // Keep native Real variants as well: the host's parser-state numbers
      // represent integers, which must not erase a real's type or signed zero.
      if(kind=="Object" || kind=="Octet" || kind=="Real"){
        if(references.count>=100000)throw new Exception("KAG parameter reference budget exceeded");
        values[fields[i]]=void;bindings.add([fields[i],references.count]);references.add(value);
      }else values[fields[i]]=value;
    }
    return %[values:values,names:__kagParamNames[__kagParamDepth-1],references:bindings];
  }
  function __kagShape(values) {
    var result=%[],fields=[];fields.assign(values);
    for(var i=0;i<fields.count;i+=2)result[fields[i]]=void;
    return result;
  }
  function __kagRun(method, argument=void, restoring=void) {
    // These are ordinary VM-owned variants scoped to this invocation. Nested
    // parser calls have separate tables; no reference becomes a host handle.
    var references=void,savedParams=void,savedFrames=void;
    var operation = __host("KAG.begin", __kagId, method, argument);
    while(!operation.done) {
      var token = operation.token, a = operation.args, result = void;
      try {
        switch(operation.kind) {
          case "clearTag":
            (Dictionary.clear incontextof __kagTag)();__kagTagList.clear();break;
          case "callback":
            if(a[0] == "onJump" || a[0] == "onCall" || a[0] == "onReturn") {
              var packet=a[1][0];a[1][0]=__kagAcceptTag(__kagResolveTag(packet.value,references,packet.references));
            }
            else if(a[0] == "onLabel" || a[0] == "onScript") { (Dictionary.clear incontextof __kagTag)(); __kagTagList.clear(); }
            result = this[a[0]](a[1]*);
            if(a[0] == "onJump" || a[0] == "onCall" || a[0] == "onReturn") result = !!result;
            else if(a[0] != "onScenarioLoad" || typeof result != "String") result = void;
            break;
          case "eval":
            result = Scripts.eval(a[0], a[2], a[3], global);
            if(a[1]) result = !!result;
            else if(result !== void) result = string(result);
            break;
          case "string": result=string(references[a[0]]);break;
          case "getMacro": result = __kagMacros[a[0]]; if(result !== void) result = string(result); break;
          case "boolean": result = !!a[0]; break;
          case "setMacro": __kagMacros[a[0]] = a[1]; break;
          case "eraseMacro":
            result = delete __kagMacros[a[0]]; break;
          case "params":
            if(references===void)references=[];
            result = __kagEncodeParams(references);break;
          case "pushParams": __kagPushParams(__kagResolveTag(a[0].value,references,a[0].references)); break;
          case "popParams": __kagParamDepth = a[0]; break;
          case "clearParams": __kagClearParams(); break;
          case "readRestoreParams":
            savedParams=[];result=__kagReadRestoreParams(restoring,savedParams);break;
          case "restoreParams":
            for(var i=0;i<a[0].count;i++) {
              __kagParams.add(savedParams[i]); __kagParamNames.add(a[0][i].names);
            }
            __kagParamDepth=a[0].count;result=__kagParams.count;
            break;
          case "restoreCallCount":
            savedFrames=restoring.callStack;
            if(savedFrames!==void){
              if(savedFrames===null || typeof savedFrames!="Object")throw new Exception("Malformed KAG call stack");
              var frameCount=savedFrames.count;
              if(frameCount===void)throw new Exception("Malformed KAG call stack");
              result=int(frameCount);
            }
            break;
          case "restoreCallFrame":
            var f=savedFrames[a[0]];
            result=%[storage:string(f.storage),label:string(f.label),offset:int(f.offset),orgLineStr:string(f.orgLineStr),
              lineBuffer:string(f.lineBuffer),pos:int(f.pos),lineBufferUsing:!!f.lineBufferUsing,
              macroArgStackBase:int(f.macroArgStackBase),macroArgStackDepth:int(f.macroArgStackDepth),
              ExcludeLevel:int(f.ExcludeLevel),IfLevel:int(f.IfLevel),ExcludeLevelStack:string(f.ExcludeLevelStack),
              IfLevelExecutedStack:string(f.IfLevelExecutedStack)];
            break;
          case "restoreField":
            var field=a[0],value=restoring[field];
            if(value!==void)result=field=="ExcludeLevel" || field=="IfLevel" || field=="macroArgStackBase"
              ? int(value) : string(value);
            break;
          case "yield": break;
          default: throw new Exception("Unknown KAG effect: " + operation.kind);
        }
        operation = __host("KAG.resume", __kagId, token, result);
      } catch(error) {
        __host("KAG.cancel", __kagId, token);
        throw error;
      }
    }
    return method=="getNextTag" && operation.value!==void
      ? __kagResolveTag(operation.value,references,operation.references) : operation.value;
  }
  function loadScenario(name) { __kagRun("loadScenario", string(name)); }
  function goToLabel(name) { __kagRun("goToLabel", string(name)); }
  function callLabel(name) { __kagRun("callLabel", string(name)); }
  function __kagClearParams() {
    __kagParams.clear(); __kagParamNames.clear(); __kagParamDepth=0;
  }
  function __kagPushParams(values) {
    var depth=__kagParamDepth++;
    __kagParamNames[depth]=values.taglist; delete values.taglist;
    if(depth==__kagParams.count) __kagParams.add(%[]);
    (Dictionary.assign incontextof __kagParams[depth])(values);
  }
  function __kagAcceptTag(next) {
    __kagTagList.assign(next.taglist);
    (Dictionary.assign incontextof __kagTag)(next);
    __kagTag.taglist = __kagTagList;
    return __kagTag;
  }
  function getNextTag() {
    var next = __kagRun("getNextTag");
    return next === void ? void : __kagAcceptTag(next);
  }
  function clear() { __kagRun("clear"); }
  function clearCallStack() { __kagRun("clearCallStack"); }
  function popMacroArgs() { __kagRun("popMacroArgs"); }
  function store() {
    var params=[],shapes=[],names=[],macros=%[];
    (Dictionary.assign incontextof macros)(__kagMacros);
    for(var i=0;i<__kagParamDepth;i++){
      var values=%[];(Dictionary.assign incontextof values)(__kagParams[i]);
      params.add(values);shapes.add(__kagShape(values));names.add(__kagParamNames[i]);
    }
    var result=__host("KAG.store",__kagId,%[],shapes,names);
    result.macros=macros;result.macroArgs=params;
    return result;
  }
  function restore(data) {
    // Native applies optional macros before inspecting macroArgs, including
    // when a later malformed-save error is raised. Omitted macros keep them.
    var macros=data.macros;
    if(macros!==void)(Dictionary.assign incontextof __kagMacros)(macros);
    __kagRun("restore",void,data);
  }
  function __kagReadRestoreParams(data,savedParams) {
    __kagParamDepth=0;
    // Only the fields consumed by KAG cross the host boundary. Games can
    // keep live callbacks and other private data beside their parser state.
    var shape=%[],params=[];
    var args=data.macroArgs;
    if(args===void){
      if(__kagParams.count)__host("KAG.malformedSave",__kagId);
      shape.macroArgStackDepth=0;
    }else{
      var count=args.count;
      if(count>4096)throw new Exception("Malformed KAG macro depth");
      __kagClearParams();
      shape.macroArgStackDepth=data.macroArgStackDepth;
      if(data instanceof "Dictionary")shape.macroArgNames=data.macroArgNames;
      for(var i=0;i<count;i++){
        var values=%[];(Dictionary.assign incontextof values)(args[i]);
        savedParams.add(values);params.add(__kagShape(values));
      }
    }
    shape.macroArgs=params;
    return shape;
  }
  function assign(parser) {
    if(!(parser instanceof "KAGParser")) {
      if(typeof parser=="Object") __host("KAG.invalidAssign", __kagId);
      throw new Exception("Expected a KAGParser");
    }
    __host("KAG.assign", __kagId, parser.__kagId);
    (Dictionary.assign incontextof __kagMacros)(parser.__kagMacros);
    __kagClearParams();
    for(var i=0;i<parser.__kagParamDepth;i++) {
      var values=%[],names=[];
      (Dictionary.assign incontextof values)(parser.__kagParams[i]);
      names.assign(parser.__kagParamNames[i]);
      __kagParams.add(values); __kagParamNames.add(names);
    }
    __kagParamDepth=parser.__kagParamDepth;
  }
  function interrupt() { __host("KAG.interrupt", __kagId); }
  function resetInterrupt() { __host("KAG.resetInterrupt", __kagId); }
  function onScenarioLoad(storage) {}
  function onScenarioLoaded(storage) {}
  function onLabel(label, page) {}
  function onScript(script, storage, line) {}
  function onJump(tag) { return true; }
  function onCall(tag) { return true; }
  function onReturn(tag) { return true; }
  function onAfterReturn() {}
  property macros { getter() { return __kagMacros; } }
  property macroParams { getter() { return __kagParamDepth ? __kagParams[__kagParamDepth-1] : null; } }
  property mp { getter() { return macroParams; } }
  property curStorage {
    getter() { return __host("KAG.get", __kagId, "curStorage"); }
    setter(value) { loadScenario(value); }
  }
  ${['curLine', 'curPos', 'curLineStr', 'curLabel', 'callStackDepth']
    .map(
      (name) => `property ${name} {
    getter() { return __host("KAG.get", __kagId, "${name}"); }
  }`,
    )
    .join('\n')}
  ${['ignoreCR', 'processSpecialTags', 'debugLevel']
    .map(
      (name) => `property ${name} {
    getter() { return __host("KAG.get", __kagId, "${name}"); }
    setter(value) { __host("KAG.set", __kagId, "${name}", ${name === 'debugLevel' ? 'int(value)' : '!!value'}); }
  }`,
    )
    .join('\n')}
}
`

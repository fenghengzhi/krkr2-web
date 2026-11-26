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
  function __kagRun(method, argument=void) {
    var operation = __host("KAG.begin", __kagId, method, argument);
    while(!operation.done) {
      var token = operation.token, a = operation.args, result = void;
      try {
        switch(operation.kind) {
          case "callback":
            if(a[0] == "onJump" || a[0] == "onCall" || a[0] == "onReturn") a[1][0] = __kagAcceptTag(a[1][0]);
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
          case "getMacro": result = __kagMacros[a[0]]; if(result !== void) result = string(result); break;
          case "boolean": result = !!a[0]; break;
          case "setMacro": __kagMacros[a[0]] = a[1]; break;
          case "eraseMacro":
            result = delete __kagMacros[a[0]]; break;
          case "params": result = __kagParamDepth ? %[values:__kagParams[__kagParamDepth-1],names:__kagParamNames[__kagParamDepth-1]] : null; break;
          case "pushParams": __kagPushParams(a[0]); break;
          case "popParams": __kagParamDepth = a[0]; break;
          case "clearParams": __kagClearParams(); break;
          case "restoreMacros": (Dictionary.assign incontextof __kagMacros)(a[0]); break;
          case "restoreParams":
            __kagClearParams();
            for(var i=0;i<a[0].count;i++) {
              __kagParams.add(a[0][i].values); __kagParamNames.add(a[0][i].names);
            }
            __kagParamDepth = __kagParams.count;
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
    return operation.value;
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
    (Dictionary.clear incontextof __kagTag)(); __kagTagList.clear();
    var next = __kagRun("getNextTag");
    return next === void ? void : __kagAcceptTag(next);
  }
  function clear() { __kagRun("clear"); }
  function clearCallStack() { __kagRun("clearCallStack"); }
  function popMacroArgs() { __kagRun("popMacroArgs"); }
  function store() {
    var params=[],names=[];
    for(var i=0;i<__kagParamDepth;i++){params.add(__kagParams[i]);names.add(__kagParamNames[i]);}
    return __host("KAG.store", __kagId, __kagMacros, params, names);
  }
  function restore(data) { __kagRun("restore", data); }
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
    setter(value) { __host("KAG.set", __kagId, "${name}", int(value)); }
  }`,
    )
    .join('\n')}
}
`

import { isScriptObject, type ScriptClass, type ScriptValue } from '../script/runtime.ts'

// The bodies stay in TJS so dialogs keep their existing request/exception stack.
// Native registration supplies static flags, receiver checks and call policies.
const methods = [
  [
    'getArgument',
    0x101,
    String.raw`function(name) { return global.__host("System.getArgument",string(name)); }`,
  ],
  [
    'setArgument',
    2,
    String.raw`function(name,value) { global.__host("System.setArgument",string(name),string(value)); }`,
  ],
  [
    'addContinuousHandler',
    1,
    String.raw`function(callback) {
    if(!global.__host("System.hasContinuous",callback))
      global.__host("System.addContinuous",callback,int(global.__host("System.getArgument","-contfreq")));
  }`,
  ],
  [
    'removeContinuousHandler',
    1,
    String.raw`function(callback) { global.__host("System.removeContinuous",callback); }`,
  ],
  [
    'getKeyState',
    1,
    String.raw`function(key,async=true) { return global.__host("Input.get",int(key),"keyState"); }`,
  ],
  ['getTickCount', 0x100, String.raw`function() { return global.__host("System.tick"); }`],
  ['clearGraphicCache', 0, String.raw`function() { global.__host("System.clearGraphicCache"); }`],
  [
    'touchImages',
    1,
    String.raw`function(storages, limitbytes=0, timeout=0) {
    if (!(storages instanceof "Array")) throw "System.touchImages requires an Array";
    var count=storages.count;
    if (count>4096) throw "Image preload list exceeds 4096 entries";
    var names=[];
    for (var i=0;i<count;i++) {
      var name=storages[i];
      if (name===void) break;
      names.add(string(name));
    }
    global.__host("System.touchImages", names, int(limitbytes), int(timeout));
  }`,
  ],
  [
    'createAppLock',
    0x101,
    String.raw`function(key) { return global.__host("System.createAppLock", string(key)); }`,
  ],
  ['exit', 0, String.raw`function(code=0) { global.__host("System.exit", int(code)); }`],
  ['terminate', 0, String.raw`function(code=0) { global.__host("System.exit", int(code)); }`],
  [
    'inform',
    1,
    String.raw`function(args*) {
    if(args.count<1) throw new Exception("System.inform requires a message");
    var request=%[],host=global.__host incontextof global;
    var caption=args.count>1 && args[1]!==void ? string(args[1]) : "Information";
    try { host("System.dialog",request,"inform",caption,string(args[0]),""); }
    catch(error) {
      try { host("System.dialogAbort",request); } catch(cleanupError) {}
      throw error;
    }
  }`,
  ],
  [
    'inputString',
    3,
    String.raw`function(args*) {
    if(args.count<3) throw new Exception("System.inputString requires caption, prompt and initialString");
    var request=%[],host=global.__host incontextof global;
    try { return host("System.dialog",request,"input-string",string(args[0]),string(args[1]),string(args[2])); }
    catch(error) {
      try { host("System.dialogAbort",request); } catch(cleanupError) {}
      throw error;
    }
  }`,
  ],
] as const

const properties = [
  [
    'graphicCacheLimit',
    String.raw`
    getter() { return global.__host("System.cacheLimit"); }
    setter(value) { global.__host("System.cacheLimit", int(value)); }
  `,
  ],
  [
    'exitOnWindowClose',
    String.raw`
    getter() { return global.__host("System.exitOnWindowClose"); }
    setter(value) { global.__host("System.exitOnWindowClose", int(!!value)); }
  `,
  ],
  [
    'eventDisabled',
    String.raw`
    getter() { return global.__host("System.eventDisabled"); }
    setter(value) { global.__host("System.eventDisabled", int(!!value)); }
  `,
  ],
  [
    'title',
    String.raw`
    getter() { return global.__host("System.title"); }
    setter(value) { global.__host("System.title", string(value)); }
  `,
  ],
] as const

export const systemClass = String.raw`
${properties.map(([name, body]) => `property __system_${name} {${body}}`).join('\n')}
var System=global.__host("System.class",${[
  ...methods.map(([, , body]) => body),
  ...properties.map(([name]) => `&__system_${name}`),
].join(',\n')});
${properties.map(([name]) => `delete global.__system_${name};`).join('\n')}
`

export const systemReadonlyProperties = [
  'exePath',
  'exeName',
  'dataPath',
  'personalPath',
  'appDataPath',
  'versionString',
  'versionInformation',
  'platformName',
  'osName',
] as const

export function systemClassValue(delegates: ScriptValue[]): ScriptClass {
  if (delegates.length !== methods.length + properties.length || !delegates.every(isScriptObject))
    throw new Error('Invalid System class delegates')
  return {
    type: 'class',
    namespace: 'System',
    id: 0,
    className: 'System',
    properties: systemReadonlyProperties.map((name) => ({
      name,
      writable: false,
      static: true,
      boolean: false,
    })),
    systemMethods: methods.map(([name, policy], index) => ({
      name,
      policy,
      callback: delegates[index]!,
    })),
    systemProperties: properties.map(([name], index) => ({
      name,
      callback: delegates[methods.length + index]!,
    })),
  }
}

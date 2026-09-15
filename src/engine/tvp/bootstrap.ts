// This is executed by TJS2 itself. The host stores platform-independent layer
// state; TJS retains its own class, property and closure semantics.
export const bootstrap = String.raw`
var Scripts = __host("Scripts.class");
var Storages = %[
  isExistentStorage: function(name) { return __host("Storages.exists", name); },
  addAutoPath: function(path) { __host("Storages.addAutoPath", path); }
  ,removeAutoPath: function(path) { __host("Storages.removeAutoPath", path); }
  ,getPlacedPath: function(path) { return __host("Storages.getPlacedPath", path); }
  ,extractStorageName: function(path) { return path.replace(/^.*[\/\\>]/, ""); }
  ,extractStoragePath: function(path) { return path.replace(/[^\/\\>]*$/, ""); }
  ,chopStorageExt: function(path) { return path.replace(/\.[^\.\/\\>]*$/, ""); }
];
var System = %[
  getArgument: function(name) { return __host("System.getArgument",string(name)); },
  setArgument: function(name,value) { __host("System.setArgument",string(name),string(value)); },
  addContinuousHandler: function(callback) {
    if(!__host("System.hasContinuous",callback))
      __host("System.addContinuous",callback,int(__host("System.getArgument","-contfreq")));
  },
  removeContinuousHandler: function(callback) { __host("System.removeContinuous",callback); },
  exceptionHandler: void,
  getKeyState: function(key,async=true) { return __host("Input.get",int(key),"keyState"); },
  exePath: "", dataPath: "savedata/", personalPath: "savedata/", appDataPath: "savedata/",
  osName: "Web", platformName: "Web", versionString: "krkr2-web", title: "krkr2-web",
  getTickCount: function() { return __host("System.tick"); },
  clearGraphicCache: function() { __host("System.clearGraphicCache"); },
  touchImages: function(storages, limitbytes=0, timeout=0) {
    if (!(storages instanceof "Array")) throw "System.touchImages requires an Array";
    var count=storages.count;
    if (count>4096) throw "Image preload list exceeds 4096 entries";
    var names=[];
    for (var i=0;i<count;i++) {
      var name=storages[i];
      if (name===void) break;
      names.add(string(name));
    }
    __host("System.touchImages", names, int(limitbytes), int(timeout));
  },
  createAppLock: function(key) { return __host("System.createAppLock", string(key)); },
  exit: function(code=0) { __host("System.exit", int(code)); },
  terminate: function(code=0) { __host("System.exit", int(code)); },
  inform: function(message) { __host("Debug.message", string(message)); }
];
property __graphicCacheLimit {
  getter() { return __host("System.cacheLimit"); }
  setter(value) { __host("System.cacheLimit", int(value)); }
}
System.graphicCacheLimit = &__graphicCacheLimit;
delete global.__graphicCacheLimit;
property __exitOnWindowClose {
  getter() { return __host("System.exitOnWindowClose"); }
  setter(value) { __host("System.exitOnWindowClose", int(!!value)); }
}
System.exitOnWindowClose = &__exitOnWindowClose;
delete global.__exitOnWindowClose;
var Plugins = %[ link: function(name) { __host("Plugins.link", name); } ];
`

import { systemClass } from './system-class.ts'

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
${systemClass}
var Plugins = %[ link: function(name) { __host("Plugins.link", name); } ];
`

import { systemClass } from './system-class.ts'

// This is executed by TJS2 itself. The host stores platform-independent layer
// state; TJS retains its own class, property and closure semantics.
export const bootstrap = String.raw`
var Scripts = __host("Scripts.class");
var Storages = __host("Storages.class");
${systemClass}
var Plugins = %[ link: function(name) { __host("Plugins.link", name); } ];
`

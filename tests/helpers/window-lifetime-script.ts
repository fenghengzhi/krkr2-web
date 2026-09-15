/** Shared source definitions for Node and both browser VM backends. */
export const windowLifetimeScript = (extra = '') => `
var finalized=0,managedFinalized=0,calls=0,trace="",caught="",failWindow=false,failConstruct=false;
try{throw new Exception("warm window exception");}catch(e){}
// Variadic calls lazily create the shared native Array class. Account for it
// before measuring per-Window ownership, without writing a diagnostic message.
Debug.getLastLog();
class LifetimeWindow extends Window {
  var marker=42;
  function LifetimeWindow(){super.Window();caption="original";if(failConstruct)throw new Exception("window-constructor");}
  function finalize(){finalized++;if(failWindow)throw new Exception("window-finalizer");}
  function onResize(){calls++;}
  function onKeyDown(key,shift){calls++;}
}
class ManagedWindowObject {function finalize(){managedFinalized++;}}
function makeWindow(){global.win=new LifetimeWindow();}
function dropWindow(args*){calls++;delete global.win;}
${extra}
`

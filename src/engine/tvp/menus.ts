export const menuClass = String.raw`
function __krkrMenuInvalidate(owner,id,state,count) {
  try {
    for(var i=0;i<count;i++) {
      var child=state.owned[i];
      if(child!==void && child!==null) {
        invalidate child;
        state.owned[i]=null;
        child=null;
      }
      __host("Menu.releaseSlot",id,i);
    }
    state.owned.clear();
    state.cache=null;
    state.clear=null;
    state.actionOwner=null;
  } catch(error) {
    __host("Menu.abort",id);
    throw error;
  }
  __host("Menu.finish",id);
}
__host("Menu.bind",__krkrMenuInvalidate);
function __krkrMenuInsert(parent,item,index) {
  var change=__host("Menu.insert",parent,item,index);
  if(change===null)return;
  // Establish the new owning edge before releasing the previous registration.
  change.state.owned[change.slot]=change.child;
  change.state.cacheValid=false;
  if(change.oldState!==null) {
    change.oldState.owned[change.oldSlot]=null;
    change.oldState.cacheValid=false;
  }
}
class MenuItem {
  function MenuItem(actionOwner, captionOrWindow="") {
    if(typeof actionOwner!="Object")throw new Exception("MenuItem requires an action owner object");
    var state=%[actionOwner:actionOwner,owned:[],cache:null,clear:null,cacheValid:false];
    __host("Menu.create",this,state,typeof captionOrWindow=="Object"?captionOrWindow:string(captionOrWindow));
  }
  function finalize() {}
  function add(item) { __krkrMenuInsert(this,item,void); }
  function insert(item,index) { __krkrMenuInsert(this,item,int(index)); }
  function remove(item) {
    var change=__host("Menu.remove",this,item);
    if(change!==null) {
      change.state.owned[change.slot]=null;
      change.state.cacheValid=false;
    }
  }
  function popup(args*) {
    if(args.count<3)throw new Exception("MenuItem.popup requires flags, x and y");
    var request=[], host=global.__host incontextof global;
    // Mask before crossing into JavaScript Number so high TJS integer bits do
    // not lose the low DWORD flags or the signed coordinate payload.
    try {
      return host("Menu.popup",this,int(args[0]) & 0xffffffff,
        int(args[1]) & 0xffffffff,int(args[2]) & 0xffffffff,request);
    } catch(error) {
      try { host("Menu.modalAbort",request); } catch(cleanupError) {}
      throw error;
    }
  }
  function onClick() { return __host("Menu.action",__host("Menu.state",this).actionOwner,this); }
  property __menuId { getter() { return __host("Menu.view",this); } }
  property parent { getter() { return __host("Menu.relation",this,"parent"); } }
  property window { getter() { return __host("Menu.relation",this,"window"); } }
  property root { getter() { return __host("Menu.relation",this,"root"); } }
  property children { getter() {
    var state=__host("Menu.state",this);
    if(state.cache===null) {
      state.cache=[];
      state.clear=Array.clear incontextof null;
    }
    if(!state.cacheValid) {
      (state.clear incontextof state.cache)();
      if(isvalid state.cache) {
        var count=0;
        for(var i=0;i<state.owned.count;i++) {
          var child=state.owned[i];
          if(child!==void && child!==null)state.cache[count++]=child;
        }
      }
      state.cacheValid=true;
    }
    return state.cache;
  } }
  property index {
    getter() { return __host("Menu.index",this); }
    setter(value) { __host("Menu.index",this,int(value)); }
  }
  ${['caption', 'checked', 'enabled', 'group', 'radio', 'shortcut', 'visible']
    .map(
      (name) => `property ${name} {
    getter() { return __host("Menu.get", this, "${name}"); }
    setter(value) { __host("Menu.set", this, "${name}", ${name === 'caption' || name === 'shortcut' ? 'string' : 'int'}(value)); }
  }`,
    )
    .join('\n')}
}
`

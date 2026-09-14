export const menuClass = String.raw`
class MenuItem {
  var __menuId, __menuParent=null, __menuChildren, __menuWindow;
  function MenuItem(window, caption="") {
    __menuWindow=window; __menuChildren=[];
    __menuId=__host("Menu.create", string(caption));
  }
  function finalize() {
    if(__menuParent!==null) __menuParent.remove(this);
    while(__menuChildren.count) invalidate __menuChildren[0];
    __host("Menu.destroy", __menuId);
    __menuWindow=null;
  }
  function add(item) { insert(item, __menuChildren.count); }
  function insert(item, index) {
    if(!(item instanceof "MenuItem") || item.__menuWindow !== __menuWindow) throw new Exception("MenuItem belongs to a different window");
    __host("Menu.insert", __menuId, item.__menuId, int(index));
    if(item.__menuParent!==null) item.__menuParent.__menuChildren.remove(item);
    __menuChildren.insert(int(index),item); item.__menuParent=this;
  }
  function remove(item) {
    __host("Menu.remove", __menuId, item.__menuId);
    __menuChildren.remove(item); item.__menuParent=null;
  }
  function __menuFind(id) {
    if(__menuId==id) return this;
    for(var i=0;i<__menuChildren.count;i++) {
      var found=__menuChildren[i].__menuFind(id);
      if(found!==null) return found;
    }
    return null;
  }
  function popup(flags,x,y) {
    var selected=__host("Menu.popup", __menuId, int(flags), int(x), int(y));
    if(selected && !(flags & (tpmNoNotify|tpmReturnCmd)) && !System.eventDisabled) __menuWindow.__menuClick(selected);
    return selected;
  }
  function onClick() {}
  property parent { getter() { return __menuParent; } }
  property children { getter() { var copy=[];copy.assign(__menuChildren);return copy; } }
  property window { getter() { return __menuWindow; } }
  property root { getter() { var item=this;while(item.__menuParent!==null)item=item.__menuParent;return item; } }
  property index {
    getter() { return __menuParent===null ? -1 : __menuParent.__menuChildren.find(this); }
    setter(value) { if(__menuParent===null) throw new Exception("MenuItem has no parent"); __menuParent.insert(this,value); }
  }
  ${['caption', 'checked', 'enabled', 'group', 'radio', 'shortcut', 'visible']
    .map(
      (name) => `property ${name} {
    getter() { return __host("Menu.get", __menuId, "${name}"); }
    setter(value) { __host("Menu.set", __menuId, "${name}", ${name === 'caption' || name === 'shortcut' ? 'string' : 'int'}(value)); }
  }`,
    )
    .join('\n')}
}
`

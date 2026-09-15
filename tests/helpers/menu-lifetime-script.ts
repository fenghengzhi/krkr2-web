/** Cases run inside the actual TVP bridge in source and native bytecode form. */
export const menuLifetimeScript = String.raw`
var menuOwnerDeaths=0,menuItemDeaths=0,menuFail=false,menuVisits="";
class MenuActionOwner {
  function finalize(){menuOwnerDeaths++;}
  function action(event){return event.target.caption;}
}
class OwnedMenu extends MenuItem {
  function OwnedMenu(owner=null,caption="item"){super.MenuItem(owner,caption);}
  function finalize(){menuItemDeaths++;}
}
class FailingMenu extends MenuItem {
  function FailingMenu(){super.MenuItem(null,"failure");}
  function finalize(){menuVisits+="F";if(menuFail)throw new Exception("menu-finalizer-retry");}
}
function menuDropParent(){var parent=new MenuItem(null),child=new OwnedMenu();parent.add(child);return child;}
function menuLifetimeChecks(){
  var checks=[];
  var parent=new MenuItem(null,"parent"),first=new OwnedMenu(),second=new OwnedMenu();
  parent.add(first);parent.add(second);
  demand(first.parent===parent && first.window===null,"weak parent and child window");
  var cache=parent.children;
  demand(cache===parent.children && cache[0]===first,"stable cache identity");
  second.index=0;
  demand(cache===parent.children && cache[0]===first && second.index==0,"registration order versus visual order");
  cache.clear();
  demand(parent.children.count==0,"user cache mutation must persist");
  parent.remove(first);
  demand(cache===parent.children && cache.count==1 && cache[0]===second,"dirty cache refresh");
  parent.add(first);
  demand(parent.children[0]===second && parent.children[1]===first,"registration appends after removal");
  parent.finalize();
  demand(isvalid parent && first.parent===parent,"direct finalize must keep native resources");
  invalidate first;
  parent.remove(first);
  demand(parent.children.count==2 && !(isvalid parent.children[1]),"invalid child remains registered");
  invalidate parent;
  demand(!(isvalid second) && isvalid cache && cache.count==2,"parent invalidates children but releases cache");
  checks.add("registration/cache/finalize");

  var owner=new MenuActionOwner(),menu=new OwnedMenu(owner,"held");
  menuOwnerDeaths=0;owner=null;
  demand(menuOwnerDeaths==0 && menu.onClick()=="held","native action owner retention");
  invalidate menu;
  demand(menuOwnerDeaths==1,"action owner release");
  checks.add("action owner");

  var child=menuDropParent();
  demand(!(isvalid child),"child must not retain parent");
  checks.add("weak parent");

  var retry=new FailingMenu(),heldChild=new OwnedMenu();retry.add(heldChild);
  menuFail=true;menuVisits="";var caught="";
  try{invalidate retry;}catch(error){caught=error.message;}
  demand(caught.indexOf("menu-finalizer-retry")>=0 && isvalid retry && isvalid heldChild,"script failure must preserve native state");
  menuFail=false;invalidate retry;
  demand(menuVisits=="FF" && !(isvalid heldChild),"script finalizer retry");
  checks.add("script retry");

  var retryParent=new MenuItem(null),good=new OwnedMenu(),bad=new FailingMenu();
  retryParent.add(good);retryParent.add(bad);menuFail=true;menuVisits="";
  caught="";try{invalidate retryParent;}catch(error){caught=error.message;}
  demand(caught.indexOf("menu-finalizer-retry")>=0 && isvalid retryParent && !(isvalid good) && isvalid bad,"child failure progress");
  menuFail=false;invalidate retryParent;
  demand(!(isvalid bad) && menuVisits=="FF","native cleanup retry");
  checks.add("native retry");

  var window=new Window(),alias=new MenuItem(null,window),root=window.menu;
  demand(alias!==root && alias.__menuId==root.__menuId && alias.window===window,"shared root wrappers");
  var leaf=new MenuItem(null,"alias child");alias.add(leaf);
  demand(leaf.root===alias && leaf.window===null,"wrapper registration identity");
  invalidate alias;
  demand(isvalid root && !(isvalid leaf),"root wrapper invalidation");
  root.caption="still attached";
  invalidate window;
  checks.add("window roots");

  var invalidArguments=0;
  try{new MenuItem();}catch(error){invalidArguments++;}
  try{new MenuItem(1);}catch(error){invalidArguments++;}
  try{new MenuItem(null,null);}catch(error){invalidArguments++;}
  try{new MenuItem(null,%[]);}catch(error){invalidArguments++;}
  var branded=new MenuItem(null),fake=%[__menuId:branded.__menuId];
  try{branded.add(fake);}catch(error){invalidArguments++;}
  demand(invalidArguments==5,"native constructor and menu casts");
  invalidate branded;
  checks.add("native casts");
  return checks.join(",");
}
`

export const postedInputErrors: Readonly<Record<number, string>> = {
  0: 'count|', 1: 'unknown:<onClick>|', 2: 'parameters:<onKeyDown>|',
  3: 'field:<onKeyDown>:<key>|', 4: 'field:<onKeyDown>:<shift>|',
  5: 'key-getter|key', 8: 'object-convert|',
}
export const postedInputSource = String.raw`
System.exitOnWindowClose=false;
var postedTrace=[],postedReads=[],postedFail=false,postedKey=65,postedShift=0;
class PostedWindow extends Window {
 var label;
 function PostedWindow(name){super.Window();label=name;caption=name;setInnerSize(100,50);visible=true;}
 function onKeyDown(key,shift){postedTrace.add(label+":D:"+key+":"+shift);}
 function onKeyUp(key,shift){postedTrace.add(label+":U:"+key+":"+shift);}
 function onKeyPress(key){postedTrace.add(label+":T:"+key);}
 function onMouseDown(x,y,b,s){postedTrace.add(label+":down:"+x+","+y+":"+b+":"+s);}
 function onMouseUp(x,y,b,s){postedTrace.add(label+":up:"+x+","+y+":"+b+":"+s);}
 function onClick(x,y){postedTrace.add(label+":click:"+x+","+y);}
}
var postedA=new PostedWindow("A"),postedB=new PostedWindow("B");
var postedRoot=new Layer(postedA,null);postedA.add(postedRoot);postedRoot.setSize(100,50);postedRoot.fillRect(0,0,100,50,0xff203040);
var postedButton=new Layer(postedA,postedRoot);postedA.add(postedButton);postedButton.setPos(10,5);postedButton.setSize(40,30);postedButton.fillRect(0,0,40,30,0xffffffff);postedButton.visible=true;
postedButton.onClick=function(x,y){global.postedTrace.add("button:"+x+","+y);};
class PostedFields {
 property key {getter(){global.postedReads.add("key");if(global.postedFail)throw new Exception("key-getter");return global.postedKey;}}
 property shift {getter(){global.postedReads.add("shift");return global.postedShift;}}
}
class PostedNoFields {}
class PostedNoShift {var key=65;}
function postedHolders(){
 System.assignMessage("TJSBadParamCount","count");System.assignMessage("TJSVariantConvertError","convert");
 System.assignMessage("TJSVariantConvertErrorToObject","object-convert");
 System.assignMessage("TVPSpecifiedEventNameIsUnknown","unknown:<%1>");
 System.assignMessage("TVPSpecifiedEventNeedsParameter","parameters:<%1>");
 System.assignMessage("TVPSpecifiedEventNeedsParameter2","field:<%1>:<%2>");
}
function postedInvalid(which){
 postedReads.clear();var result="ok";postedFail=which==5;
 try{
  if(which==0)postedA.postInputEvent();
  if(which==1)postedA.postInputEvent("onClick");
  if(which==2)postedA.postInputEvent("onKeyDown");
  if(which==3)postedA.postInputEvent("onKeyDown",new PostedNoFields());
  if(which==4)postedA.postInputEvent("onKeyDown",new PostedNoShift());
  if(which==5)postedA.postInputEvent("onKeyDown",new PostedFields());
  if(which==6)postedA.postInputEvent("onKeyPress",new PostedFields());
  if(which==7)postedA.postInputEvent("onKeyDown",%[]);
  if(which==8)postedA.postInputEvent("onClick",123);
 }catch(e){result=e.message;}
 postedFail=false;return result+"|"+postedReads.join(",");
}
function postedOrdinary(){
 postedTrace.clear();postedReads.clear();postedKey=4294967361;postedShift=4294967295;
 postedA.postInputEvent("onKeyDown",new PostedFields());
 postedA.postInputEvent("onKeyUp",new PostedFields());
 postedA.postInputEvent("onKeyPress",%[key:321]);
 postedA.postInputEvent("onKeyPress",%[key:0]);
 postedB.postInputEvent("onKeyDown",%[key:66]);
 postedTrace.add("returned");
 return postedReads.join(",");
}
function postedMouse(){postedTrace.clear();postedA.useMouseKey=true;postedA.postInputEvent("onKeyDown",%[key:13]);postedA.postInputEvent("onKeyPress",%[key:13]);postedA.postInputEvent("onKeyUp",%[key:13]);postedTrace.add("returned");}
Debug.message("posted-input-ready");
`

/** Only this game-authored observer is compiled. The complete original KAG
 * startup, Conductor and MainWindow.action/padKeyMap path remain unchanged. */
export const postedKagSource = String.raw`
var postedKagButton,postedKagCount=0;
function preparePostedKag(){
 kag.padKeyMap[VK_F8]=VK_RETURN;kag.useMouseKey=true;
 postedKagButton=new Layer(kag,kag.fore.base);kag.add(postedKagButton);
 postedKagButton.setPos(20,20);postedKagButton.setSize(32,24);postedKagButton.type=ltOpaque;
 postedKagButton.fillRect(0,0,32,24,0xff204080);postedKagButton.visible=true;postedKagButton.absolute=2000001;
 postedKagButton.onClick=function(){global.postedKagCount++;global.postedKagButton.fillRect(0,0,32,24,0xffc83c14);Debug.message("posted-kag-click:"+global.postedKagCount);};
 return kag.__windowId;
}
Debug.message("posted-kag-observer-ready");
`

// Sequential observations of the same three overlapping game layers.
export const layerOrderCases = [
  { id: 'order-append', expected: '1|portrait:1000,history:2000000,notice:2000001|notice' },
  { id: 'order-tie', expected: '1|portrait:1000,notice:2000000,history:2000000|history' },
  { id: 'order-repeat-tie', expected: '1|portrait:1000,history:2000000,notice:2000000|notice' },
  { id: 'order-reparent', expected: '2000000|1|portrait:1000,history:2000000,notice:2000001|notice' },
  { id: 'order-rejected-move', expected: '1|0|portrait:0,history:1,notice:2|notice' },
  { id: 'order-signed', expected: '1|history:-1,portrait:0,notice:2|notice' },
  { id: 'order-relative', expected: '0|notice:0,history:1,portrait:2|portrait' },
  { id: 'order-sibling-hit', expected: 'portrait,history,notice,history' },
  { id: 'order-nested-hit', expected: 'portrait,history,1,portrait' },
  { id: 'order-query-args', expected: 'order-count,order-count,portrait,history' },
] as const

export const layerOrderSource = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var orderWindow=new Window(),orderRoot=new Layer(orderWindow,null);
orderWindow.setInnerSize(32,32);orderWindow.add(orderRoot);orderRoot.setSize(32,32);
function orderPanel(title,color){
 var layer=new Layer(orderWindow,orderRoot);orderWindow.add(layer);
 layer.name=title;layer.type=ltOpaque;layer.setSize(32,32);
 layer.fillRect(0,0,32,32,color);layer.visible=true;
 return layer;
}
var orderPortrait=orderPanel("portrait",0xffa03020),orderHistory=orderPanel("history",0xff20a030),orderNotice;
orderPortrait.absolute=1000;orderHistory.absolute=2000000;
orderWindow.visible=true;
function layerOrderRun(id){
 var prefix="";
 if(id=="order-append")orderNotice=orderPanel("notice",0xff3020a0);
 if(id=="order-tie")orderNotice.absolute=orderHistory.absolute;
 if(id=="order-repeat-tie")orderHistory.absolute=orderHistory.absolute;
 if(id=="order-reparent"){
  orderHistory.absoluteOrderMode=true;orderNotice.parent=orderHistory;
  prefix=orderNotice.absolute+"|";orderNotice.parent=orderRoot;
 }
 if(id=="order-rejected-move"){
  var rejected=0;try{orderHistory.moveBefore(orderHistory);}catch(e){rejected=1;}
  prefix=rejected+"|";
 }
 if(id=="order-signed")orderHistory.absolute=4294967295;
 if(id=="order-relative")orderNotice.order=4294967295;
 if(id=="order-sibling-hit"){
  orderPortrait.setPos(10,7,12,10);orderHistory.setPos(2,3,20,16);
  return [orderHistory.getLayerAt(10,6).name,orderPortrait.getLayerAt(2,2,true).name,
   orderHistory.getLayerAt(-1,-1).name,orderPortrait.getLayerAt(0x4000000000000002,2,true).name].join(",");
 }
 if(id=="order-nested-hit"){
  var holder=new Layer(orderWindow,orderHistory),caller=new Layer(orderWindow,holder);
  orderWindow.add(caller);caller.setPos(3,2);
  var nested=caller.getLayerAt(8,3).name;invalidate holder;
  if(caller.parent!==null)throw new Exception("Retired parent still attached");
  var detached=caller.getLayerAt(8,3,true).name;
  orderPortrait.enabled=false;
  return [nested,detached,int(orderHistory.getLayerAt(10,6)===null),orderHistory.getLayerAt(10,6,false,true).name].join(",");
 }
 if(id=="order-query-args"){
  System.assignMessage("TJSBadParamCount","order-count");var errors=[];
  try{orderHistory.getLayerAt();}catch(e){errors.add(e.message);}
  try{orderHistory.getLayerAt(1);}catch(e){errors.add(e.message);}
  errors.add(orderHistory.getLayerAt(10,6,false,0.5).name);
  errors.add(orderPortrait.getLayerAt(2,2,%[],true).name);return errors.join(",");
 }
 var children=orderRoot.children,rows=[];
 for(var i=0;i<children.count;i++)rows.add(children[i].name+":"+children[i].absolute);
 return prefix+int(orderRoot.absoluteOrderMode)+"|"+rows.join(",")+"|"+orderRoot.getLayerAt(8,8).name;
}
function layerOrderClose(){invalidate orderWindow;}
`

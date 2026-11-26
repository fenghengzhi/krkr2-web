/** Independent input fixture: ordinary choice activation, right-button menu
 * and middle-button history are different player actions. The bottom strip
 * publishes which action was last performed; no font raster is an oracle. */
export const mouseButtonChoiceSource = String.raw`
System.exitOnWindowClose=false;
var buttonChoices=0,buttonMenus=0,buttonHistory=0,buttonDoubles=0,buttonOwnerHits=0;
var buttonTrace=[],buttonPhase=0,buttonColor=0xff204060;
function buttonState(){return [buttonChoices,buttonMenus,buttonHistory,buttonDoubles,buttonOwnerHits].join(",");}
function buttonRecord(name,x,y,button=void){
  global.buttonTrace.add(name+":"+x+","+y+(button===void?"":":"+button));
}
class ButtonWindow extends Window {
  function ButtonWindow(){super.Window();}
  function onMouseDown(x,y,button,shift){global.buttonTrace.clear();global.buttonRecord("window-down",x,y,button);}
  function onClick(x,y){global.buttonRecord("window-click",x,y);}
  function onDoubleClick(x,y){global.buttonRecord("window-double",x,y);}
  function onMouseUp(x,y,button,shift){global.buttonRecord("window-up",x,y,button);}
  function action(event){
    if(event.type=="onHitTest"){global.buttonOwnerHits++;return;}
    // Window activation, resize and movement also call this action. Only
    // Layer events below have a Layer name and describe a game control.
    if(!(event.target instanceof "Layer"))return;
    var name=event.target.name;
    if(event.type=="onMouseDown")global.buttonRecord(name+"-down",event.x,event.y,event.button);
    if(event.type=="onClick"){
      global.buttonRecord(name+"-click",event.x,event.y);
      if(event.target===global.buttonChoice){global.buttonChoices++;global.buttonColor=0xff703060;}
    }
    if(event.type=="onDoubleClick"){
      global.buttonRecord(name+"-double",event.x,event.y);
      if(event.target===global.buttonChoice){global.buttonDoubles++;global.buttonColor=0xff207080;}
    }
    if(event.type=="onMouseUp"){
      global.buttonRecord(name+"-up",event.x,event.y,event.button);
      if(event.target===global.buttonChoice){
        if(event.button==mbRight){global.buttonMenus++;global.buttonColor=0xff604020;}
        if(event.button==mbMiddle){global.buttonHistory++;global.buttonColor=0xff207040;}
      }
      global.buttonRoot.fillRect(0,120,240,40,global.buttonColor);
      global.buttonRoot.update();global.buttonWindow.update();global.buttonPhase++;
      global.Debug.message("button-choice:"+global.buttonPhase+":"+global.buttonState()+"|"+global.buttonTrace.join("|"));
    }
  }
}
class ButtonChoice extends Layer {
  function ButtonChoice(window,parent){
    super.Layer(window,parent);name="choice";setSize(240,120);fillRect(0,0,240,120,0xff304050);visible=true;
  }
  function onHitTest(x,y,hit){
    // The fractional true result discriminates the original variant bool
    // conversion from int(0.5). A rejected left band falls through to root.
    super.onHitTest(x,y,x>=40?0.5:0.0);
  }
}
var buttonWindow=new ButtonWindow();buttonWindow.caption="Button choices";buttonWindow.setInnerSize(240,160);
var buttonRoot=new Layer(buttonWindow,null);buttonRoot.name="root";buttonRoot.setSize(240,160);
buttonRoot.fillRect(0,0,240,160,0xff204060);
var buttonChoice=new ButtonChoice(buttonWindow,buttonRoot);
buttonWindow.add(buttonRoot);buttonWindow.add(buttonChoice);buttonWindow.visible=true;buttonWindow.update();
`

export function mouseButtonTrace(button: number, kind: 'none' | 'click' | 'double', x = 80): string {
  const target = x >= 40 ? 'choice' : 'root', events = [
    `window-down:${x},40:${button}`, `${target}-down:${x},40:${button}`,
  ]
  if (kind !== 'none') events.push(`window-${kind}:${x},40`, `${target}-${kind}:${x},40`)
  events.push(`window-up:${x},40:${button}`, `${target}-up:${x},40:${button}`)
  return events.join('|')
}

export const mouseButtonSteps = [
  { button: 1, clicks: 0, state: '0,1,0,0,0', color: [96, 64, 32, 255], kind: 'none', x: 80 },
  { button: 1, clicks: 0, state: '0,2,0,0,0', color: [96, 64, 32, 255], kind: 'none', x: 80 },
  { button: 2, clicks: 0, state: '0,2,1,0,0', color: [32, 112, 64, 255], kind: 'none', x: 80 },
  { button: 2, clicks: 0, state: '0,2,2,0,0', color: [32, 112, 64, 255], kind: 'none', x: 80 },
  { button: 0, clicks: 1, state: '1,2,2,0,0', color: [112, 48, 96, 255], kind: 'click', x: 80 },
  { button: 0, clicks: 2, state: '1,2,2,1,0', color: [32, 112, 128, 255], kind: 'double', x: 80 },
  { button: 0, clicks: 1, state: '1,2,2,1,0', color: [32, 112, 128, 255], kind: 'click', x: 20 },
] as const

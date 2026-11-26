/** Stock MainWindow.onMouseWheel treats nonpositive delta as a reading click;
 * HistoryLayer consumes signed 120-unit vertical notches. These are ordinary
 * authored waits, with no replacement input or history handler. */
export const wheelAxisSource = String.raw`
var wheelPhase=0;
function wheelAxisState(){return [global.wheelPhase,kag.currentLabel,kag.mainConductor.curLine,
 kag.mainConductor.curPos,kag.mainConductor.status,int(kag.clickWaiting),kag.mainConductor.lastTagName,
 int(kag.historyLayer.visible)].join("|");}
function wheelAxisHistory(){var h=kag.historyLayer,lines=[];
 for(var i=0;i<h.dataLines;i++)lines.add(string(h.getLine(i)));return lines.join("\n");}
Debug.message("wheel-axis-ready");
`

export const wheelAxisStory = String.raw`*reading|Wheel chapter
[cm][hr][eval exp="global.wheelPhase=1"][nowait]FIRST LINE[endnowait][l]
[r][eval exp="global.wheelPhase=2"][nowait]SECOND LINE[endnowait][l]
[r][eval exp="global.wheelPhase=3"][nowait]CHAPTER COMPLETE[endnowait][r]
[link target=*reading]Read again[endlink]
[s]
`

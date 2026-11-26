export const partialBookmarkFiles = {
  'first.ks': String.raw`[eval exp="f.partialResult=0"]
*menu|Partial bookmark menu
[cm][nowait]MENU [emb exp=f.partialResult][endnowait]
[partialmark phase=menu]
[r][link target=*enter]Enter chapter[endlink] / [link target=*load]Load lite file[endlink]
[s]
*enter
[eval exp="f.partialResult=13"]
[call storage=chapter.ks target=*entry]
[jump target=*returned]
*load
[eval exp="f.partialResult=29"]
[call storage=chapter.ks target=*load]
[jump target=*returned]
*returned|Returned to caller
[cm][nowait]RETURN [emb exp=f.partialResult][endnowait]
[partialmark phase=returned]
[s]
`,
  'chapter.ks': String.raw`*entry|Entered chapter
[cm][nowait]CHAPTER [emb exp=f.partialResult][endnowait]
[partialmark phase=entry]
[r][link target=*apply]Restore lite bookmark[endlink]
[s]
*apply
[partialwrite]
[partialbad]
[s]
*load
[partialread]
[partialbad]
[s]
*destination|Restored destination
[eval exp="f.partialResult=77"]
[cm][nowait]DESTINATION [emb exp=f.partialResult][endnowait]
[partialmark phase=destination]
[r][link target=*return]Return to caller[endlink]
[s]
*return
[return]
`,
}

/** Only authored tags are added. The real Conductor subclasses KAGParser;
 * restore itself must reload its current scenario and seek the saved label.
 * No jump or goToLabel is used to repair a missing restore movement. */
export const partialBookmarkSource = String.raw`
var partialOwner=kag.conductor,partialPhase="",partialText="",partialEntered=0,partialRestores=0;
var partialFallthrough=0,partialOrigin="none",partialEvents=[];
function partialApply(origin){
 var p=global.kag.conductor,d;
 if(p!==global.partialOwner || p.callStackDepth!=1 || p.curStorage!="chapter.ks")
  throw new Exception("Partial bookmark has no original chapter caller");
 var before=p.curStorage+"|"+p.callStackDepth;
 if(origin=="memory"){
  var saved=%[curLabel:"*destination",callStack:void,storageName:void];
  (Dictionary.saveStruct incontextof saved)(System.dataPath+"partial-bookmark.tjs");
  d=%[curLabel:"*destination"];
 }else d=Scripts.evalStorage(System.dataPath+"partial-bookmark.tjs");
 global.partialOrigin=origin;
 p.restore(d);
 global.partialRestores++;
 global.partialEvents.add(origin+"|"+before+"|"+p.curStorage+"|"+p.curLabel+"|"+p.callStackDepth+"|"+int(p===global.partialOwner));
 return 0;
}
kag.tagHandlers.partialwrite=function(elm){return global.partialApply("memory");};
kag.tagHandlers.partialread=function(elm){return global.partialApply("file");};
kag.tagHandlers.partialbad=function(elm){global.partialFallthrough++;throw new Exception("Restore fell through instead of selecting its label");};
kag.tagHandlers.partialmark=function(elm){
 global.partialPhase=elm.phase;global.partialText=global.kag.historyLayer.currentLine;
 if(elm.phase=="entry")global.partialEntered++;
 return 0;
};
function partialGameState(){var p=kag.conductor;
 return [global.partialPhase,global.partialText,p.curStorage,p.curLabel,p.callStackDepth,f.partialResult,
  global.partialEntered,global.partialRestores,global.partialFallthrough,global.partialOrigin,
  int(p===global.partialOwner),kag.current.numLinks,p.status].join("|");
}
function partialFileState(){var d=Scripts.evalStorage(System.dataPath+"partial-bookmark.tjs");
 return [d.curLabel,int(d.callStack===void),int(d.storageName===void)].join("|");
}
Debug.message("partial-bookmark-game-ready");
`

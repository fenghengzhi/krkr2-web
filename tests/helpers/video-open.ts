/** Fixed VideoOvlIntf.cpp 221–231 converts its one required ttstr before
 * VideoOvlImpl.cpp 224–232 enters Open and closes the old graph. */
export const videoOpenSource = String.raw`
class OpenMovie extends VideoOverlay {
 var states=[],frames=0,periods=[];
 function OpenMovie(w){super.VideoOverlay(w);}
 function onStatusChanged(value){states.add(value);}
 function onFrameUpdate(frame){frames++;}
 function onPeriod(reason){periods.add(reason);}
}
function videoOpenHolders(prefix){
 System.assignMessage("TJSBadParamCount",prefix+"-count");
 System.assignMessage("TJSVariantConvertError",prefix+"-string");
}
function videoOpenErrors(movie){
 var result=[];
 try{movie.open();result.add("unexpected-count-success");}catch(e){result.add(e.message);}
 try{movie.open(<%00%>,%[]);result.add("unexpected-string-success");}catch(e){result.add(e.message);}
 return result.join("|");
}
function videoOpenMissing(movie,name){
 try{movie.open(name);return "unexpected-success";}catch(e){return e.message;}
}
`

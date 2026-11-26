/** Author configuration uses KAG's documented override hook before the stock
 * menus are created. The original file selectors and bookmark methods stay
 * unchanged (MainWindow.tjs saveBookMarkToFileWithAsk/loadBookMarkFromFileWithAsk). */
export const namedBookmarkSource = (thumbnail: boolean) => String.raw`
function KAGWindow_config_override(){
 freeSaveDataMode=true;saveThumbnail=${thumbnail};thumbnailWidth=64;thumbnailDepth=24;
 saveDataMode="";dataName="named";saveDataLocation=System.dataPath;
}
var namedVisits=0,namedRendered="";
function namedState(){return [f.namedValue,global.namedRendered,global.namedVisits,kag.currentLabel,
 kag.current.numLinks,kag.conductor.status,int(kag.freeSaveDataMode)].join("|");}
function namedStored(name=void){
 if(name===void)name=System.dataPath+(kag.saveThumbnail?"旅のしおり.bmp":"旅のしおり.kdt");
 var data=Scripts.evalStorage(name,kag.saveThumbnail?"o"+kag.calcThumbnailSize().size:"");
 return data.user.namedValue+"|"+data.core.mainConductor.curLabel;}
`

export const namedBookmarkStory = String.raw`[eval exp="f.namedValue=0"]
*title|Named opening
[cm][hr][nowait]TITLE[endnowait]
[iscript]
global.namedRendered=kag.historyLayer.currentLine;global.namedVisits++;
[endscript]
[r][link target=*seven]Choose 7[endlink]
[s]
*seven
[eval exp="f.namedValue=7"]
[jump target=*checkpoint]
*ninety
[eval exp="f.namedValue=99"]
[jump target=*checkpoint]
*checkpoint|Named chapter
[cm][hr][nowait]CHAPTER [emb exp=f.namedValue][endnowait]
[iscript]
global.namedRendered=kag.historyLayer.currentLine;global.namedVisits++;
[endscript]
[r][link target=*ninety]Change to 99[endlink] / [link target=*continue]Continue[endlink]
[s]
*continue
[cm][hr][nowait]CONTINUE [emb exp=f.namedValue][endnowait]
[l]
[jump target=*checkpoint]
`

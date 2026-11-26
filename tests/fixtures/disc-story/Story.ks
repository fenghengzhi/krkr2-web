*arrival|Disc chapter
[image layer=base page=fore storage=Title.bmp clipleft=0 cliptop=0 clipwidth=640 clipheight=480]
[cm][hr][nowait][emb exp="global.discTitle"] [emb exp="f.discProgress"][endnowait]
[iscript]
global.discRendered=kag.historyLayer.currentLine;global.discVisits++;
[endscript]
[r][link target=*save]Save chapter[endlink] / [link target=*change]Change progress[endlink]
[s]
*save
[save place=0 ask=false]
[jump target=*arrival]
*change
[eval exp="f.discProgress=99"]
[jump target=*arrival]

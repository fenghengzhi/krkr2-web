*decoy
[image layer=0 page=fore storage="kag-eri-bookmark.bmp" key="&clNone" visible=1 left=10 top=10 mode=alpha]
[eval exp="Debug.message('eri-save=bmp-control')"][s]
*source
[image layer=0 page=fore storage="kag-eri-bookmark" key="&clNone" visible=1 left=10 top=10 mode=alpha]
[eval exp="Debug.message('eri-save=source-tag')"]
[eval exp="f.eriSaved=41"]
*eri_checkpoint|ERI image checkpoint
[eval exp="Debug.message('eri-save=ready:'+f.eriSaved)"][s]
*eri_changed
[image layer=0 page=fore storage="kag-eri-changed.eri" key="&clNone" visible=1 left=10 top=10 mode=alpha]
[eval exp="f.eriSaved=99"]
[eval exp="Debug.message('eri-save=changed:'+f.eriSaved)"][s]

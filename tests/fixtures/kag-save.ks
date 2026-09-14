[eval exp="f.saved=7"]
*checkpoint|Checkpoint
[cm][nowait]Saved checkpoint[eval exp="Debug.message('save=ready:'+f.saved)"][s]
*changed
[eval exp="f.saved=99"][cm]Changed[eval exp="Debug.message('save=changed:'+f.saved)"][s]

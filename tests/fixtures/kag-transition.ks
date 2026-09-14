[cm][nowait]Before
[iscript]
kag.back.base.fillRect(0,0,640,480,0xff0000ff);
[endscript]
[trans method=crossfade time=100][wt]
[eval exp="Debug.message('transition=crossfade:'+kag.fore.base.getMainPixel(0,0))"]
[iscript]
kag.back.base.fillRect(0,0,640,480,0xff00ff00);
[endscript]
[trans method=scroll from=left stay=nostay time=100][wt]
[eval exp="Debug.message('transition=scroll:'+kag.fore.base.getMainPixel(0,0))"]
[iscript]
kag.back.base.fillRect(0,0,640,480,0xffff0000);
[endscript]
[trans method=universal time=100 rule=verification-rule.bmp vague=0][wt]
[eval exp="Debug.message('transition=universal:'+kag.fore.base.getMainPixel(0,0))"]
[cm][nowait]After[eval exp="Debug.message('transition=done')"][s]

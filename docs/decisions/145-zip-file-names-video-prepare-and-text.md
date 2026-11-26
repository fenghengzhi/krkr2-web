# 第 145 批旧 ZIP 文件名、影片准备和文字显示

## 按原名打开章节和存档

部分旧发行包直接把日文或中文编码的字节写入 ZIP 文件名。按 CP437 读取这些字节后，游戏脚本可能找不到指定章节、图像或存档。现在可在导入前选择 Shift_JIS、GBK、Big5 或未标记的 UTF-8。默认值仍是 CP437。带 UTF-8 标志的条目直接按 UTF-8 读取，Unicode Path 扩展字段的原名 CRC 匹配时采用字段中的名称。[ZIP 格式说明](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) · [字符编码](https://encoding.spec.whatwg.org/#names-and-labels)

播放器先解码文件名，再解释目录分隔符。日文的 `ソ` 和 `表` 在 Shift_JIS 中的第二个字节都是 `0x5c`。例如名为 `ソ` 的无扩展名文件现在可以作为文件打开，`表/ソ.kdt` 也能保留完整的目录名和文件名。用例覆盖两种挂载方式、五种编码、UTF-8 标志、有效及失效的 Unicode 扩展字段，以及重名存档的处理。[文件名解码](../../src/backends/files/zip-names.ts) · [归档索引](../../src/formats/zip/archive.ts) · [格式和存档验收](../../tests/conformance/legacy-zip-names.test.ts)

选择对当前会话内打开的 ZIP、游戏发行包以及从游戏库重开都生效。原有游戏库记录按 CP437 打开。切换编码后，如果实际项目路径仍相同，就继续使用同一组存档。导出的原版存档 ZIP 写入 UTF-8 文件名标志。导入外部存档 ZIP 可以沿用当前游戏的编码，也可以为该次导入另选一种。会话协议升至 52。[会话挂载](../../src/workers/session.worker.ts) · [游戏库保存](../../src/player/library/service.ts) · [浏览器章节和存档验收](../../tests/browser/legacy-zip-names.spec.ts)

游戏库用例把原版 KAG 模板放在 `ソ/` 目录里，从包内另一份 ZIP 跳转到 `表.ks`，并读取外层的 `表.txt`。玩家选择剧情后保存槽位，将当前进度改掉，再从库中重新启动并点击读档。验收核对文件原名、屏幕对白和槽位字节，也检查下一次导入的编码设置不会改动已保存游戏的选择。[日文发行包游戏库验收](../../tests/library-browser/legacy-zip-names.spec.ts)

## 字幕下划线的可见范围

绘制系统字体时，如果字体上升部很高，下划线可能低于当前字形的下缘。此前临时画布按字符墨迹和字号分配，可能裁掉线条。现在先计算下划线和删除线实际占用的矩形，再为旋转和阴影分配画布。用例使用特意加高上升部的字体，在较大参考画布上逐像素核对 64 种组合。另有游戏字幕用例保存玩家每次点击后的窗口截图。[文字绘图](../../src/backends/text/browser/graphics.ts) · [字幕点击验收](../../tests/browser/text-decoration.spec.ts)

## 图层影片的准备帧

游戏用 `VideoOverlay.prepare()` 把过场的第一幅画面放到图层上。原版在图层模式里先暂停、回到片头并启动播放；调用返回时游戏可以观察到播放状态。解码器送来实际画面后，原版先把像素交给两个绑定图层，调用 `onFrameUpdate`，再调用 `onPeriod(perPrepare)`，随后暂停并回到片头。[原版准备入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L462-L471) · [帧与回调顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L721-L751)

Web 播放器把解码器实际提交的帧与本次准备操作对应起来。游戏在回调里继续播放、重开或关闭影片时，后续动作会检查对象当前的状态。脚本禁用事件期间，内部仍能完成准备。该帧的即时脚本回调依原规则跳过，已经排队的普通事件和连续通知留到恢复后处理。浏览器用游戏按钮切换到蓝色画面再准备片头，核对两层像素、回调顺序、最终播放位置及关闭后的资源。本批的原版行为依据是固定版本的 Windows 源码，浏览器实测等待托管报告。[视频会话](../../src/engine/media/videos.ts) · [事件调度](../../src/engine/scheduler/system-events.ts) · [实际影片验收](../../tests/browser/video-prepare.spec.ts)

## 已取回的托管结果

本批新增 18 个 Node 用例（7 个 ZIP、3 个事件调度、8 个影片准备），每个浏览器项目新增 13 个常规用例和 4 个游戏库用例。

原版介绍游戏和图层影片有各自的验收。第 134 批的过场超时发生在第 141 批的首帧与定位改动之前；该次运行不能验证后来的实现。

第 134 批已经结束，记录为失败。Firefox 和 WebKit 的常规浏览器报告合计 2,132 项通过、72 项失败、2 项跳过。该批新增的发行包音乐和 MIDI 音量组合 16/16 通过。Chromium 常规浏览器原件下载失败，三浏览器的兼容、游戏库和 PWA 仍分别按此前取回的报告统计。Node 为 4,066 项通过、4 项图层断言失败。第 135 至 144 批在这次取回时仍在队列中。[第 134 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45761489263)

介绍游戏的四项 Firefox 和 WebKit 路线都停在首次读取状态。测试传给 TJS 的分隔符写成了 JSON Unicode 转义，TJS 将其解释为普通文字，导致状态、排版和字体读数粘在一起，期望的 11 个字段被读成 46 个。本批改用 TJS 支持的十六进制转义，并保存原始读数，供下次核对实际游玩到了哪一步。[原版介绍游戏路线](../../tests/browser/kag-intro.spec.ts)

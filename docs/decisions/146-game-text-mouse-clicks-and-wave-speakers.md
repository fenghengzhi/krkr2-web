# 第 146 批游戏文字、选项点击和六声道音乐

## 旧版游戏的启动脚本与对白

同一串字节在不同编码下可能都合法。例如 `C3 A9` 按 UTF-8 读取是 `é`，按 Windows-1252 读取是 `Ã©`。有些汉化游戏连第一份 `startup.tjs` 都使用 GBK 或 Big5，游戏运行后再设置解码器已经太晚。原版 2.32 的文本流对普通窄字节文本调用运行环境的字符转换函数。[原版文本流](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/TextStream.cpp#L142-L160)

导入时可为无 BOM 的脚本与剧情选择 Shift_JIS、GBK、Big5、Windows-1252 或 UTF-8。自动模式继续先尝试 UTF-8，再尝试 Shift_JIS。选择在启动脚本第一次读取前生效，KAG 章节、TJS 文本读取和脚本编译共用该初始设置。有 BOM 的文本和 TJS 字节码按其格式读取，游戏也能通过已有的 `Scripts.textEncoding` 接口指定后续读取的编码。ZIP 成员名有独立的编码选项。[脚本字符转换](../../src/engine/script/text-encoding.ts) · [实际会话验收](../../tests/integration/scripts.test.ts)

游戏库记录启动时选择的编码。玩家更改载入表单或游戏在运行中切换解码器后，从库中重开仍使用原来的选择。旧库记录沿用自动模式。切换文字编码可以继续读取同一游戏的存档。[会话准备](../../src/workers/session.worker.ts) · [游戏库设置](../../src/player/library/records.ts)

浏览器用例用真实 GBK 字节写入开场脚本，在游戏选择任何解码器以前读取“中文”。游戏随后显式用 UTF-8 载入原版 KAG 模板，再进入 GBK 章节。游戏库路线实际点击选项、保存、改变剧情进度，刷新后从库中重开并点击读档，同时核对章节、进度和存档原始字节。[临时载入](../../tests/browser/script-encoding.spec.ts) · [游戏库与存读档](../../tests/library-browser/script-encoding.spec.ts)

## 选择按钮的点击和释放位置

原版窗口在普通单击回调中传入按下鼠标时的坐标，在释放回调中传入松开时的坐标。拖过两个按钮时，游戏脚本可以同时知道选中了哪个按钮以及鼠标最后停在哪里。本批让浏览器普通单击分别传递这两个位置。[原版窗口鼠标事件](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1779-L1786)

浏览器验收分别从左选项拖到右边、从右选项拖到左边，核对窗口与图层收到的坐标、回调顺序和最终选中的颜色。会话协议升至 53，页面和 Worker 可以在同一个释放事件中传递按下时保存的位置。[选项拖动验收](../../tests/browser/mouse-click-origin.spec.ts)

## 六声道背景音乐与对白

原版为没有扬声器标记的六声道音频指定了顺序。文件依次记录左前、中置、右前、左后、右后和低频，交给播放设备时会把它们重新排列。以前 Web 混音器直接采用文件顺序，写在中置的对白会偏到右侧。本批在 WAVE 解码时重新排列音轨，整段读入和分段读取共用转换。带标准 5.1 标记的 WAVE 保留文件声明的顺序。浏览器最终使用立体声输出。[原版六声道转换](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L1371-L1399) · [Web WAVE 解码](../../src/formats/audio/wav-format.ts)

声音验收在每个声道单独放入信号。浏览器通过游戏按钮播放十二个文件，比较带标准标记和无标记两组 WAVE 的实际左右声道样本。低频声道沿用现有 Web 立体声混音规则。验收中的音量系数取自 Web 混音器，Windows 设备的下混由其驱动决定。[音轨顺序与分段读取](../../tests/conformance/wave-speakers.test.ts) · [浏览器音频采样](../../tests/browser/wave-speakers.spec.ts)

## 已取回的托管结果

本批新增 13 个 Node 用例，每个浏览器项目新增 12 个常规用例和 4 个游戏库用例，执行结果留到下一轮取回。

第 134 批缺少的 Chromium 常规报告已取回。全部九份报告合计 3,220 项通过、87 项失败、2 项跳过。该批新增的发行包音乐和 MIDI 音量用例通过 24/24。原版介绍游戏的六条路线都因读取状态失败而中断，第 145 批修订了读数方式。[第 134 批托管结果](https://github.com/fenghengzhi/krkr2-web/actions/runs/45761489263)

第 135 批的 Node 报告记录了全部 4,090 项，4,084 项通过，6 项失败。该批新加的图层共享和 Wave 混音用例各通过 8/8。两项 KAG 宏参数用例因夹具调用 TJS Array 没有的 `indexOf` 方法而停下，本批改用原有的 `find` 方法。其余四项失败涉及图层像素。第 135 批在这次取回时仍有作业运行，以上结论对应已经取得的报告。[第 135 批托管结果](https://github.com/fenghengzhi/krkr2-web/actions/runs/45763956289)

同一提交的三浏览器 KAG 兼容用例通过 96/96，游戏库通过 69/69，PWA 通过 59/59。已发布的三份 Firefox 常规报告记录 811 项通过、26 项失败、1 项跳过，其余六份常规报告在取回时还未发布。本次取回的 42 份原始产物均已核对大小及 SHA-256。第 136 至 145 批在此次取回时仍处于队列中。

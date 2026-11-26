# 第 147 批补丁资源、剧情末尾和 MIDI 换曲

## 按游戏注册的顺序读取补丁

汉化补丁可能把原版的 `first.ks` 存成 `FIRST.KS`。原版引擎将归档成员和 Windows 文件路径中的 ASCII 大写字母转换为小写。直接路径没有对应文件时，它按注册顺序建立 AutoPath 文件名表，后注册的目录可替换先注册的同名章节。以前 Web 播放器有时会因为原文件恰好与请求拼写一致而读回原文。[原版 Windows 文件名](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/StorageImpl.cpp#L79-L92) · [原版归档成员名](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/StorageIntf.cpp#L603-L625) · [AutoPath 建表与搜索](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/StorageIntf.cpp#L1037-L1199)

Web 播放器在实际命中的目录里保留导入文件的拼写，因此脚本可以从 `Storages.getPlacedPath` 看出章节来自哪个包。如果同一个目录有两份仅大小写不同的文件，按精确名称仍可分别打开。使用第三种无法区分它们的拼写会收到歧义错误。以另一种 ASCII 大小写重复注册目录会保持原来的优先级，移除目录也接受大小写变体。[资源解析](../../src/engine/storage/resolver.ts) · [归档、存档覆盖及同目录重名验收](../../tests/conformance/lazy-archives.test.ts)

同一段 TJS 分别交给 Windows 原版、Web 源码会话和 Web 字节码会话执行。它按次序注册原目录、散装更新目录和压缩 XP3，记录九次实际读到的章节内容。原版 KAG 浏览器用例从大写成员名的补丁启动，核对章节、脚本、渲染像素及游戏库重开结果。[共享输入](../../tests/helpers/patch-case.ts) · [Windows 对照](../../tests/probes/player-config-sdk.ts) · [原版 KAG 浏览器用例](../../tests/browser/archive-patch.spec.ts)

散装目录使用播放器的“选择文件夹”载入真实文件。验收记录浏览器提供的相对路径，并在移除、重新注册补丁后核对游戏读取的 TJS 数值和画布像素。[真实目录导入](../../tests/browser/autopath-directory.spec.ts)

## 读完剧情后保留最后一个选项

KAG 解析器复用一个字典交付标签。游戏可以读取最后一行的选项，在下一次调用返回 `void` 后使用其标题和跳转目标。原版进入 `getNextTag` 时先检查是否已经到达文件末尾。如果还有内容需要解析，才清理上次的字典。本批修正从文件末尾再次取标签时的行为。[原版解析入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L1383-L1426)

原版模板的浏览器验收从单独的菜单文件读取最后一个选项，随后显示它的名称，玩家点击后须进入该选项指定的章节。Windows 与 Web 的共享用例还区分直接到达末尾、解析空白行后到达末尾和语法错误。[菜单点击](../../tests/browser/kag-eof.spec.ts) · [解析器对照](../../tests/helpers/kag-eof.ts)

旧标签字段中可能装有带析构回调的脚本对象。清理时，回调需要看到推进之前的剧情位置。为保持这个顺序，进入有效解析时多一次虚拟机与宿主的往返。已经到达末尾时直接返回。共享对照还会记录析构回调读到的行列，以及它请求中断后得到的标签。[解析流程](../../src/engine/kag/parser.ts)

## 换曲失败时的 MIDI 播放状态

游戏切换背景音乐时，原版先打开新文件，然后停止旧曲并读取 MIDI 曲目。若找不到新文件，旧曲继续播放。若文件已经打开但 MIDI 数据无效，对象转入 `unload`。换曲时正在进行的音量渐变仍属于声音对象。本批为这三条路径分别保留播放和回调状态。[原版 MIDI 打开顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L828-L906) · [实际声音会话验收](../../tests/integration/midi-reopen.test.ts)

浏览器用游戏按钮尝试缺失的歌曲、打开有效的新曲、打开无效文件并恢复播放，采集混音器输出，区分旧曲的 440 Hz 音符、新曲的 880 Hz 音符和静音。原版 SDK 单独记录公开的状态、音量和渐变通知。[浏览器播放验收](../../tests/browser/midi-reopen.spec.ts) · [原版状态对照](../../tests/probes/midi-sdk.ts)

## 已取回的验证

本批新增 12 个 Node 用例，每个浏览器项目新增 12 个常规用例。已有的 XP3 补丁和鼠标键用例另行加强。新增测试和代码修订均等待本批托管执行。

第 135 批九份常规浏览器报告已取得八份，合计 2,985 项通过、81 项失败、2 项跳过。新增的共享图层画廊通过 12/12。音乐平滑循环在已取得的 Chromium 和 Firefox 报告中通过 8/8。WebKit 第四分片的原始报告下载返回 HTTP 503，备用地址返回 404，该分片没有可计入的测试结果。这一轮取回的五份原始产物共 160,207,701 字节，均已核对大小及 SHA-256。第 136 至 146 批在此次取回时仍在队列中。[第 135 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45763956289)

第 135 批 WebKit 的两项鼠标键用例中，一次在模拟手柄松开前光标已越过窗口边缘，另一次读取了已经从页面移除的光标元素。本批修订测试的松开和采样时机，继续检查真实窗口坐标、单击和按键释放。[鼠标键验收](../../tests/browser/mouse-key.spec.ts)

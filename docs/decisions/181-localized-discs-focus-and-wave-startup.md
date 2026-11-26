# 本地化游戏光盘、姓名输入与配乐起播

## 不同编码的 ZIP、CUE 与剧情

CUE 的 `FILE` 行要按制盘者使用的编码读出，否则即使镜像已经导入，播放器也可能找不到对应的 BIN。现在可单独选择无 BOM 的 CUE 编码，游戏库会记住这个设置，也可以在库中修改。光盘启动、运行时按盘符查找和换盘共用这项选择。带 UTF-8 或 UTF-16 字节序标记的 CUE 优先采用文件自己的编码。原有游戏库记录默认继续按 UTF-8、Shift_JIS 的顺序识别。[光盘选择](../../src/engine/storage/distribution.ts) · [游戏会话](../../src/engine/session.ts) · [库中设置](../../src/app/game-library.ts)

播放器的 ZIP 文件名、无 BOM 的脚本与剧情，以及 CUE 都可选择韩文 Windows-949 或西里尔字母 Windows-1251。这些是导入时的设置。Windows-949 包含传统 EUC-KR 以外的韩文音节，网页和无界面运行时使用同一份 WHATWG 索引。托管用例将全部双字节组合与 Python 的 cp949 解码器对照，并通过真实 TJS 读取启动脚本、剧情、文本文件和编译后的表达式。[WHATWG 编码标准](https://encoding.spec.whatwg.org/#euc-kr) · [韩文解码](../../src/backends/files/text-decoder.ts) · [独立字节对照](../../tests/conformance/windows-korean-text.test.ts) · [脚本验收](../../tests/integration/scripts.test.ts)

游戏库验收使用两份 ZIP，一份用韩文文件名收录西里尔编码的 CUE，另一份反过来。每张盘的游戏都在对应 BIN 中。用例从原版 KAG 启动，进入分支、保存章节，再更改进度。刷新后在游戏库中编辑并恢复 CUE 设置，然后检查同一游戏身份、书签字节和读回的剧情。[托管游戏库验收](../../tests/library-browser/disc-boot.spec.ts)

## 姓名框取得焦点后才能继续

原版 `Layer.focus()` 返回一个整数，游戏可据此决定是否接受输入。此前网页端已移动焦点，但丢掉了返回值，正常的确认按钮可能一直无法使用。本批保留返回值，并按原版区分省略方向参数和显式传入假值。托管对照覆盖成功、已经聚焦、隐藏或禁用的目标，以及游戏把焦点重定向到另一个图层的情况。原版 KAG 游戏验收通过姓名框输入文字，按 Tab 转到确认，保存、更改姓名，再重启读档。[图层脚本接口](../../src/engine/tvp/layer.ts) · [游戏内姓名验收](../../tests/browser/kag-name-focus.spec.ts)

## 普通 Wave 起播与重播

普通流式 Wave 播放先从当前起点准备四个约 125 毫秒的单元，再确认 Play。播放期间按约一秒的范围预读，并遵守每个声部已有的缓存和并发读页上限。这样在下一批数据暂时未到时，混音器还能继续使用准备好的采样。暂停、停止、定位和自然结束后的重播均有单独检查。带 SLI 跳转或滤镜的声部沿用原有读取方式。[混音器](../../src/engine/media/mixer.ts) · [延迟读取与逐采样验收](../../tests/conformance/audio-source-play.test.ts)

第 171 批的一份 WebKit 录音在下一首曲目第 24,574 个采样附近出现了 7,938 帧静音。原始记录显示该处接近分页边界，但未记录相应数据何时发回混音器，不能据此认定这段静音的唯一成因。新旧录音分别保留。[第 171 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320)

## 本次取回的托管结果

第 172 批 Chromium 游戏库完整报告为 **110/110 通过**。按项目、文件和用例名与第 171 批逐项对照，此前 36 项失败全部转为通过，涵盖光盘绑定、光盘启动与分支、运行中换盘、远端游戏库下载恢复和存档迁移。该批独立图片对照也取得了两组 PNG 各 30 项和 JPEG 43 项匹配。以上是各自用例的结果。[第 172 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217)

第 172 批 Node 作业被取消，TAP 只记录了前 14 项通过，没有总数。新批次把区域编码、游戏盘启动、焦点与声音的部分回归放进同一次 GitHub-hosted Actions 运行中的独立作业，单独保留 TAP。完整 Node 与浏览器套件仍分别记录。取回时，GitHub 对后续批次的一次产物列表请求返回 403，公开工作流列表显示第 173 至 180 批仍在排队。[托管工作流](../../.github/workflows/test.yml) · [第 180 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45878405974)

第 181 批实现提交 `bbfd04b` 登记时为 `pending`，下一批取回结果。[第 181 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45880484737)

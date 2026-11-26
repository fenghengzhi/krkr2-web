# 日文游戏光盘、淡出效果与 MIDI 叠音

## 读取普通 ISO 的目录和卷标

以前，普通 ISO 的一个高位字节文件名就可能使整层目录无法列出，从而挡住同目录下的启动脚本。Windows CDFS 会按系统 OEM 代码页解码主目录的文件名和卷标。网页播放器现在可在导入时独立选择这项编码，启动、按盘符取文件、换盘和游戏库重开都沿用它。例如，日文 Shift_JIS 的“表”由 `95 5C` 两个字节组成。播放器先解码完整文件名，再判断路径分隔符。[Windows CDFS 文件名转换](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/cdfs/dirsup.c) · [Windows CDFS 卷标转换](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/cdfs/fsctrl.c) · [ISO 读取](../../src/formats/disc/filesystem.ts)

光盘编码默认 CP437。CP850、CP866、Windows-1252 等也可用于未标记编码的 ZIP 文件名。Joliet 与 UDF 仍优先使用盘上记录的 Unicode 名称。光盘文件名、CUE 引用、脚本和 ZIP 文件名可分别选择编码。选定的光盘编码随游戏库记录保存。[编码选项](../../src/formats/text/legacy-names.ts) · [库记录](../../src/player/library/records.ts)

托管验收使用含原版 KAG 的独立制盘素材，主目录中包含“表Game”和“表/表.ks”，卷标是“KRKR_表”。用例检查原始目录记录、路径表、实际取出的文件字节和卷标。在游戏中走到章节 42 并保存，再改到 99。刷新后用库中保存的设置重新启动，并核对读回的章节和存档字节。[制盘与独立读回](../../scripts/generate-oem-game-disc.py) · [游戏库验收](../../tests/library-browser/disc-boot.spec.ts)

## 淡出到零后继续剧情

有些游戏用固定步长递减 `Layer.colorRect` 的不透明度，最后一帧可能越过零。原版在不透明绘图面上把负值按零处理，像素保持原值，绘图标志仍更新。此前网页端在这一步抛出异常，现在淡出可以结束，玩家可以继续读下一页。验收检查中间帧、最终画面以及继续按钮触发的下一章。[位图操作](../../src/engine/graphics/bitmap.ts) · [浏览器剧情验收](../../tests/browser/layer-color-opacity.spec.ts)

## 释放同通道的重叠音符

同一 MIDI 通道连续奏响同一音高时，以前一次 Note Off 只结束最早的一声，剩余音符可能持续响。现在该通道上仍按住的同音都会松开，延音踏板控制它们何时进入释放阶段。其他音高和通道继续播放。重复松键、All Notes Off 或控制器重置都会保留已有尾音的释放起点。托管用例将实际乐谱和独立分轨参考比较，并录取浏览器输出、检查应该消失和继续发声的音高。[微软合成器的 Note Off](https://github.com/microsoft/MIDI/blob/4db4520bd0e95ed224bb4458ad810091df783aac/src/in-box/Libs/MidiSynthLib/SynthEngine.cpp#L1113) · [游戏播放验收](../../tests/browser/midi-channel-mode.spec.ts)

## 本次取回的托管结果

第 173 批 Chromium 游戏库完整报告为 **106 项通过、4 项失败**。三个用例在原版 KAG 保存后返回同名章节时读到了上一次的访问次数，另一个在链接宽度可用前读取了坐标。归档保留原始失败。本批让章节、访问次数和呈现文本在同一次观察中满足原预期，并等目标链接实际有尺寸后点击。书签字节、恢复后的进度和真实点击仍需分别通过。[第 173 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259) · [KAG 点击验收](../../tests/helpers/kag-game-controls.ts)

第 173 批 Firefox 和 WebKit 的原版 KAG 与发布兼容用例各有 32 项通过，连同 Chromium 共 96 项通过。Node 作业被取消，只记录到 11 项通过，没有套件总数。取回时第 174 至 183 批仍在排队。[第 173 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259) · [第 183 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45885531653)

第 184 批实现提交 `026ceca` 登记时为 `pending`，结果留到下一批取回。[第 184 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45887151151)

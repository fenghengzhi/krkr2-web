# 第 179 批旧过场、命名书签和 MIDI 鼓轨

## Windows Media 9 过场

游戏用 `VideoOverlay.open` 打开 WMV 或 ASF 时，原有转换器能解 WMV 7、8。本批加入 Windows Media Video 9（WMV3）、VC-1 Advanced Profile（WVC1）和 Windows Media Audio Professional。转换在独立 Worker 中进行，播放、定位、声音和图层输出沿用现有的游戏接口。[转换器配方](../../scripts/build-legacy-media.mjs) · [微软视频编码器格式](https://learn.microsoft.com/en-us/windows/win32/medfound/windowsmediavideo9encoder) · [微软音频编码器格式](https://learn.microsoft.com/en-us/windows/win32/medfound/windowsmediaaudioencoder)

托管 Windows 用系统 Media Foundation 写出两段四秒钟的原片，分别是 WMV3 配标准 WMA，以及 WVC1 配 WMA Professional。每段有 100 个画面编号、三种背景色、一段静音和三个连续的音高。Linux 读回 Windows 的原件，核对文件散列值、实际编码、全部画面编号、呈现时间和声音。独立作业再用当批生成的 WASM 转换，并用系统 FFmpeg 解码输出的 MP4。浏览器验收由 TJS 游戏按钮执行准备、播放、暂停、定位和停止，检查两个图层及实际声音输出。[Windows 制片](../../tests/native/author-windows-media.cpp) · [独立解码](../../scripts/generate-legacy-video-fixtures.mjs) · [完整 MP4 对照](../../tests/conformance/legacy-media.test.ts) · [游戏内过场验收](../../tests/browser/legacy-video.spec.ts)

## 旧 QuickTime 与 MPEG-4 Part 2

相同的 `.mov` 或 `.mp4` 后缀可以装入不同的视频编码。播放器现在从每条音视频轨的样本描述表识别旧编码。遇到 QuickTime Animation 或 MPEG-4 Part 2 等已接入转换器的画面时，它用同一份原始数据转换，再从转换后的影片读取时间轴。普通 AVC/AAC 影片继续直接播放。混有转换器不支持的音视频样本描述时，保留浏览器的原有打开路径。若转换超出预算或失败，仍会尝试原片。关闭或替换影片会取消正在进行的转换。[容器内样本描述](../../src/formats/video/mp4.ts) · [编码选择](../../src/backends/video/legacy/format.ts) · [媒体准备与取消](../../src/backends/video/port-backend.ts)

验收使用带大端 PCM 的 QuickTime Animation 和带 AAC、B 帧的 MPEG-4 Part 2，并检查改成 AVI 后缀的原片仍按真实编码处理。另用正常 H.264 影片核对，无关数据区中的编码名称不会改变播放路径。[文件选择与回退验收](../../tests/conformance/legacy-video-port.test.ts)

## 在游戏里双击命名书签

原版 KAG 启用自由存档文件名后，玩家可以用“读入”菜单选择书签。此前双击列表中的文件只会填写文件名，还需再按一次打开。现在双击会调用文件对话框已有的确认逻辑。保存时双击同名文件仍需确认覆盖。托管验收通过原版菜单创建日文文件名的书签，改变进度，分别检查取消覆盖、确认覆盖、双击读回，以及刷新后从该章节继续游玩。[文件对话框](../../src/app/storage-selector-view.ts) · [原版 KAG 命名书签验收](../../tests/browser/kag-named-bookmarks.spec.ts)

## GS 乐谱把乐句交给鼓轨

游戏 MIDI 乐谱可以在 GS Reset 之后指定某个声部改用打击乐。播放器现在按对应通道路由之后按下的音符，已发出的音符保留发声时的乐器类型。验收包含完整和分段送达的系统消息、恢复旋律声部、定位、同曲重播，以及游戏按钮触发后的实际左右声道采样。本批沿用播放器已有的合成音色。[合成器](../../src/engine/media/midi-synth.ts) · [微软 GS 通道分配](https://github.com/microsoft/MIDI/blob/4db4520bd0e95ed224bb4458ad810091df783aac/src/in-box/Libs/MidiSynthLib/UmpDispatcher.cpp#L1576) · [游戏按钮与音频验收](../../tests/browser/midi-rhythm.spec.ts)

## 本次取回的托管结果

第 171 批新取得六份普通浏览器报告，其中 1,943 项通过、333 项失败、1 项跳过。取消的作业另留有 661 项未报告，Firefox 第 1 分片的产物也未能取得。WebKit 的 Asyncify 后端已经跑通原版 Introduction 第二条路线，同一分片取消前尚未报告该路线的 JSPI 结果。取回时第 171 批仍有一个作业在运行，第 172 至 178 批均在排队。[第 171 批托管记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320) · [第 178 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45873527327)

Chromium 的明朝字体记录显示，同一可用字体用普通 CSS 字体族和用 `local()` 别名加载时，字宽与像素可能不同。本批调整测试的参考来源，按普通字体族逐字节比较，另保留别名对照。同时记录真实画布收到的候选顺序，用两种已知宽度的字体核对首选缺失时的选择。[字体选择验收](../../tests/browser/font-backend.spec.ts)

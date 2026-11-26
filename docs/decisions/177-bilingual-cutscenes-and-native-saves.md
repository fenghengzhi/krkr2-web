# 第 177 批双语过场、大型 AVI 与原版存档

## 双语过场的两条声音

此前影片转换器能读取 MPEG-2 画面，但没有编入 AC-3 和 DVD LPCM 解码器。游戏通过 `VideoOverlay.open` 打开带这类音轨的 MPEG 节目流时，转换会失败。本批接入两种解码器和 AC-3 音频帧解析器。两条音轨沿用容器中的顺序和共同的时间起点，转换后交给现有的 `selectAudioStream` 和 `enabledAudioStream` 选择。[解码器构建](../../scripts/build-legacy-media.mjs) · [FFmpeg 的 MPEG 子流识别](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/libavformat/mpeg.c#L553)

托管制片将 440 Hz 与 880 Hz 分别写入 AC-3 和 DVD LPCM 的两个独立子流，前半秒静音。原片逐帧写入编号，系统 FFmpeg 独立识别两个子流并分别解出音频。转换后的 MP4 再对照两轨的静音、音调、100 帧画面编号和时间戳。游戏中的语言按钮在播放中切换声音，暂停后再换轨，验收读取视频元素和游戏画布上的同一帧。[制片与原片验证](../../scripts/generate-legacy-video-fixtures.mjs) · [转换结果](../../tests/conformance/legacy-media.test.ts) · [游戏内切换](../../tests/browser/video-audio-tracks.spec.ts)

## 大型未压缩 AVI

本地文件和可借用原始文件切片的资源，在独立 Worker 里通过 WORKERFS 分段读取。原先旧影片即使已有这些文件切片，输入也被统一限制到 128 MiB。本批把此路径接到播放器已有的 2 GiB 文件输入限额，并增加 Windows DIB 未压缩视频解码。需要在内存中拼出的输入、转换后的 MP4 和执行时限仍受原有预算约束。[读取与转换](../../src/backends/video/legacy/convert.ts) · [输入大小与文件类型](../../src/backends/video/legacy/module.ts) · [Emscripten WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html#workerfs)

托管验收制作 864 × 576、25 fps 的 AVI，使用 100 帧未压缩 BGR 画面和 PCM 音轨。独立解码检查每个画面编号，并确认第 96 帧的数据包确实位于文件的 128 MiB 之后。同一 AVI 还分别作为散装文件和 XP3 中的两个不相邻存储段送入播放器。XP3 对照把影片尾部放在开头之前，并在中间放入实际启动脚本，读取时必须遵循成员索引的逻辑顺序。游戏中的“Final scene”按钮跳到该帧，“Play”按钮从中段播放，再检查实际声音。[浏览器大影片验收](../../tests/browser/legacy-large-avi.spec.ts)

## 原版存档交接

在“存档与备份”中选择“原版游戏存档”并暂停游戏后，可以拖入存档目录、同一目录下的多个文件，或一份 ZIP。整个目录会保留相对路径，ZIP 仍由玩家选择要导入的目录。替换进度前，播放器先检查文件名、总大小和当前会话。同名文件沿用原有导入事务覆盖。游戏恢复或切换期间不会把尚在读取的存档写入另一个游戏。[存档入口](../../src/app/native-save-drop.ts) · [原版存档导入](../../src/player/native-saves.ts) · [原版 KAG 书签恢复](../../tests/library-browser/native-save-drop.spec.ts)

## 游戏选择的四声道配乐

部分游戏在配置文件中指定 `-wsexpandquad=yes`。本批为没有扬声器掩码的单声道和双声道 Wave 实现原版的声道复制，再按浏览器播放器的立体声输出混音。单声道复制到四个位置，双声道保持左到左、右到右。选项在首次创建 Wave 时确定，启用原版 3D 声音选项时会关闭这种扩展。验收分别核对整段与流式读取、SLI 循环和暂停定位，并与系统 FFmpeg 输出的四个声道及其立体声混音比对。会话协议升到 66。[原版 Wave 实现](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L1091) · [混音](../../src/engine/media/mixer.ts) · [独立声道对照](../../tests/probes/wave-speaker-mask-reference.ts)

## 多音轨影片的首帧

历史报告里出现过两种停顿。有的解码器已从头播放到尾，播放器一次也未收到真实的呈现回调。另一些已经收到首帧，暂停并定位回起点后才失去新的回调。本批保留原验收。在首帧恢复失败且暂存的视频仍可读取时，额外用同一份音轨选择后的影片分别比较透明和可见父元素下的首帧、暂停及定位。两个对照均记录真实图像的散列值、回调和媒体时钟。原因仍待托管结果确认。[首帧验收](../../tests/browser/video-first-frame-recovery.spec.ts) · [同片对照](../../tests/helpers/video-first-frame-controls.ts)

## 此次取回的托管结果

第 171 批新取得的 Chromium 游戏库报告中有 70 项通过、36 项失败。新增的四组注册表剧情全部通过，覆盖源码、字节码、XP3 内注册表和游戏库重开后的书签。36 个失败属于第 170 批已记录的 CD 音轨、光盘选择和存档剧情用例。Firefox 和 WebKit 离线验收分别通过 22、21 项。三个浏览器的原版 KAG 与发行版兼容验收均为 32/32。取回时第 171 批仍在运行，第 172 至 176 批尚无作业结果。[游戏库](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320/job/140066632622) · [Firefox 离线](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320/job/140066632589) · [WebKit 离线](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320/job/140066632565) · [第 171 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320)

第 177 批实现提交 `74d2e5d` 登记时为 `pending`，下一批取回结果。[第 177 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45870448777)

登记后收紧了首帧对照附件的两个条件，仅当原播放断言已经失败时才启用对照，异步取得文件后再次确认视频还未提交。这两处测试改动随下一批验证。

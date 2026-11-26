# 第 161 批多盘配乐、AIFF 音轨、WAVE 读取与 KAG 选项

## 让游戏选到正确的光盘和曲目

玩家可以在启动游戏前填写「CD 音轨映射」，也可以在游戏库里修改某个游戏的启动设置。每行对应一张光盘，例如 `D=disc1.cue` 和 `E=disc2.cue`。路径相对游戏工作目录，游戏通过 `CDDASoundBuffer.open("E:2")` 播放 E 盘第二轨。省略盘符时使用映射中的第一张盘。留空时播放器继续自动识别唯一的 CUE，旧游戏库记录也按原方式打开。已存游戏在下次启动时采用新设置。[播放器设置](../../src/app/cdda-settings.ts) · [游戏库记录](../../src/player/library/records.ts) · [双盘游戏库验收](../../tests/library-browser/cdda-discs.spec.ts)

CUE 以前已经接受 `FILE "disc.aiff" AIFF`，但播放时缺少对应解码器。现在 CD 播放器可以读取 AIFF 和 AIFF-C 中的整数 PCM，以及 AIFF-C 的 32/64 位浮点 PCM。播放器根据 COMM 块的采样帧数和 SSND 块的起始偏移读取声音，查曲目与跳转时按需读取文件范围。曲目仍以每秒 75 个 CD 帧的 INDEX 确定边界。[AIFF 格式规范](https://ich.music.mcgill.ca/classes/synth/AudioIFF1.2.1/AudioIFF1.2.1.html) · [Apple 声音样本编码](https://developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions) · [范围解码器](../../src/formats/audio/aiff-source.ts)

托管机器用 FFmpeg 把同一段双声道素材编码成四种文件，再逐一解码，并与原始 PCM 逐字节核对。Node 用例把播放器读出的每一帧与原始采样对照，另检查在 128 MiB 音轨中跳到结尾的读取范围。游戏验收从 XP3 启动，以按钮切换四条轨道，记录 AudioWorklet 的左右声道，分别判断每段配乐的频率。[独立素材生成](../../scripts/generate-cdda-aiff.mjs) · [采样对照](../../tests/conformance/cdda-aiff.test.ts) · [游戏按钮与声音验收](../../tests/browser/cdda-aiff.spec.ts)

## 普通 WAVE 读取游戏实际使用的音频块

旧音频工具有时会在写完语音或配乐后留下过期的 RIFF 总长度，或在文件后面附上另一段音频数据。原版 RIFF 读取器使用物理文件边界，先找第一个格式块，再从那里查找第一个数据块。本批把这套选择规则接入普通 `WaveSoundBuffer` 的缓冲解码和流式播放。实际选中的 PCM 数据仍须完整，播放、定位与 SLI 循环都使用同一段声音。[原版 RIFF 读取器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp#L562-L720) · [WAVE 布局读取](../../src/formats/audio/wav-native.ts) · [声音与循环验收](../../tests/browser/wave-riff-layout.spec.ts)

遇到奇数字节块时先按原版的跳转方式找音频。若这条路径找不到音频，播放器再按标准的偶数字节对齐查找，让原先已能播放的带填充 WAVE 继续使用。长静音用例同时限制打开时读取的字节量和调用次数。[填充与读取范围验收](../../tests/conformance/wave-riff-layout.test.ts)

## KAG 转发参数后写入脚本属性

游戏的 KAG 宏可以用 `*` 转发参数，再给其中一个同名字段赋值。如果这个字段有脚本定义的写入函数，原版会调用它。此前网页端可能用新值直接覆盖该属性。现在写入函数能接收实际的 TJS 值，按游戏逻辑更新选项标题、目的地或剧情变量。托管验收从原版 KAG 菜单点击动态生成的选项，保存章节，修改进度后重启并读回原槽位。[原版标签赋值](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L2226-L2240) · [Web 标签处理](../../src/engine/kag/parser.ts) · [选项与存档验收](../../tests/browser/kag-parameter-setters.spec.ts)

## 已取回的托管结果

第 159 批已结束。此前记录的 PKSFX 测试类型错误阻断应用构建，依赖它的 Node、浏览器与声音素材作业均已跳过。第 160 批已通过独立的测试与工具类型检查、应用类型检查与生产构建、离线测试资源构建。取回时仍在生成 Deflate64 夹具，尚无 Node 或主浏览器结果。[第 159 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45824742294) · [第 160 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404)

第 160 批原版图形对照为 124/124，原版 KAG 为 122/124，其中新增的五项宏参数读取对照全部匹配。Windows 声音对照中，停止态清空标志的观测已匹配，暂停态用例因托管机器没有声音驱动而未取得观测。本批新取回 29 份普通归档，共 61,939,968 字节，另复用 20 份已校验原件。[第 160 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404)

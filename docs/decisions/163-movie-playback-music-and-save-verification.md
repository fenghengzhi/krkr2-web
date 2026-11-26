# 第 163 批过场影片、配乐跳转与原版读档验收

## 游戏里的影片

游戏现在可以通过原有的 `VideoOverlay.open` 打开带 MP2 声音的 MPEG-2 节目流，以及带 MP3 声音、使用 XVID 编码标记的 MPEG-4 Part 2 AVI。固定版本的 FFmpeg WASM 负责解码，原来的播放、定位和双图层显示使用转换后的 MP4。验收范围是这些容器和编码组合。[转换器配置](../../scripts/build-legacy-media.mjs) · [FFmpeg 对 AVI 编码标记的定义](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/libavformat/riff.c)

托管 FFmpeg 独立写出两段各 100 帧的影片。MPEG-2 素材包含重排的 B 帧和延后约 0.3 秒的音轨，AVI 则封装独立编码的 MP3。素材验收逐帧检查画面编号、颜色，另外从解码音频检查静音和三个已知频率。Node 将实际 WASM 输出的 100 个帧时间与独立解码结果比较。浏览器从游戏的按钮播放和定位，检查双图层读回与实际声音。[独立素材生成](../../scripts/generate-legacy-video-fixtures.mjs) · [转换后的时间轴](../../tests/conformance/legacy-media.test.ts) · [游戏内播放](../../tests/browser/legacy-video.spec.ts)

第 160 批的影片回调验收在未绑定输出图层时收不到回调。原版在此处也直接返回。修订后的用例先检查未绑定的行为，再绑定图层并比较每次回调的参数和公开时钟。原版允许渲染器的编号与时钟相差一帧，因此在时钟为 0 时，游戏可能收到 `onFrameUpdate(-1)`。现在网页端保留这个编号，无索引画面仍可完成 `prepare()`。另外，重开影片的测试游戏在脚本内捕获打开失败，随后检查成功重开所保留的剧情提示帧。[原版帧更新逻辑](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L679-L751) · [脚本分发](../../src/engine/tvp/video.ts) · [回调验收](../../tests/integration/video-frame-update.test.ts) · [提示帧与重开](../../tests/integration/video-period.test.ts)

## 配乐跳转后的静音

第 160 批的长 Ogg 游戏验收在源码和字节码下都出现同一段静音。跳转后的 960 个采样中，前 503 个与顺序解码完全相同，后 457 个为零。播放器原先在跳转时只请求目标位置的两个采样，第一段输出刚好跨过尚未读入的 PCM 页。现在播放和定位都会预读后续页。接近已选中的 SLI 跳转或整曲循环点时，也会预读目标处的页。每个声部最多同时请求四页，剧情标签和标志仍在播放到相应采样时才生效。[混音器](../../src/engine/media/mixer.ts) · [逐样本与循环对照](../../tests/conformance/audio-stream-mixer.test.ts) · [真实配乐跳转](../../tests/browser/long-vorbis.spec.ts)

## 图形、输入与存档

游戏字体、对白、字幕和图层混合的 Node 整帧验收现使用游戏自己可选的 CPU 绘制设备取得合成图，再比较完整像素。浏览器继续使用默认图形后端。其余修订包括让按钮用例正确初始化原版 `Window`，让无窗口启动的测试游戏持续运行，以及在测试脚本中捕获预期的绘制错误后检查原画面。对全覆盖预渲染文字的像素预期使用原版已观测的 255/256 混合权重。[整帧读回](../../tests/helpers/software-frame.ts) · [按钮游戏](../../tests/helpers/mouse-button-choice.ts) · [字形颜色验收](../../tests/integration/layer-assign-images-font.test.ts)

第 160 批已生成两份 Web 存档，但 Node 总作业取消后，原版读档作业被跳过。现在 Windows 托管作业直接取本次发布的 WASM 构建，用源码会话和字节码会话各生成一个带缩略图的游戏存档，再交给原版 KRKR2 验证像素、宏参数和剧情返回位置。Linux 总套件继续产生自身的观测。两份 ZIP、哈希清单和原版读档记录均可追溯到同一提交。[存档导出](../../tests/integration/native-saves.test.ts) · [原版读回](../../tests/probes/native-save-transfer.ts) · [工作流](../../.github/workflows/test.yml)

ZIP 的读取检查现在按实际返回的文件名选取非空数据，保留 CRC 失败断言。XP3 停止扫描的检查在读取挂起时记录已经发生的 I/O，随后分别检查停止及已有读取返回后有无新增 I/O。[ZIP 成员读取](../../tests/conformance/video-resource-source.test.ts) · [XP3 扫描](../../tests/integration/xp3-embedded.test.ts)

## 已取回的结果

第 160 批 Node 作业被取消，TAP 没有完整结尾。逐项记录中，4,409 个已登记定义有 4,368 个通过、37 个失败、4 个未报告完成。4 个未完成项涉及分卷 ZIP 和 KAG。文件级结果另行保存。相同提交的 WMV1 和 WMV2 转换均已通过独立时间轴比较。第 160 批主浏览器分片取回时仍无新报告。第 161、162 批取回时均为 `pending`，尚无作业结果。此批新取得 1 份普通 Node 原件，复用 43 份，其大小和 SHA-256 均已核对。[第 160 批 Node](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938355839) · [第 161 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45831107660) · [第 162 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45832905859)

第 163 批实现提交 `7f7ab580fdb0ea698f5562240f5d11e2f43a0892` 登记时为 `pending`。运行结果在下一批取回。[第 163 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45834683767)

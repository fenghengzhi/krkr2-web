# 第 153 批剧情标签、影片调色与声音输出

## 剧情选项读取正在解析的标签

原版 KAG 解析器会复用同一个标签字典。处理一行标签时，它先写入标签名，然后依次写入属性。脚本若保存了这个字典的引用，后面的 `&` 表达式或 `cond` 就能读到前面已填入的字段，也能改写字段来决定接下来的剧情。此前 Web 将一整组属性写入字典的时间推迟到了求值之后，可能使原游戏选错对白或分支。[原版解析器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L1556-L1565)

此次修复使脚本能看到解析到当前属性时的字典。脚本新增、修改或删除的字段会影响后续解析，已写字段在后续属性出错时也可观察。原版 SDK 与 Web 共用一套 TJS 用例，检查读取顺序、脚本写入和异常时的部分结果。[属性解析](../../src/engine/kag/parser.ts) · [原版对照场景](../../tests/helpers/kag-live-tags.ts)

播放器验收用原 KAG 模板呈现动态选项。玩家点击选项进入分支 7，保存后切到分支 99，再用游戏的读档按钮回到分支 7。重新启动游戏后再次读档，检查同一游戏标识、原槽位字节和恢复的剧情。[实际菜单与存读档](../../tests/browser/kag-live-tags.spec.ts)

## 保留游戏菜单的图像与点击区域

游戏可以给 `Layer.hasImage` 和 `Layer.imageModified` 赋 TJS 实数或对象。原版对这两个属性直接取布尔值。以前 Web 先转整数，例如将 0.5 写入 `hasImage` 会删除已有位图和点击区域。现在该赋值会保留两张图，并按原版行为重置绘图裁剪。验收在实际菜单切换时检查颜色、点击区域的索引以及图像修改标记，同时覆盖数值、字符串、数组和字典的转换。[原版位图处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2017-L2050) · [图层属性](../../src/engine/tvp/layer.ts) · [菜单验收](../../tests/helpers/layer-paint-switches.ts)

## 游戏脚本里的过场画面设置

原版 `VideoOverlay` 给亮度、对比度、色相和饱和度各提供五个属性。游戏可以读取当前值、最小值、最大值、默认值和步长，用它们构造设置菜单。在没有打开影片时，这二十项读取都返回实数 −1。普通覆盖模式和图层模式沿用这个行为。原版混合模式则读取 VMR9 驱动提供的能力，在当前影片上设置数值。关闭并重新打开文件会创建新的播放图。[原版 TJS 接口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp#L1117-L1419) · [原版混合器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/krmovie/dsmixer.cpp#L494-L621)

Web 播放器为 `vomMixer` 提供以下范围。游戏写入后可以读回该步长对应的实数。超出范围的写入会报错，之前生效的设置继续使用。不同 Windows 显示驱动可以报告不同范围。[微软 VMR9 图像调整说明](https://learn.microsoft.com/en-us/previous-versions/ms788074(v=vs.85)) · [Web 取值与计算](../../src/engine/media/video-color.ts)

| TJS 属性 | 范围 | 默认 | 步长 |
| --- | ---: | ---: | ---: |
| `brightness` | −100 至 100 | 0 | 1 |
| `contrast` | 0 至 2 | 1 | 0.01 |
| `hue` | −180 至 180 度 | 0 | 1 |
| `saturation` | 0 至 2 | 1 | 0.01 |

浏览器先解码影片，再按标清 BT.601 的亮度权重计算调色。亮度改变黑电平，对比度调整亮度增益，色相和饱和度作用于色差分量。播放器随后按电影透明度叠加背景和游戏提供的混合图层，因此字幕可以保留自己的颜色。自定义反色光标也会读取调色后的画面。这里采用浏览器的软件颜色模型，具体显卡的解码色彩空间、舍入与显示输出仍可能有差异。[亮度和色差的定义](https://learn.microsoft.com/en-us/windows/win32/medfound/about-yuv-video) · [显示滤镜](../../src/backends/video/browser/color-filter.ts) · [光标采样](../../src/backends/input/cursor.ts)

浏览器验收通过游戏内按钮在暂停的同一帧上逐项调色，读取屏幕截图、原解码画面、背景和混合图层，再重开影片检查设置已复位。另有四项原版 Windows SDK 对照读取未打开影片时各属性的类型与数值，并检查范围只读和赋值的类型转换顺序。会话协议升至 56。[影片验收](../../tests/browser/video-colors.spec.ts) · [原版共用脚本](../../tests/helpers/video-colors.ts) · [反色光标验收](../../tests/browser/custom-cursor-composition.spec.ts)

## 采用游戏的 WAVE 输出设置

原版会在首次创建 `WaveSoundBuffer` 时读取 `-wsforcecnv`。设置为 `i16` 时，各个输入声道分别转为 16 位。设置为 `i16m` 时，立体声或多声道声音会合成为一个单声道输出。游戏第一次创建 WAVE 对象后再改变参数，会话中的后续 WAVE 对象继续使用首次读取的值。[原版选项与初始化](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L153-L160) · [原版 PCM 转换](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp#L104-L286)

播放器在处理 SLI 循环和滤镜之后应用转换，再进行播放采样率插值。单声道模式下，整数 PCM 先将每个声道缩减到 16 位再求平均。左右声道相反的声音会相消，只有一边发声的声音会在两边播出。浮点 PCM 的舍入按原版标量路径处理。验收分别检查不同格式的采样值与浏览器实际输出。[输出转换](../../src/engine/media/wave-output.ts) · [采样验收](../../tests/conformance/wave-output.test.ts)

对没有滤镜或平滑循环的 32 位整数 WAV，播放器在整文件读取和分段读取时都从原始样本保留高 16 位，避免先转成浮点数时舍入到相邻值。经过滤镜或平滑循环的声音仍使用现有 Float32 处理链。真实播放验收分别从启动脚本和发行包的 Output.cf 读取选项，录取左右声道的 440 Hz 和 880 Hz，在反相片段检查单声道相消，并覆盖暂停、恢复和重新打开。浮点临界值在旧 x86 SSE 路径上的舍入差异仍待对照。[真实声音验收](../../tests/browser/wave-output.spec.ts)

## 取回的托管结果

第 145、146 批的构建日志均已发布。此前播放器访问 `frame` 的 TS2339 已从这两份类型诊断中消失。两次构建都在 `tests/integration/video-prepare.test.ts` 第 211 行遇到 TS2367。测试已知迟到的事件是帧事件，却再次将它与错误事件比较。此次修复直接把当前轮次写入帧及其快照，保留了检查迟到帧不会影响下一次播放的断言。[第 145 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45783361496) · [第 146 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45785645939) · [修复的验收](../../tests/integration/video-prepare.test.ts)

第 145 批已结束，23 个作业成功、4 个失败、1 个取消、10 个跳过。第 146 批取回时为 23 个成功、3 个失败、10 个跳过、1 个仍在运行。两批的应用构建均失败，依赖构建的 Node 与浏览器验收均跳过。原版 KAG 对照各有 87/87 匹配，图形为 75/80，Windows 声音为 40/46，其余六项报告 DirectSound 不可用。145 的 Wine 作业在环境准备时取消，146 的 Wine 作业取回时尚在执行。配置对照仍缺原始进程观测。

本次新增 30 份普通原始归档，共 88,080,630 字节，均核对了大小与 SHA-256，另复用 19 份既有原件。第 147 至 152 批在此次快照中仍排队。第 152 批实现提交为 `dcaa83f`，其新增的旧影片和 ZIP 路线仍待托管实测。[第 152 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45804548247)

第 135 批 Chromium 的比例明朝字体用例仍有画面差异，整串文字的实际图像宽 164 像素，显式载入本机 Liberation Serif 的参照宽 162 像素。两者的可见字形也有差别。本批给原用例补充单字和整串的字体指标及像素哈希，帮助区分系统字体选择与整串排版的影响。原像素断言和原始失败继续保留。[字体报告采集](../../tests/browser/font-backend.spec.ts)

本批新增 12 项 Node 验收，每个常规浏览器项目新增 12 项剧情、声音和影片操作。原版 SDK 新增 6 项 KAG、2 项图层属性和 4 项未打开影片的对照。已有的菜单和光标用例也加入新的像素检查。以上均待托管实测。

第 153 批实现提交为 `05457856bc6513b631efa1c4ea26b4eb21af6046`。GitHub 已登记托管运行，登记时状态为 `pending`。结果在下一次运行时取回。[第 153 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45808179488)

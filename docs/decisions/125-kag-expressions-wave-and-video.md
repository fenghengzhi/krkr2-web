# 125　剧情表达式、WAVE 精度与暂停影片切轨

## 原版剧情与书签

原版 KAG 使用全局脚本环境求值条件、`cond`、以 `&` 开头的属性和 `emb`。Web 播放器此前把解析器实例传给求值器，脚本和解析器含有同名字段时，可能选错剧情分支或把变量写到错误的对象。本批恢复全局求值。宏的 `%参数` 仍取自活动宏，`onScript` 等通知仍交给原来的回调对象。新增的五组控制覆盖同名变量、表达式写入、宏、回调中再次解析以及跨文件书签恢复。[原版解析器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp) · [Web 解析器](../../src/engine/tvp/kag.ts) · [共享测试场景](../../tests/helpers/kag-evaluation.ts)

123 和 124 的 Windows 原版 KAG 对照都是 26/30。其余四组访问了 Web 提供的 `mp`，原版解析器在这些位置公开 `macroParams`。本批使用原属性并保留各场景原有的期望结果，再把新控制并入同一份 Windows、Session 与浏览器脚本。[原版书签对照](../../tests/probes/kag-sdk.ts)

124 的介绍样例准备步骤取得了固定 SHA-256 的原 XP3，尚未写出首个解包资源。原包首幅背景 `bgimage/_24.jpg` 的 `adlr` 是 `0x52f`，与路径字符值之和相同。格式允许这个字段作为存储标识，普通播放器不会对每个成员强制执行 Adler-32 内容校验。本批修正准备脚本中的额外限制，保留原包大小、SHA-256、解包边界和每个成员的 SHA-256。准备记录另存原字段、实际 Adler-32、阶段和异常。浏览器继续直接运行原 XP3。WebKit 有一次首个控制台读取在 5 秒断言结束时才返回，现将这一次读操作计入既有启动时限，后续剧情断言沿用各自时限。[原包准备](../../tests/probes/kag-intro-sdk.ts) · [游戏验收](../../tests/browser/kag-intro.spec.ts)

## 游戏音频

扩展 WAVE 的采样容器可以比实际有效位宽。两条 Web 解码路径共用格式解析和采样转换，识别完整的 PCM／IEEE 浮点子类型 GUID，按容器大小定位并按有效位数解释左对齐的整数。播放器能处理 16 位容器中的 12 位音频、24 位中的 20 位以及 32 位中的 24 位。仿照原版 RIFF 解码器报告的时长与实体 PCM 可读帧数分别保存，用于脚本查询和实际播放。100 毫秒的双声道 20-in-24 测试素材对应 4,800 个实际帧，其原版头部算法给出 120 毫秒。播放结束时不读取数据块后的内容。Web 原有的 64 位浮点支持继续作为扩展。[原版格式解析](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp#L621) · [共享解码](../../src/formats/audio/wav-format.ts)

Windows 原引擎新增四组实际打开文件的控制，检查三种有效位宽的采样率和伪装成 PCM 的其他 GUID。Session 检查左右声道的每个样本、自然停止和同一对象在打开失败后的恢复。浏览器验收覆盖源码、字节码、AudioWorklet 实际输出以及关闭 Worker。Worker 协议为 45。[Windows 原版对照](../../tests/probes/sli-sdk.ts) · [Session](../../tests/integration/wave-precision.test.ts) · [浏览器](../../tests/browser/wave-precision.spec.ts)

托管日志显示 123、124 的引擎类型检查找不到 `TextDecoder`，工具类型检查另有一处未先区分音频错误事件便读取标签。SLI 标签现在复用纯引擎的严格 UTF-8 解码。CUE 通过宿主的纯文本解码读取 UTF-16、UTF-8 或 Shift-JIS 元数据。查找可选 SLI 文件时只打开选中的伴随文件，避免为了一条音乐去整读无关的大文件。[SLI](../../src/formats/audio/sli.ts) · [CUE 编码测试](../../tests/conformance/cdda.test.ts)

## 影片切换与浏览器存储

Chromium 的两次暂停切轨失败均表现为候选影片已经完成定位，但仍只有首帧提交记录。播放主机现在先注册帧回调，再设置媒体时钟，以便接住暂停解码器在设置过程中提交的唯一新帧。完成切换仍须收到新增的提交记录并核对所请求的时钟。新增控制模拟这一时序，浏览器附件也保留原生注册与提交顺序。实际浏览器中的修复效果待复验。[时钟与帧提交](../../src/backends/video/browser/clock-seek.ts) · [时序测试](../../tests/conformance/video-clock-presentation.test.ts)

WebKit 的八个暂停切换音轨失败里，默认画布读回均有 129 个通道相差 1。七个场景在旧影片尚未切轨、重复绘制时便出现相同差异。生产层的 CPU 像素、游戏画布与视口截图在切换前后均匹配。验收改用与生产层一致的读回方式逐字节比较，并保留默认画布的原始采样和通道差异。Firefox 的相应用例改用表单 Enter，以便在测试页提交已经填好的脚本。WebKit 的文件拖放测试使用隔离的持久化浏览器配置，因为历史异常发生在获取 OPFS 根目录、进入产品枚举之前。[切轨与像素采样](../../tests/browser/video-audio-handoff.spec.ts) · [真实目录拖放](../../tests/browser/drop-capabilities.spec.ts)

## 已取回的托管结果

- 122 已终态失败。已报告的常规浏览器、库与离线用例共 2,848 项，其中 2,778 项通过、68 项失败、2 项跳过。WebKit 第四常规分片与兼容作业已取消。Node 有 3,861 项通过、40 项失败、2 项未报告。[122 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45482636479)
- 123 已终态失败，124 在本次取回时仍在运行，两批的主构建均已失败，应用验收跳过。两批各有 59 项 ERI 原版图像对照、8 项 MIDI 打开文件对照和 8 项 SLI 对照匹配。Windows 2022 与 2025 的窗口移动各 7 项都取得完整观察。[123 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45486961680) · [124 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45491545439)
- 本次三个运行共列出 103 份 ZIP，字节数与 SHA-256 全部匹配，总计 1,027,737,572 字节。历史失败、取消与未报告范围按提交保留。

本批实现提交 `c96145ec5f8e40a47592b1daadf3b6e406742c35` 已推送，首次登记时全套验证正在运行。下批取回 124 的剩余结果和本次验证，优先核实发布构建、原版 KAG 书签和介绍路线、游戏音频与暂停影片的整帧比较。[125 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45494717147)

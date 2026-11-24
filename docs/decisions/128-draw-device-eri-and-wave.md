# 第 128 批非插件游戏兼容

## ERI 有损背景与立绘

游戏通过 `Layer.loadImages` 打开 ERI 时，现在可以读取 DCT 变换的第 9 版图像帧。图像加载器沿用原有的尺寸通知、图像方向、透明色还原、伴随遮罩和缓存路径。解码器按宏块行重置直流预测，按频率读取分量，逆量化后先做列逆变换，再做行逆变换。4:4:4、4:2:2 和 4:1:1 按原布局还原色差。透明度有独立的四个分块。解码完成后才向调用方发布扫描行。[图像入口](../../src/formats/image/eri.ts) · [DCT 帧解码](../../src/formats/image/eri-dct.ts) · [ERINA 原版解码源](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/library/common/experi.cpp) · [ERINA 署名与分发条件](119-eri-png-and-hosted-codecs.md)

托管 Windows 作业 `original-eri-dct-reference` 单独运行 8 个原版对照。四个手工图样和一个伴随遮罩有独立的预期像素。另三个图样由固定 SHA-256 的作者工具 `ericvt.exe` 从 BMP 编码，使用三种采样、8／16／32 像素的变换块和 Gamma／Huffman 两种交流编码。对有损输出，基准是同一份 ERI 在原版 2.32r2 中解出的每个 RGBA 通道。作业保留原始 BMP、配置、ERI、原生像素和 Web 像素。另有独立分块的手工图样随 Node 和浏览器验收。任意编码器输出、x86 浮点舍入和原生独立分块的一致性仍需各自实测。[作者工具场景](../../tests/probes/eri-encoder.ts) · [逐像素比较](../../tests/probes/eri-sdk.ts) · [独立输入](../../tests/helpers/eri-dct-fixtures.ts)

## 声音的原始采样率

游戏脚本把 `WaveSoundBuffer.frequency` 设为零后，属性保留零，播放器按当前声音文件自己的采样率推进。两个同时打开的文件可以各自恢复原速。设置参数按原公共接口转为有符号 32 位整数。托管验收检查实际 PCM 样本、带 SLI 回环的采样位置、经过滤波的声音和浏览器听到的音调，并在同一原版 SDK 中记录属性变化。SLI／WAVE 对照由 28 项增至 29 项。[混音器](../../src/engine/media/mixer.ts) · [原版对照输入](../../tests/helpers/wave-frequency.ts) · [DirectSound 播放频率约定](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee418143(v=vs.85))

## 菜单确认框与绘图设备

发行样例通过 `Window.drawDevice` 为存读档确认窗口指定绘图方式。现在每个窗口拥有独立的默认 `Window.PassThroughDrawDevice`，脚本能保存对象引用、改变首选方式、替换设备并请求重绘。按原版约定，写入 `preferredDrawer` 后在下一次选取绘图方式时生效。Web 将 DrawDib／GDI 请求映射到 CPU 图层合成，自动模式及 DirectDraw／Direct3D 请求映射到现有的 WebGL 合成。两者都使用已有的浏览器输出画布。Win32 原生后端内部行为以及外部插件绘图接口仍在当前实现范围之外。介绍游戏的额外字体观察改为读取真实图层的 `font`，与原版提供的对象一致。记录游戏布局后，原版 Windows 还会在独立隐藏窗口检查默认对象、五个枚举值、首选值、替换以及清除后的对象有效性。[原版绘图设备](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/PassThroughDrawDevice.cpp) · [窗口和绘图设备](../../src/engine/scene/draw-devices.ts)

介绍游戏的验收使用发行包自己的 Save／Load 菜单，点击第一个书签槽和独立确认画布上的 Yes，再检查场景标签、背景像素和导出备份。重新载入浏览器后再走同一读档入口，最后继续游戏并退出。该路线尚待本批浏览器执行。[原版游戏验收](../../tests/browser/kag-intro.spec.ts)

## 上批托管结果

125 和 126 均已终态失败。125 主浏览器共有 3,034 项符合预期、113 项意外失败、2 项跳过。126 为 3,056、127、2。两个批次的原版介绍游戏路线在 Chromium 和 WebKit 的两个脚本后端均符合预期，Firefox 的失败仍在记录中。126 的影片验收在 Firefox 遇到启动就绪超时，WebKit 分别出现切换后的帧等待和逐像素差异。[125 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45494717147) · [126 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45497700733)

127 取回时有 18 项作业成功、1 项失败、7 项运行中，主构建尚未报告结论。Windows 原版的 KAG 42/42 与已有转场选项 21/21 匹配。介绍样例出现了三个链接，额外字体测量因脚本引用全局 `Font` 失败。SLI／WAVE 的 28 项中有 26 项匹配，两项播放观察因托管 Windows 缺少 DirectSound 设备而失败。透明转场对照有一项直接复制匹配，另外 80 项未报告，其中包括全部 64 个逐帧观察。本批在同一原生场景中保存每一处启动、取样和返回记录，并保留原像素、计时及可见性要求。[127 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45508747480) · [原生转场取样](../../tests/probes/transition-alpha-sdk.ts)

这轮共保存 132 份已发布的原 ZIP，逐份核对运行、提交、字节数与 SHA-256，共 1,855,220,844 字节。历史清单与报告位于本机证据目录 `out/verification/github-actions/128-review-archive-inventory.json` 和 `128-archive-summary.md`。本批结果在下一轮取回。

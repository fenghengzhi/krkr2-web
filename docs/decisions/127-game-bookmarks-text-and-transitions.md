# 127　原版书签、介绍游戏排版与透明图层

## 真实游戏与存读档

126 的 Windows 原引擎生成了书签，Web 的源码和字节码会话都成功读回，恢复了宏参数和调用栈，并继续到原来的结束位置。Windows 的 41 个剧本场景有 39 个匹配。两个差异都来自验证脚本用 `this === global` 判断表达式的变量作用域。原版和 Web 会产生相同的观察结果。现在直接让全局对象和解析器提供不同的同名字段，检查剧本实际读写了哪一个，并单独核对对象身份。浏览器菜单夹具和独立 KAG 探测也补上了原模板提供的 `mp` 宏参数入口。[剧本场景](../../tests/helpers/kag-evaluation.ts) · [原版及 Web 书签对照](../../tests/probes/kag-sdk.ts)

原版介绍游戏在 Windows 到达了三个可选链接，Firefox 在第三个链接出现前触发了自动分页。两边记录的图层尺寸、边距和当前字号一致。游戏默认启用粗体，标题使用 40 像素字号。此前系统字体通过 Canvas 直接测量粗体字形。原版测量每个普通字重的字符，再增加粗体间距。`getTextWidth` 按普通字体的字高决定增量，绘制下一字的位置按普通字宽决定增量。因此脚本报告的行宽可以与连续绘制时的位移不同。

Web 的系统字体路径现在分别计算这两个数值，以浏览器提供的普通字体度量作为输入，仍用游戏指定的粗体绘制。新增验收覆盖 24、40 和 96 像素字号。在介绍游戏停稳后，Windows 和浏览器各用一个临时隐藏图层测量标题与链接的 24／40 像素常规、粗体字宽。可用字体和字形取决于平台，介绍游戏能否显示第三个链接仍须以原包的实际路线验收为准。[原版字体测量与绘制](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp) · [字体后端](../../src/backends/text/browser/graphics.ts) · [介绍游戏验收](../../tests/browser/kag-intro.spec.ts)

## 画面转场

普通透明图层的淡入淡出根据新旧像素在当前帧各自的透明度，查询原引擎的颜色权重表。加算透明图层则直接混合四个存储通道，包括透明度为零时保留的发光颜色。带规则图的转场按原版阈值选择整像素复制或整数混合，并区分两种规则图内核写出的遮罩。这样游戏保存缩略图或组合多个图层时，可以保留低透明度下的原始颜色。显示阶段才把完成的图像转换为浏览器使用的像素格式。[原版转场](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/TransIntf.cpp) · [原版像素内核](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/tvpgl.c) · [Web 像素内核](../../src/engine/graphics/transition-blend.ts)

滚动转场现在复制新旧两块图像的可见矩形。纵向移动可以一次复制连续的完整像素行。四个方向和三种停留模式均检查实际像素与遮罩。[转场渲染](../../src/engine/graphics/transition.ts) · [场景合成验收](../../tests/conformance/composition.test.ts)

原版的 `piledCopy` 在两个条件同时成立时直接复制主图。第一，当前显示区域恰好覆盖整张主图。第二，没有同时可见且透明度大于零的直接子层。这时复制保留 RGB 和遮罩，也不会为此次复制触发绘制或转场时钟。窗口显示仍会推进转场。对于只作用于主图的转场，输入同样取自源层的主图，即使源层正在显示另一项转场。新的 Windows 对照同时记录直接拷贝与实际完成绘制的 64 个过渡帧。Web 端通过 TJS 源码、字节码和浏览器画布对照原始颜色与遮罩。[原版 Layer](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp) · [原版与 Web 的共享画面](../../tests/helpers/transition-alpha.ts)

对需要绘制子树的 `piledCopy`，完成前先生成最后一帧，然后交换图层并执行游戏的转场完成回调，最后将已生成的像素写入拷贝目标。验收在回调中同时修改源图与拷贝目标，检查脚本观察到的先后顺序及最终写入的像素。[转场末帧拷贝验收](../../tests/integration/piled-copy-completion.test.ts)

## 游戏声音与影片

音量渐变现在先转换和校验新请求的参数。非法请求会保留已有渐变，合法请求替换已有渐变时，原有完成回调仍可立即操作同一个声音对象。混音器按原目标计算每步变化，在实际写入音量时限幅。新增检查还覆盖延迟短渐变、完成事件和 PCM 样本。CDDA 验收改为启动前挂载磁盘资源，字节码写入游戏的可写存档目录。原有选轨、播放和停止断言继续执行。[原版声音渐变](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/SoundBufferBaseIntf.cpp) · [声音场景](../../tests/helpers/wave-fade.ts)

126 的 Windows 原引擎在两个实际播放场景调用 DirectSoundCreate 时返回 `0x88780078`，无法取得播放后的声音坐标证据。另有三个场景的预期值已修正为原 TJS 对正零实数输出的 `+0.0`。第 127 批增加独立的 Ubuntu 托管作业，使用 32 位 Wine 和 PulseAudio 软件输出运行同一份原版可执行文件与 28 个声音场景。Windows 和 Wine 各自保存原始观察及结论。[Windows 原版对照](../../tests/probes/sli-sdk.ts) · [Wine 运行器](../../tests/probes/original-sound-wine.py)

Firefox 的八个暂停影片换轨用例都卡在新解码器等待首帧。浏览器已发出 `loadeddata`，但首次视频帧回调尚未返回，保留时刻的定位步骤还未开始。现在超时记录同时保存元素状态、帧回调登记、视频质量计数和已提交帧元数据。此次取回的证据还不能确定解码器为何停在首帧。[影片宿主](../../src/backends/video/browser/host.ts) · [换轨验收](../../tests/browser/video-audio-handoff.spec.ts)

## 取回的运行与后续验收

- 125 的发布构建成功，Node 报告 3,946 项通过、6 项失败。已发布的浏览器分片报告 595 项通过、10 项失败、1 项跳过。原版 KAG 作业超时，35 个场景均未写出观察结果。[125 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45494717147)
- 126 的发布构建成功，Node 报告 3,952 项通过、8 项失败。已发布的浏览器分片报告 871 项通过、18 项失败、1 项跳过。原版转场选项 21/21 匹配。三个浏览器的兼容性作业各通过 32 项，独立的介绍游戏路线和书签浏览器验收仍有失败。[126 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45497700733)
- 两个运行在取回时仍有作业执行中。所列出的 96 份 ZIP 已逐份核对大小及 SHA-256，共 1,052,729,076 字节。

# 第 143 批立绘缩放、剧情指令名与声音控制

## 立绘和遮罩

原版引擎会根据绘图方式选择像素。整幅图片向前缩放、原样复制以及把透明立绘叠到背景上，即使指定相同的滤镜也可能得到不同的边缘。在最近邻路径中，两个像素 A、B 放大为三个像素时，中间格仍取 A。反向绘制时中间格取 B。普通浮点逆变换在分界点会给出不同结果。[原版 StretchBlt](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerBitmapIntf.cpp#L1750-L1818)

会话现在按图层绘图面、混合方式和遮罩保持开关选择原版的定点采样。矩阵和三顶点接口使用相同的 16.16 扫描线，在裁剪后保留原来的取样位置。原版双线性路径先对每行做字节插值，再插值两行。选用最近邻的透明叠加保留原像素边缘。未裁剪且符合条件的整幅直拷仍用独立的线性或二次滤波器。Web 扩展滤镜和超出原版定点表示范围的变换继续走已有实现。[定点采样](../../src/engine/graphics/stock-affine.ts) · [整幅复制滤波](../../src/engine/graphics/copy-resampler.ts)

原版的双线性复制在不透明绘图面上使用部分不透明度时，也会修改目标的遮罩。边缘、水平内部和旋转后的内部各自按原版标量公式混合四个通道。原版 Windows SDK 和 Web 源码、字节码会话调用相同的公开 Layer 方法。18 个场景对照放大、镜像、旋转、遮罩保持、半透明度、裁剪及读取源矩形邻近像素。浏览器画廊逐次点击六项预览，从实际窗口截图中分别读取颜色和遮罩条带。[共享场景](../../tests/helpers/sprite-sampling.ts) · [浏览器画廊](../../tests/browser/sprite-sampling.spec.ts)

## 剧情指令名

原版 KAG 只把 ASCII 大写字母折为小写。脚本现在可以同时定义全角大写和小写的宏或参数。例如同一条指令可以分别收到 `ＨＰ=7` 和 `ｈｐ=2`，ASCII 指令仍可混用大小写。会话验收把正在宏内调用章节的解析器书签写入文件，再在新的虚拟机里恢复参数并回到原剧情。浏览器另用原版 KAG 模板，点击选项后读到两段调用不同宏的对白，并继续到结尾。[原版大小写规则](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/tjs2/tjsString.cpp#L144-L157) · [KAG 指令和书签](../../tests/helpers/kag-names.ts) · [原版模板交互](../../tests/browser/kag-names.spec.ts)

## 声音暂停与循环

`WaveSoundBuffer.paused` 和 `looping` 使用原版 TJS 布尔转换。脚本传入实数 `0.5` 或 `-0.5` 可以启用暂停或循环，字符串 `"0.5"` 仍按原版字符串数值规则转换为假。浏览器用游戏按钮控制一个 24 毫秒的双声道音片段，检查超过八个片段时长的实际输出、暂停时的静音和播放位置，以及解除循环后的自然停止。[声音绑定](../../src/engine/tvp/sound.ts) · [声音验收](../../tests/browser/wave-booleans.spec.ts)

## 已取回的托管结果

本批共增加 6 个 Node 测试，每个浏览器项目增加 12 个测试。Windows 原版项目新增 18 个图形场景、4 个 KAG 场景和 3 个 Wave 控制场景。

第 134 批已报告全部 4,070 个 Node 用例，4,066 个通过，4 个既有图层用例失败。该批新增的 11 个 ZIP、音乐和 MIDI 用例全部通过。三浏览器游戏库共 69/69 通过，其中 12 项从原版 KAG 分发包启动，选择补丁、存档并从游戏库重新打开。原版 SDK 图形对照为 57/57。取回时还有常规浏览器分片待报告。[第 134 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45761489263)

第 133 批最终版的常规浏览器分片已齐，共 3,186 项通过、97 项失败、2 项跳过。原版介绍游戏的 6 项交互和 12 项缩略图验收均通过。第 135 至 142 批在此次取回时仍在队列。83 份常规结果归档已核对 GitHub 登记的字节数和 SHA-256。[第 133 批最终版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490)

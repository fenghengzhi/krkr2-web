# 057：内置转场的 opaque 定点像素核

本阶段只校准 `crossfade` / `universal` 的 opaque 路径。实现和测试已编写，尚未运行；所有可执行验证须由 GitHub-hosted Actions 完成。没有运行本地测试、构建、类型检查或浏览器探针。Alpha / AddAlpha 像素核以及转场首帧、时钟回调和完成事件的顺序仍是后续范围。

## 固定参考与路由

参考固定官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable：

- [LayerIntf.cpp，StartTransition](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L6334) 把目标的 `DisplayType` 交给 handler，创建后保留该值。源图层类型、绘制 face 和 holdAlpha 不选择转场内核。Effect / Filter 的 DisplayType 为 Binder。
- [drawable.h，类型分类](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/drawable.h#L55) 将 Alpha 与 Photoshop 系列归入 alpha，AddAlpha 独立，其余类型走 opaque 分支。因此普通 Additive 等 RGB 混合类型也使用本阶段内核。
- [TransIntf.cpp，CrossFade](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/TransIntf.cpp#L538) 用 `floor(elapsed * 255 / time)` 生成整数 phase，再依据创建时的目标类型调用不同内核；零 phase 和最终 phase 直接选择完整源图。
- [TransIntf.cpp，Universal](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/TransIntf.cpp#L824) 把最大 phase 扩为 `255 + vague`，并在 `vague < 512` 时启用按阈值直接选择源图的 switch 路径。
- [tvpgl.c，标量内核](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/tvpgl.c#L3947) 提供 `TVPConstAlphaBlend_SD`、Universal 表及 switch 操作的整数依据。没有在本地执行参考源码。

## 像素与合成表示

Opaque RGB 通道使用 `before + (((after - before) * opacity) >> 8)`。负差值也使用算术右移，不能改成向零截断或四舍五入。黑到白在 `tick=500, time=1000` 时，phase 为 127，结果为 126；旧 `/255` 路径得到 127。白到黑同帧为 128。

Universal 令 `lower = phase - vague`。表内过渡区 opacity 为 `255 - trunc((rule - lower) * 255 / vague)`。在 switch 路径，只有 `rule < lower` 才完整复制新源；`rule == lower` 的 255 opacity 仍执行 `/256` 混合。`rule >= phase` 完整复制旧源。`vague=0` 只有严格阈值复制，不执行除法。

当 `vague >= 512`，原版不使用 switch 路径。过渡区之外的表项仍然参与混合，opacity 255 不能替换为新源完整复制。最终整体 phase 仍直接选择完整新源。

Opaque 内核读取原始 RGB，不先依据源 mask 预乘。混合阶段原版写出 RGB，未使用的 mask 字节为零；完整源复制保留源 mask。SceneComposer 保留这种原始图像供 `piledCopy`，在显示时才按当前图层类型转换为预乘图像；ltOpaque 显示 alpha 为 255。混入有子层的源时先完成其子树，然后把完成图像交给同一内核。

`TransitionFrame.destinationType` 记录创建时的格式。独立 `pixelPhase` 在现有 advance 点计算，保持先乘再除的整数 phase 运算顺序，避免先归一化为浮点进度再乘倍率的边界误差；不改变 advance 的调度顺序。滚动转场和未校准的 alpha 路径继续使用原来的进度处理。

## 验证范围

新增 9 项纯用例覆盖带正负差值的通道、起止源副本、接近起止点的量化、Universal 严格边界、零 vague、511 / 512 分支、较大 vague、规则平铺、目标类型分类与原始/显示图像分离。

新增 18 项真实 TJS Session 用例：源码与编译字节码各 9 项，覆盖主图／子树、低 alpha 源的原始 RGB、`piledCopy` mask、显示像素、终点交换、Universal 阈值、512 分支、创建后更改目标类型、普通 Additive 路由和现有 Alpha / AddAlpha 路径。每个场景先独立调用脚本预热 tick 0，再在另一次脚本调用中取样，避免一次同步完成中的绘制去重掩盖时钟边界。规则使用真实 BMP 编解码；会话结束检查句柄与所有权归零。

旧 composition / integration / browser 测试中红蓝 crossfade 的目标默认是 ltAlpha，因此其 `[128, 0, 127, 255]` 预期不应随本阶段改动；纯 composition 夹具现在显式标注该目标类型。这里的保留断言仅保证本阶段没有修改 alpha 路径，不证明它已符合原版。

尚未校准 Alpha / AddAlpha 的表与定点像素、转场时间原点与回调顺序、特殊图层完整合成的所有组合、规则图彩色转灰及缩放语义。本阶段不能据此声称全部内置转场或非插件范围完成。

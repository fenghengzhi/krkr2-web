# 057：内置转场的 opaque 定点像素核

本阶段只校准 `crossfade` / `universal` 的 opaque 路径。实现和测试已编写，尚未运行；所有可执行验证须由 GitHub-hosted Actions 完成。没有运行本地测试、构建、类型检查或浏览器探针。Alpha / AddAlpha 像素核以及转场首帧、时钟回调和完成事件的顺序仍是后续范围。

组合回归纳入 `37db7c5` 的菜单、Font 控制流及原版 NoNotify 校准，预期 1,756 项 Node、1,146 项浏览器及 6 组直接运行时。父分支的各轮运行仍按各自提交保留：`3521247` 首轮 Node 有两项失败，`b7bb957` 修订后回归与 `0a1a948` 字体组合回归仍在执行，`37db7c5` 校准回归尚在排队。不能把这些部分结果或排队运行视为本次组合的通过证据。

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

## 首轮 Node 证据与终点夹具修订

[34997020864](https://github.com/fenghengzhi/krkr2-web/actions/runs/34997020864)，提交 `6678d6e46071ccad788bfd632a8ebce2f8471fee`，构建／类型检查通过；Node 实际 **1,752 通过、4 失败／1,756**，没有取消、跳过或未报告。新增 9 项纯测试和 14 项真实 TJS 用例通过；另外 4 项 crossfade 用例完成中间 RGB、mask 和显示像素检查后，在最后的完成／交换复合断言失败，不能计为通过。先前菜单、NoNotify 和 Font 组合的 1,729 项本轮均实际通过。

失败夹具使用 `session.evaluate('tick=1000;fore.update()')`。这个 API 在 TJS 表达式模式执行，词法器注入 return 后只执行赋值，第二句 update 没有运行；原测试因此没有推进到终点。修订以 IIFE 执行完整两步，并把原来的 done、visible、RGB、mask 复合布尔断言改成相同预期的逐字段值，便于失败时保留实测状态。LayerTree.exchange 本来就保留各自 bitmap，原白色源和 mask=1 预期不变；没有修改产品代码或放宽像素／完成要求。

首轮完整 TAP 和 build-info 已独立下载至 `out/verification/github-actions/34997020864/early-node/`。记录本节时浏览器与兼容性仍在运行，后续实际结果必须另行保留；此修订也尚待新 Actions，不能将首轮失败改计为成功。

## 第二轮回归的 Firefox 控制台夹具

第二轮 [34998001623](https://github.com/fenghengzhi/krkr2-web/actions/runs/34998001623)在 `076ecfc7e1e9a3144f7386d5ca88fd081a4ac004` 的 Node 作业已成功，终点修订实际通过。Firefox 常规浏览器实际 340／341 通过；唯一失败是 `activity.spec.ts:110` 的 Asyncify 隐藏启动／停止／重启用例，等待 `test-result-7:17` 超时。本轮此时仍有 WebKit 作业，不能视为完整通过。

原始 trace 显示 fill API 请求了完整表达式，但随后点击执行之前的 DOM 快照里 `expression` 输入框仍为空；重启的第二个 `activity-ready`、新 Window 显示与该 fill 同时发生。它证明测试没有提交预期表达式，不能据此认定 VM 的 `value` 求值超时。trace 没有直接记录 activeElement，不能把焦点竞争的具体原因写成已证明。超时终止日志发生在测试失败后的 teardown。

修订让通用控制台助手先等待执行按钮可用，再填写并断言完整表达式，最后按原要求执行并等待原结果。没有增加等待超时、额外 sleep、放宽结果或改动产品代码。运行状态会早于启动收尾发布，控制台按钮的可用状态才是这一交互的准备条件。第二轮原始失败及 trace 保存在独立运行目录；后续通过不会覆盖它。

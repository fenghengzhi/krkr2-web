# 056：文字绘制与字体查询的控制流

当前本文范围已随菜单／文字／不透明转场组合验证并合入 main。[完整回归 35001345784](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001345784)在精确提交 `34367abda6a4519d54fa1ff8daae3b7776b20cb8` 通过 **1,756 项 Node、1,146 项浏览器和 6 组直接运行时**，14 个作业全部成功，零失败、取消、跳过或重试。浏览器包含 1,023 项常规、57 项游戏库、59 项 PWA 和 7 项可信生命周期。

[兼容检查 34997605307](https://github.com/fenghengzhi/krkr2-web/actions/runs/34997605307)在 `6678d6e` 使用构建 `34997020864` 通过 **78 项原 KAG／旧 ABI 检查**。从该提交到 `34367ab` 只修改测试与文档，应用及内核源码相同；这是同源码的另一构建证据，不冒充最终回归的同次构建。

已测应用以 `85414d3` 合入 main；合入与文档提交使用 `[skip ci]`，不新增一次验证。System 消息／输入对话框、视频混合图层和 Clipboard 在后续分支实现，尚未合入这里的已验证版本。其他系统／图形 API、流式媒体、旧视频编码及完整非插件目标仍未完成。历次失败、取消、未报告及原生诊断全部保留；当前绿色结果不证明历史 V8、glibc 或 WebKit 故障根因已修复。所有可执行验证只在 GitHub-hosted Actions 进行。

以下保留实施时的状态、失败与修订；其中“尚待验证”等描述属于对应阶段历史。

本片基于 `cb346f7`，修正 `Layer.drawText` 的目标检查、透明度提前返回、`holdAlpha`、更新标记，以及 Font 参数和无主图查询。代码与下述验收已编写，尚未运行 GitHub-hosted Actions；不计为通过，也不表示整个非插件运行时已完成。没有本地测试、构建、类型检查或执行探针。

首轮组合回归纳入菜单分支 `b7bb957`：其中 `3521247` 的 Node 已有 1,701／1,703 的实际失败记录，两个旧等待夹具在 `b7bb957` 修订，完整第二轮仍排队。这里不把未完成的菜单回归算作通过；组合后的构建会再次执行所有案例，预期 1,729 项 Node、1,140 项浏览器和 6 组直接运行时。实际通过数以各自 Actions 报告为准，独立菜单首轮及其失败继续保留。

## 固定参考

参考官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/`：

- [LayerIntf.cpp：DrawText](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3813)先要求 MainImage，再选择 Alpha、AddAlpha 或 Opaque 混合；Mask／Province 拒绝，AddAlpha 的负透明度拒绝。检查发生在 ApplyFont 和字形生成之前，空字符串及透明度为零也不能绕过非法目标检查。
- [LayerBitmapImpl.cpp：DrawTextSingle](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L2198)及 [DrawTextMultiple](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L2379)：Alpha 透明度限制为 −255 至 255，其余限制为 0 至 255；零值在 Independ／ApplyFont／字形取得之前返回。因此 Opaque 负透明度是空操作，不能抛出 Alpha 专用错误或清空 alpha。
- [InternalDrawText](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L2053)只在 Opaque 分支使用 holdalpha。Alpha 和 AddAlpha 不使用它；Alpha 的负透明度只移除原 alpha。
- 同一函数按字形 BlackBox 与绘图剪裁的非空交集返回 drawn；不是像素前后比较。Layer.DrawText 仅在更新矩形非空时置 ImageModified。空字串、空字形、完全被剪裁的字形和零透明度均不置位；已有 true 不会被清除。非空的零覆盖字形区域仍置位，只有阴影相交也置位。
- [tvpgl.c：TVPApplyColorMap65](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/tvpgl.c#L4826)在 Opaque 不保持 alpha 时写 RGB，不保留最高字节；覆盖为零的区域也清 alpha。[HDA 分支](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/tvpgl.c#L5068)才保留原 alpha。这与“整次调用透明度为零，根本不进入混合”是两个不同分支。
- [Layer.drawText 的 TJS 入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7146)要求至少四个参数，color 没有省略默认值；显式 void 仍作为实际第四参数转换。aa 使用 TJS bool 转换，不能先截成整数，因而 0.5／−0.5 为 true。
- [六个文字测量函数](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4811)在 ApplyFont 前检查 MainImage。[Font 的 TJS 入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9675)为 getTextWidth／Height、getEscWidthX／Y、getEscHeightX／Y 和 mapPrerenderedFont 要求至少一个参数。Font 属性保存在 Layer 上，图像释放不使属性失效。

静态源码原件保存在主工作区 `out/verification/window-layer-ownership/reference/`，SHA-256：

| 文件                | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| LayerIntf.cpp       | `05a8279842f1e4a057c7b9005437fbc85579524307864509e47429228f59240b` |
| LayerBitmapImpl.cpp | `d286842fc363a3d8678d4600ae20ec545c04b644ff73b10d870abd9ae2bad6a2` |
| tvpgl.c             | `8b1075c88883b76e683fd8d57654ce64fcacc5e8ffa9c6f4cf259dc743deefa0` |

## 实现

Session 的 `Layer.text` 在取得字体快照／调用 FontService 前，调用 LayerTree 的文字预检查并取得标准化透明度。Bitmap.composite 共用 face／透明度规则，禁止直接向 Mask／Province 写字形。Opacity 为零及完全被剪裁时返回 false；有非空字形区域则返回 true。Layer 只在 true 时置 imageModified，Session 只在实际产生绘图更新时置 dirty。

Bitmap 的文字合成只让 Opaque 使用 holdAlpha；Alpha／AddAlpha 的 RGB 与 alpha 合成不再被该属性切换。原版 Alpha 负透明度的只移除 alpha 路径保留。Opaque 非零绘制依旧按整个相交字形框决定是否清 alpha。

TJS 方法改为显式参数数量检查，保留可选参数省略或 void 时的原默认值，并用 `!!` 完成 aa 的布尔转换。Font.measure 额外携带实际 Font 对象，通过既有原生身份表检查它观察的 Layer 是否有主图。这个检查不增加长期强引用，保留已有 Font、Layer 与 assignImages 生命周期／映射关系；独立 `new Font(layer)` 与缓存 `layer.font` 都受相同规则约束。

DrawText 的 x／y、opacity、shadowlevel／width／offset 参数在原签名中均为 `tjs_int`，color／shadowcolor 为 `tjs_uint32`。本 host 入口复用已有 `BigInt.asIntN(32)` 转换后再读取 Number，颜色再取无符号 DWORD；不会在截断前因大于 JavaScript 安全整数范围而丢低位。透明度先按原生有符号 32 位取值，再做 face 检查与 clamp，所以正负 2³² 都成为零，`0xffffffff` 成为 −1。其他入口的数值 ABI 没有改变。

旧 `layer-font-lifetime.test.ts` 中“失效 Font 后 Layer 仍可绘字”的夹具补上显式白色参数，以继续检验原有生命周期行为。原先的三参数调用依赖错误默认值，新参数数量测试独立验证其现在必须拒绝。

## 验收与当前状态

新增 **26 项 Node 验收**，全部待 GitHub-hosted Actions 执行：

- `tests/integration/layer-text-contract.test.ts`：8 个模板 × 源码／字节码，共 16 项。真实 TJS 验证参数数量、显式 void、包括正负小数的 aa bool 转换、无图时六查询拒绝且属性可用、恢复图像后的文件字体测量、非法目标／空文本预检查、零值及 Opaque 负透明度提前返回。另覆盖 ±2³²／大于 Number.MAX_SAFE_INTEGER 整数的低位转换、正值转负 opacity／负值转正 opacity、坐标与阴影参数的 wrap。后端在前置阶段受保护，断言 decode／loadFont／measure／glyph 等计数全部为零，再开启后端执行独立继续脚本；因此捕获了后端错误不能冒充正确的前置拒绝。已加载字体在 Stop 后恰好释放一次。
- `tests/integration/layer-text-pixels.test.ts`：2 个模板 × 源码／字节码，共 4 项。读取已提交的合成 TFT，实际经过预渲染解析、映射、DrawText 和位图路径；不依赖安装字体或截图。覆盖 Alpha／AddAlpha 两种 holdAlpha 的相同像素、负 Alpha、Opaque 保留与清除 alpha、空字形／越界／空剪裁／透明度空操作、非空零覆盖的 imageModified、单独可见阴影。
- `tests/conformance/text-composition.test.ts`：6 项直接位图／LayerTree 验收。覆盖拒绝前无像素／province／revision 变动、零值空操作、透明度端点夹紧、holdAlpha 分派，以及裁剪矩形决定的更新状态。

没有运行或未完成的 workflow 不计成功。后续记录必须绑定实际提交和 Actions run，并保留先前失败／取消／未报告证据。

## 尚未扩展的范围

本片恢复控制流与状态分支，**没有恢复完整原版文字整数混合核**。现有字形覆盖仍转换为 0—255，Bitmap.composite 继续使用浮点 `/255` 与四舍五入；原版 `TVPApplyColorMap65_*`、`TVPRemoveOpacity65_*` 使用 65 级覆盖、查表和位移，部分透明度、RGB 与目标 alpha 的整数边界仍可能差一个或多个值。新增测试以固定 TFT 隔离控制流和 holdAlpha 分派，不把两种 holdAlpha 相同、或少数端点成立，扩大解释为全像素与原版一致。完整核需后续独立源码差分验收。

本片不替换 GDI／FreeType／Canvas 后端，不修改字体 fallback、字形边界与布局，也不改变已有预渲染共享映射、Font ABI 和 assignImages 功能。getGlyphDrawRect 的扩展查询、无主图时 map／list／选择的原版不受支持分支、系统颜色解析与原生缓存优化继续各自保留既有范围；不从本片六查询的检查推导它们已完成。

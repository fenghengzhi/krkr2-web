# 046 — Layer 的可写 neutralColor

本阶段选定范围已通过[完整回归 34930172005](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930172005)：验证提交 `551b97d`，全部 **14 个 job 成功、1,043 项 Node、786 项浏览器和 6 组直接运行时通过**。浏览器包含常规 663、游戏库 57、PWA 59、可信生命周期 7；所选测试零失败、取消、跳过、flaky 或重试。完整产物和 run.json 按原 run ID 保存在 `out/verification/github-actions/34930172005/`。

[原 KAG／离线升级 34929350970](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929350970) 在 `259c892` 使用[构建 34929264074](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929264074)的精确产物，通过全部 **78 项**。后续 `551b97d` 只调整浏览器夹具，应用源码相同；该兼容结果对应原构建，不能写成重跑了 `551b97d` 的构建。以下保留所有历史失败与范围限制。

`Layer.neutralColor` 现保存每个原生图层实例自己的 32 位 ARGB 值。TJS setter 先按原生规则转为整数，再在 BigInt 中保留低 32 位，避免较大 64 位整数经过 JavaScript number 后丢失颜色位；getter 返回非负整数。设置颜色本身不修改现有图像、绘图 clip、imageModified 或输入状态，也不单独请求重绘。

依据为 [原生属性入口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9482-L9499)与 [只赋值的 uint32 setter](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.h#L420-L421)。初始子层为透明白 `0x00ffffff`。初始 primary 在 Construct 中改为 `0xffffffff`，但不重填此前分配的透明白默认 bitmap；两种初始状态分别保留。[原生 Construct](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L433-L445)

图像扩容和 `hasImage=false → true` 的重新分配从实例颜色取值，保留原有像素的 RGBA；province 扩容仍以零填充。显示区域增大而带来的 bitmap 增长走同一路径。`affineCopy(clear=true)` 也使用目标图层当前颜色，继续遵守 bitmap clip 和 dfOpaque 的 holdAlpha；dfAlpha / dfAddAlpha 使用完整 RGBA 清除，province 不受影响。[ChangeImageSize / AllocateImage](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2001-L2037)、[AffineCopy](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4011-L4040)

真正改变 `type` 会先恢复该类型的默认颜色，再执行现有图像分配规则。重复写入相同 type 保留用户覆盖值，也不会重新分配已释放的图像。`assignImages` 复制图像与已有字体设置，保留目标自身 neutralColor；此后目标扩容继续使用自己的值。[SetType](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1417-L1627)

已逐项检查 `neutralColor(type)` 的调用位置。LayerTree 的分配、扩容与 Session 的 affine clear 改为实例颜色；类型默认值表继续决定初始化与实际 type 切换。Composer 的中间透明背景继续使用类型默认值，避免用户的非透明颜色污染透明组。原生代码同样区分 `NeutralColor` 和内部 `TransparentColor`，见 [CopySelfForRect](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5541-L5551)。

无主图的 `ltOpaque` 保留自身的填色矩形。它与子图层使用已有整数混合路径合成，再按 opaque 规则呈现；中性颜色中存储的 alpha 不使 opaque 图层透明，图层自身 opacity 仍控制整个子树。合成缓存把填色值纳入键，修改颜色后显式 update 或其他真实更新会得到新画面，尺寸及主图恢复也按新状态重新生成。这个临时合成结果不创建主图，`hasImage` 继续为 false。原生 [DrawSelf](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5462-L5490)同样通过临时矩形完成正常窗口显示。

从有图像的祖先做 `piledCopy` 时，图像为空的 opaque 子图层也参与合成，并保留相应原始像素与 alpha。没有主图的来源或目标在任何 onPaint 回调之前报错，回调不能通过重新分配主图使无效请求变成有效请求，保持[原生 PiledCopy 入口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3858-L3870)的限制。透明图层与 binder 的无主图背景不改用用户颜色。复杂区域缓存、原生嵌套 completion 与全部组合的逐像素差分仍不在本阶段完成声明内。

新增 `tests/integration/layer-neutral-color.test.ts` 的源码／字节码测试，检查初始 primary、64 位整数低位、实例隔离、旧像素和 clip、两种扩容、province、重建、type 变更、assignImages 和仿射清除。透明组用例防止把内部透明背景误改成用户颜色。`layer-opaque-fill.test.ts` 检查无主图 opaque 的窗口帧、祖先快照、子树透明度、动态缓存、primary 和负对照。`tests/browser/layer-neutral-color.spec.ts` 检查双后端源码／字节码的实际画布像素，保存截图附件，并对比屏幕与祖先快照显示。

首轮 [Node 诊断 34928484922](https://github.com/fenghengzhi/krkr2-web/actions/runs/34928484922)在 `2f41269` 构建与类型检查通过，1,039 项中 1,037 项通过、2 项失败，无取消或跳过。失败均来自新透明组负对照的 raw mask 预期：原生部分透明度的 alpha-on-opaque 运算只写 RGB，结果 mask 为 0；测试误把最终显示时的 alpha 255 当成了原始快照值。修正后对两个像素精确断言 RGB 和 mask，产品混合算法没有因此改变。该失败的完整日志、产物和 run.json 按原 run ID 保存。

源码复核另补上 piledCopy 的主图前置校验，并用 `tests/integration/piled-copy-preconditions.test.ts` 覆盖回调试图修复来源或目标的源码／字节码场景。[Node 诊断 34929115093](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929115093) 在 `259c892` 通过全部 1,043 项，无失败、取消或跳过。

首轮[完整回归 34929264074](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929264074) 通过全部 1,043 项 Node 和 6 组直接运行时；浏览器 767 项通过、19 项失败，无取消、跳过或重试。其中 18 项图形用例发现旧夹具对 primary 默认颜色的依赖。字体测试先扩容再切 ltAlpha，扩展区域已被 opaque white 填充；切换类型不重填已有像素。修订为先切 ltAlpha 再扩容。仿射保存测试需要透明白清除，现显式设置 neutralColor 为 `0x00ffffff`。原像素、字体度量和画布断言保留，失败日志也保留。修订后的完整结果见本文开头；该首轮仍为失败，不能改记为通过。

另 1 项是 WebKit Asyncify 的 PNG 编码停止测试。归档 trace 显示编码完成与会话就绪早于实际按钮点击：开始通知断言完成至真实点击相隔约 1.895 秒，点击前至少 85 毫秒的快照已经包含 encode-finished。这证明该次测试没有在编码期间发出停止，不能据此判定运行时遗漏取消。34930172005 的绿色重跑也没有证明该时序已修复；阶段 050 的及时触发按钮及编码开始后的受控取消测试仍在独立分支，不属于本阶段结果。完整原始 trace 和失败记录继续保留。

本阶段不包含仍在分支中的阶段 047 Window.mainWindow、阶段 049 空矩形 piledCopy 或阶段 050 取消测试。047 已实现，但其[完整回归 34930203580](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930203580)仅 821/822 项浏览器通过，另 1 项 WebKit JSPI 启动用例报 Page crashed，仍待诊断和完整通过。当前仍限制一个活动 Window；完整多窗口、其余图形／系统 API、流式媒体及全部非插件兼容均未完成。

所有构建、类型检查、Node 测试、浏览器检查和可执行探针只能由 GitHub-hosted Actions 执行；本地仅阅读、编辑、格式化和检查已有云端产物。此前各阶段及失败记录继续保留。

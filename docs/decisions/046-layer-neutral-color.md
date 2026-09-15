# 046 — Layer 的可写 neutralColor

`Layer.neutralColor` 现保存每个原生图层实例自己的 32 位 ARGB 值。TJS setter 先按原生规则转为整数，再在 BigInt 中保留低 32 位，避免较大 64 位整数经过 JavaScript number 后丢失颜色位；getter 返回非负整数。设置颜色本身不修改现有图像、绘图 clip、imageModified 或输入状态，也不单独请求重绘。

依据为 [原生属性入口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9482-L9499)与 [只赋值的 uint32 setter](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.h#L420-L421)。初始子层为透明白 `0x00ffffff`。初始 primary 在 Construct 中改为 `0xffffffff`，但不重填此前分配的透明白默认 bitmap；两种初始状态分别保留。[原生 Construct](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L433-L445)

图像扩容和 `hasImage=false → true` 的重新分配从实例颜色取值，保留原有像素的 RGBA；province 扩容仍以零填充。显示区域增大而带来的 bitmap 增长走同一路径。`affineCopy(clear=true)` 也使用目标图层当前颜色，继续遵守 bitmap clip 和 dfOpaque 的 holdAlpha；dfAlpha / dfAddAlpha 使用完整 RGBA 清除，province 不受影响。[ChangeImageSize / AllocateImage](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2001-L2037)、[AffineCopy](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4011-L4040)

真正改变 `type` 会先恢复该类型的默认颜色，再执行现有图像分配规则。重复写入相同 type 保留用户覆盖值，也不会重新分配已释放的图像。`assignImages` 复制图像与已有字体设置，保留目标自身 neutralColor；此后目标扩容继续使用自己的值。[SetType](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1417-L1627)

已逐项检查 `neutralColor(type)` 的调用位置。LayerTree 的分配、扩容与 Session 的 affine clear 改为实例颜色；类型默认值表继续决定初始化与实际 type 切换。Composer 的中间透明背景继续使用类型默认值，避免用户的非透明颜色污染透明组。原生代码同样区分 `NeutralColor` 和内部 `TransparentColor`，见 [CopySelfForRect](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5541-L5551)。无主图的 ltOpaque 在该函数中的专门填充分支，当前 Web 合成器尚未完整实现；本阶段不把该路径或复杂区域合成标成等价。

新增 `tests/integration/layer-neutral-color.test.ts` 的源码／字节码测试，检查初始 primary、64 位整数低位、实例隔离、旧像素和 clip、两种扩容、province、重建、type 变更、assignImages 和仿射清除。透明组用例防止把内部透明背景误改成用户颜色。`tests/browser/layer-neutral-color.spec.ts` 检查双后端源码／字节码的实际画布像素，保存截图附件。

本阶段尚未验证。所有构建、类型检查、Node 测试、浏览器检查和可执行探针只能由 GitHub-hosted Actions 执行；本地仅阅读、编辑与格式化。此前各阶段及失败记录继续保留，不能用于宣称此提交通过。

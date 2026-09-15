# 055：assignImages 保留目标字体与自身状态

本阶段基于 054 的 `a76af99`，修正 `Layer.assignImages` 的字体、图像分配与自赋值语义。第二轮组合GitHub-hosted Actions已全部通过（见文末），首轮失败原样保留，没有本地测试、构建、类型检查、浏览器或执行探针。本页不表示整个非插件运行时已完成。

## 原版依据

固定参考官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 中 `kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/`：

- [LayerIntf.cpp AssignImages，2085行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2085)：直接赋值／创建MainImage，独立复制或删除ProvinceImage；不调用AllocateImage，不检查目标CanHaveImage，也不复制Layer.Font。源无主图时删除目标主图及province；结尾仍置imageModified，有主图则ResetClip。
- [ApplyFont，4696行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4696)：把目标Layer自己的Font写回MainImage。底层Bitmap曾复制源Font不代表Layer.Font也应该改变。
- [LayerBitmapImpl.cpp Assign，1857行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L1857)：同对象或共享同一bitmap时返回false。Layer.AssignImages仍重置clip和imageModified，但只在main_changed时发Update(false)。源无主图路径的main_changed初值为true。
- [InternalSetImageSize，2277行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2277)：沿用目标显示尺寸和图像偏移；只在新主图无法容纳时缩小显示尺寸／夹紧偏移，不复制源Layer位置或显示尺寸。
- [DeallocateImage，2040行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2040)：删除图像但保留Layer状态和旧ClipRect，供后续绘图检查使用。

## 具体变化

`src/engine/tvp/layer.ts` 移除将source.__fontData赋给target.__fontData的操作。assignImages只提交图像复制；不访问或创建目标缓存Font。已缓存的target.font、独立new Font(target)以及尚未缓存Font的Layer继续观察同一份目标字体数据，原先的预渲染字体映射选择保持。

`src/engine/scene/layers.ts` 用专用的图像复制路径替代hasImage=true／resizeImage组合：在既有图像预算内深复制main和已有province，用新bitmap的完整clip，保留目标type、neutralColor、face、holdAlpha和可用imageLeft／Top；显示宽高只在源主图更小时缩小。即使目标type是ltBinder也可接收图像，因为原版AssignImages不等同于SetHasImage。显式 `binder.hasImage=true` 仍保留原版拒绝规则。

有主图的自赋值不复制像素，只重置clip和imageModified；源无主图（包括自赋值）继续沿已有释放路径，保留054的clipBeforeRelease并置imageModified。`src/engine/session.ts` 根据AssignImages返回的更新需求设置dirty，避免为有主图自赋值额外发更新。

## Binder 接收图像后的必要呈现适配

assignImages使Binder可以持有MainImage后，不能继续用“bitmap存在”推断它会绘制自身。原版Effect／Filter也采用DisplayType=ltBinder。它们在普通父目标中的自身图像被忽略，子层保持各自type／opacity，继承Binder的位置和显示裁剪；Binder非零opacity不再乘到子层，0或invisible仍剪掉整棵后代树。依据：[BltImage的Binder分支](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5276-L5280)、[Binder转发目标及完成消息](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5906-L5947)。

`src/engine/scene/composer.ts` 的正常frame、普通compose和目的相关blendTree都据此透传Binder子层，不合成其自身MainImage。Binder的绘图clip与imageLeft／Top只影响存储图像访问，不代替它传给孩子的显示矩形。修改存图不会让它在祖先截图中显色；子层需要与祖先背景进行Additive等运算时仍能直接访问该背景。

**直接piledCopy(Binder)使用另一种原版目标。** PiledCopy临时启用缓存；Complete无可见非零opacity子层、image偏移为0、主图和显示尺寸相同时直接返回MainImage，不检查Binder类型。非快路先CopySelf到缓存，完成终点tCompleteDrawable仅做CopyRect，忽略收到消息的type／非零opacity；因此自身像素和子层原始RGBA都可能进入结果。嵌套Binder也须按这个复制终点处理，不能全局把Binder主图替换成透明图。[PiledCopy](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3858-L3885)、[Complete及原始复制终点](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L6197-L6252)。

snapshot保留该MainImage快路；Binder根的非快路交给独立`src/engine/scene/completion.ts`，按实际完成消息的矩形和先后顺序处理，普通祖先的snapshot仍经过正常混合。两个终点分别建立缓存，避免直接Binder快照的像素混入正常显示缓存。

完成消息不能简化为每个子层的一整张透明图：无主图、无可见孩子的未缓存Alpha层不发送消息，应保留外层原像素；未缓存Binder仅在exposed区域发送自身图像，重叠区域只透传孩子。缓存Binder先透传孩子，再发送自己的缓存图。普通无图父层记录实际收到的矩形，新区域收到同类型、opacity255的图像时直接复制，重叠部分才混合。此处保留原版CreateExposedRegion的30／10个可见孩子阈值，计数包括屏外可见孩子。[DrawSelf／Draw](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5459-L5899)、[区域构造](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1708-L1833)。

目标接口同时保留`complete`与`borrow`：未缓存、opacity255的Opaque层在重叠区域借用父位图，父层收到同一位图时不再次混合，也不更新DrawnRegion。这会影响原始mask，以及无图缓存父层结尾对未报告区域的填色。借用后首次收到需要混合的消息，仍要先清空未登记区域；即使新消息为Binder、最终不混合，也须先清空并登记覆盖。本片用具体像素覆盖这些情况。[借用目标](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5772)、[位图身份与覆盖记录](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5950-L6030)。

```tjs
target.font.height=12; source.font.height=24;
var saved=target.font;
target.assignImages(source);
// target.font仍是saved，height仍为12。

target.setClip(1,1,1,1); target.imageModified=false;
target.assignImages(target);
// clip重置为完整主图，imageModified=true，像素不变。
```

## 回归设计和验证状态

`tests/integration/layer-assign-images.test.ts` 共 **20项**，覆盖源码／字节码的图像和已有province复制／清除、后续写入独立性、尺寸与偏移夹紧、目标类型和其他属性保留、binder直接接图、自有／无主图赋值、源无主图释放，以及释放后保留的裁剪行为。额外用分开的脚本完成周期检查：自赋值不会主动消费此前空更新留下的onPaint，不同图像赋值则有实际更新正对照。

`tests/integration/layer-assign-images-font.test.ts` 共 **10项**，使用不同advance、origin、coverage的合法预渲染TFT，实际经过FontService解析、映射、测宽、drawText和像素合成。目标／源使用不同字体设置与映射，分别覆盖target.font已缓存、尚未缓存以及独立new Font(target)；检查Font对象身份、实际宽度和绘制像素。源无主图使目标图像释放后，再恢复主图验证目标字体仍能按原映射测绘。普通后端的缺字／text路径直接报错，不能用记录参数的假绘制掩盖误用源字体。

`tests/integration/layer-assign-images-binder.test.ts` 共 **34项**：Binder／Effect／Filter存图不显示、存图修改后保持不显示、子层位置／显示边界／自身opacity、Binder非零opacity透传及0隐藏、目的相关Additive子层、普通Alpha／Opaque显色对照，以及直接Binder快路径、偏移裁取和嵌套Binder原始复制终点。还覆盖无图子层没有输出、无图Binder稀疏输出、带图Binder的exposed空洞、嵌套缓存输出顺序、全不透明子层借用父位图的mask和未登记填色，以及后续Alpha／Binder消息对借用残留的初始化。正常Frame按现有renderer合同独立采样复合，再与祖先piledCopy的RGB金值分别比较；直接Binder快照另查raw RGB与mask。

合计 **64项新增源码／字节码测试**。这些是已编写的验收，不是执行通过；精确Actions提交／运行链接待后续验证记录，历史阶段的绿色结果不能替代本阶段证据。

## 保留的边界

- 没有引入完整独立province结构。当前province仍附在Bitmap上；“源无main但仍有独立province”的原版组合需要后续解耦，不能由本片的源无主图用例宣称已完成。
- 继续使用深复制，没有模拟原版bitmap共享和Copy-on-write。直接自赋值的main_changed规则已处理；两个不同Layer因先前赋值而共享同一原生bitmap、再次赋值不发Update的优化，尚未建立对应共享身份模型。
- Binder显式cached在重算周期中的完成消息顺序已处理；原版CacheRecalcRegion的热缓存历史仍未建立。嵌套缓存回归在每次raw／祖先观测前分别update，不能据此宣称后续热缓存画面一致。普通呈现仍按完整场景重组，可能重复透传原版热缓存本次不再重算的孩子。
- 全部Binder转场组合及普通祖先的位图借用优化不在本次适配范围；直接复制中的普通转场孩子继续使用既有blendTree转场图像。未重写整个原生缓存／转场系统，也不将这里的直接复制mask验收扩展为普通祖先合成已完全一致。
- 现有64MiB图像预算仍生效；本片不承诺原版资源分配失败后的逐步骤部分状态完全一致，不运行历史allocation复现。
- 无主图时clip属性getter在原版可读取ClipRect，当前getter仍要求bitmap。这是另外确认的接口差异，已报告；本片用copyRect／fillRect行为验证保留clip，不扩改getter。
- 未改Font ABI、字体注册／栅格后端、其他文字混合语义、模态pump、窗口surface或其他工作树。

## 首轮 Actions 结果

[完整回归34952630856](https://github.com/fenghengzhi/krkr2-web/actions/runs/34952630856)，提交 `c35ac758`（实现 `c580810`，已并入054的离线缓存夹具修订）：Node **1,431／1,431**，包含本片64项全部实际通过；直接运行时 **6／6**；浏览器 **1,040／1,041**。三个常规浏览器各306项、PWA59项和trusted7项全部通过；library56／57。14个作业中12成功，WebKit library与汇总失败，零跳过、flaky或未报告。

唯一失败为WebKit／JSPI远程XP3游戏库场景：首次加载后的ready断言明确报 `Page crashed`，实际等待240.964ms（预算12秒），整个case1075ms。尚未保存到游戏库、停止服务器或离线重载。XP3仅记录一字节Range读取，manifest／mjs／wasm均成功返回，全部10条网络记录状态成功；没有原生崩溃报告、调用栈或OOM证据，根因未知，不能与前轮graphics=restoring推为同因。完整14 artifacts／315文件、逐项结果、build-info与哈希独立归档，早期失败trace和作业日志保留原状。首轮失败不因新增Node全部通过而改计成功。

另行启动的KAG及发布兼容矩阵 [34954688171](https://github.com/fenghengzhi/krkr2-web/actions/runs/34954688171)复用上述准确构建；记录时尚未完成，不计为通过。

## 组合版本完整通过

[完整回归 34955337265](https://github.com/fenghengzhi/krkr2-web/actions/runs/34955337265)在 `cf564282` 通过 **1,431 项 Node、1,041 项浏览器和 6 组直接运行时**，14个作业全部成功；浏览器包含918常规、57游戏库、59 PWA、7可信生命周期，零失败、取消、跳过或flaky。[兼容检查 34954688171](https://github.com/fenghengzhi/krkr2-web/actions/runs/34954688171)在 `c35ac758` 复用构建34952630856通过 **78 项原 KAG／旧 ABI 检查**；到当前提交，应用及内核源码不变，仅文档与runner诊断改变，两个构建的来源分别保留。

本片64项、053的20项与054的30项新增Node全部包含在1,431项中。当前构建完整证据为14 artifacts／382原件，13份独立build-info及test-build归档内第14份均绑定cf564282；逐项结果和SHA-256另存root-evidence-summary.json／md。新增runner诊断实际保存12份Linux display时间线及3份macOS crash manifest，本轮没有收集到匹配崩溃报告；这不等于证明没有崩溃或已修复历史根因。原各轮失败、早期快照和未完成范围继续保留。

# 044 — Layer、Font 与管理器引用的原生生命周期

Layer 的脚本对象与显示树分别由 `src/engine/scene/layer-objects.ts` 的 LayerService 和 `src/engine/scene/layers.ts` 的 LayerTree 管理。TJS 接口保留 `new Layer(window, parent)`、parent、children、window 和 font；基本父子关系不再通过脚本成员或永久宿主句柄强持有另一侧。输入和过渡本来具有的额外强引用则单独保留。

本阶段实现了以下所有权和清理路径，尚未证明完整非插件兼容性。首次云端检查已发现并记录失败，修正尚待重跑，验证状态见文末。

## 对象与引用

Layer 通过 `registerNativeLifetime(owner, "Layer.invalidate", id, state)` 登记原生实例。原生 HostLifetime 强持有私有 Dictionary，其中保存 action owner 闭包、字体数据、惰性 Font、惰性 children Array 及其原生 clear 方法。LayerService 仅弱观察 Layer 和该 Dictionary；固定清理函数只登记一次。Layer 和 Font 构造参数使用实际原生实例身份识别，伪造 `__id` 不能代替原生对象，重复调用构造方法保留首次登记。

| 引用来源                       | 目标                                    | 所有权与释放时机                                             |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| Layer 原生私有状态             | 构造时的 Window action owner 闭包       | 强引用，包含绑定上下文；原生清理在字体和图像处理之后释放     |
| LayerTree 的 parent / children | 其他 Layer 的编号                       | 非拥有关系；基本父子边不阻止脚本对象析构                     |
| Layer 原生私有状态             | children 缓存 Array                     | 惰性强引用；Layer 清理释放引用，不使外部缓存失效             |
| children 缓存中的元素          | 快照里的 Layer 或用户写入对象           | 普通 TJS Array 强引用；clear、覆盖、刷新或缓存自身析构时释放 |
| Layer 原生私有状态             | 由 `.font` 创建的 Font                  | 惰性强引用；Layer 原生清理先 invalidate Font，再释放引用     |
| Font 原生记录                  | Layer 及其字体数据                      | 弱观察；外部 Font 不阻止 Layer 析构                          |
| 输入管理器私有 Dictionary      | focus、hover、mouse capture、modal 项   | 按角色独立强引用，随管理器状态更新释放                       |
| 过渡私有 Dictionary            | destination、source、tick callback 闭包 | 过渡期间强引用，结束或异常清理时按 VM 栈顺序释放             |
| 当前输入/过渡回调参数          | 实际目标与参数对象                      | 仅持有到本次回调结束；不延伸到后续宿主步骤                   |

依据 [LayerIntf.cpp 的 Construct / Invalidate](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L397-L508)：Owner 是不 AddRef 的指针，ActionOwner 保存强闭包；有 parent 时采用 parent 的 Manager，Manager 本身存活不等于强持有所有 Layer。`.window` 从 Manager 得到窗口，而不是简单返回构造参数。基本 parent 和 child 关系见同文件 [Join / Part / AddChild / SeverChild](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L549-L603)。

LayerTree 使用独立 managerId 标识原始 primary 管理器。primary 对象销毁后，仍存活的离树子对象保留该 managerId；最后一个相关 Layer 退役时才删除对应的管理器记录。Window 引用只在其原生记录仍有效时返回。此元数据区分已经脱离显示树的对象与新的 primary 对象，没有让宿主永久持有脚本 owner。

## children 缓存与绘制遍历

`children` 惰性返回同一个可修改的 Array，按当前树顺序填充。用户清空或写入的内容在下次原生要求刷新之前保留；加入、移除、有效的顺序调整，以及原生 completion 的子节点遍历都会使缓存过期。仅重复设置相同顺序不会刷新，无关树的结构交换也不会刷新本节点缓存。

刷新调用首次缓存的原生 Array.clear，再从当前弱树关系生成内容。因此旧快照可能是一个 child 的最后强引用：清空快照会先触发该 child 析构，重新枚举时它已经不在树中。直接失效缓存不会使下次 getter 创建新 Array；其身份保持，刷新跳过向失效 Array 写入。父 Layer 失效释放缓存引用，外部缓存仍然有效，并可以继续持有已经从父节点脱离的子对象。

这些规则来自 [GetChildrenArrayObjectNoAddRef](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L605-L647)及 [ChildChangeOrder](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1093-L1139)。[子节点遍历宏](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L203-L217)在循环结束时使缓存失效，空列表也如此，不能只依赖结构变动。

当前 `prepareFrame` 对选定树执行 onPaint 的前序调用和 children 缓存的后序失效，推进过渡后再做一次后序失效；隐藏节点与空节点也参与。它参考 [BeforeCompletion / AfterCompletion](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L5124-L5211)，但尚未逐项实现原生嵌套 Complete、transition StartProcess / EndProcess 与绘制区域完成之间的完整交错顺序，不能据此宣称整个渲染遍历已等价。

## Font 与原生失效顺序

Font 接口位于 `src/engine/tvp/font.ts`，直接构造 `new Font(layer)` 与 Layer.font 都使用原生 Layer 身份。字体参数存于 Layer 私有状态，因此 drawText、assignImages 等操作不必为了访问设置而创建 Font。直接 invalidate 缓存 Font 后，Layer.font 仍返回该失效对象；Layer 自身的字体设置和绘制路径继续存在。

原生依据包括 [惰性 GetFontObjectNoAddRef](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4903-L4913)以及 [Font Construct / Invalidate](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9627-L9653)：Font 对 Layer 的反向指针不 AddRef。Layer 失效只主动 invalidate 自己缓存的 Font；其他独立 Font 包装对象同样不持有 Layer，Layer 退役后对其字体状态访问会被拒绝，不读取已经释放的资源。

Layer.finalize 的默认实现为空。直接调用 finalize 不释放原生状态，覆写而不调用 super.finalize 也不绕过原生清理。脚本终结器成功后，清理函数在脚本成员仍可访问时依次：

1. 停止该 Layer 的过渡及以它为 source 的过渡，完成必要的结构交换。
2. 取消管理器关联和输入状态，解除 parent 关系，令各 child 脱离而不 invalidate 它们。
3. invalidate 并释放缓存 Font。
4. 释放图像，释放 action owner，再释放 children 缓存和 Array.clear。
5. 移除宿主记录和弱观察，再次取消该对象的事件来源。

进入失效时与最终退役时都取消事件，正在失效的 Layer 不再作为新回调目标。停止过渡期间 `.window` 仍可访问；进入管理器脱离阶段后返回 null，因此 Font 的脚本终结器看到的是已经脱离管理器的 Layer。子节点自己的 Manager 仍然存在。

脚本终结器抛错时，原生清理尚未开始，树、Font、过渡和其他原生状态保留供重试。Font 终结器或原生清理中的回调抛错则保留未完成状态，重试继续清理；已经完成的脱离或过渡结束不回滚。处于这种部分失效状态的 Layer 不能再挂接新 parent。部分构造失败通过实际 owner 死亡的后备路径退役资源，错误应保留原始构造错误，而不以清理错误替换。

## 输入与过渡

输入控制器的数字编号不拥有脚本对象。`InputService` 通过协作式 TJS pump 修改一个私有所有权 Dictionary；焦点、hover、capture、modal 使用按 manager 和角色区分的条目。焦点切换在 blur / focus 回调后取得新焦点引用并释放旧引用，异常分支同样执行所有权更新。单次事件的 target 与 args 在管理器继续运行之前清空；因此 onHitTest 等临时目标不会被前一次返回值额外保留。

输入依据是 [LayerManager.cpp 的 capture / hover 路径](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L354-L574)、[SetFocusTo](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L646-L692)和 [modal 引用管理](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L700-L799)。Web 的 touch capture 也使用独立所有权条目；这是触控扩展，不作为 KRKR2 鼠标管理器中已有相同 API 的证据。

输入清理区分普通 Part、primary 失效和非 primary 原生失效。原生非 primary 失效先放弃自己的 Manager，再 SeverChild，并不等同于显式 releaseCapture；该路径不会因“清理所有引用”的方便而额外提早释放鼠标 capture。事件派发仍拒绝失效目标，后续 capture 释放、管理器重置或停止会话完成相应引用释放。pump 的异常展开继续处理所有权和必要的 finally 步骤，并保留主错误。

过渡通过 TJS Dictionary 持有实际 destination / source owner 和 tick 闭包，以避免多个宿主句柄延迟释放造成的终结器顺序变化。完成时先交换结构，再在存活且允许派发时调用 onTransitionCompleted；回调参数先释放，tick 闭包随后释放。异常及失效路径使用同一协作式清理，失效中的任一端抑制完成事件。source 参数取原生 Layer 对象本体，忽略与对象无关的绑定上下文；tick 回调的闭包上下文则保留。

该顺序参考 [InternalStopTransition](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L6447-L6532)。原生失效必须先调用过渡清理，再删除 LayerTree 节点，否则过渡结构交换无法保留正确的后续父子关系。实际 owner 死亡及终止会话的后备路径只回收状态，不补发新的完成事件。

## 安全边界与未完成范围

- 同一 manager 内的 sibling、ancestor / descendant、primary 和离树节点交换保持原 manager。原生 [Exchange](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L689-L943)不交换 Manager 指针；Join 明确拒绝跨 primary manager 挂接。
- 跨 manager 时，Web 允许两个 primary 的整树交换，以及两个没有 child 的 primary 的节点交换，均保留各自的 manager / Window；涉及跨 manager Join 或不对称 primary 身份时，在修改前拒绝。原生两 primary 特例使用调用方 Manager 执行 detach / attach，存在不对称状态；Web 的原子预检是明确的安全处理，不宣称复现该异常状态。
- 当前输入和显示仍选择一个活动根管理器，多个同时显示的 manager、完整多窗口绘制与输入分发尚未完成。独立 managerId 是生命周期基础，不是多窗口支持完成的证据。
- completion 遍历已加入缓存失效边界，完整原生绘制与过渡交错仍待实现。普通脚本任意强引用环也不由这些弱树边自动回收。
- Layer 数量上限仍为 1,024，bitmap 总预算仍为 64 MiB，重挂接深度上限为 64。输入回调嵌套和异常展开保留各自预算。

终止会话先撤销输入和过渡持有、移除 Layer / Font 服务观察，再销毁 VM 与其原生私有状态。这个终止路径不执行新的脚本终结器或宿主回调，不对正常运行时的析构回调顺序作额外保证。

## 验证状态与历史保留

所有构建、类型检查、测试和可执行探测只在 GitHub-hosted Actions 运行；本地只编辑、阅读源文件和格式化。

首个 [Node 诊断运行 34925068344](https://github.com/fenghengzhi/krkr2-web/actions/runs/34925068344)针对 `2c2c295`：构建及类型检查通过，983 项 Node 中 967 项通过、16 项失败，取消及跳过均为零。浏览器和直接运行时未执行。失败涉及转场静态 helper 的 `System` 上下文解析，以及替换 Window、首次 children 快照两个夹具的作用域或帧时机；对应修正和启用状态遍历补充待下一次云端验证。该失败记录及完整产物保存在原 run ID 下，不由后续结果覆盖。

新增源码 / 原生字节码集成用例分别位于 `tests/integration/layer-lifetime.test.ts`、`layer-font-lifetime.test.ts`、`layer-input-lifetime.test.ts` 和 `layer-transition-lifetime.test.ts`；LayerTree 的缓存和 manager 检查位于 `tests/conformance/layer-tree-lifetime.test.ts`。所有权夹具在基线前预热 Array、Font、Exception，检查释放后的宿主观察、句柄和停止状态；错误用例区分脚本捕获文本、原生诊断与主错误。它们目前是待云端验证的要求，不是已通过的证据。

后续每次运行按原 run ID 保存日志、完整产物和运行元数据到 `out/verification/github-actions/<id>/`。失败、取消、中断或尚未执行的检查不能被后续绿色结果覆盖；Menu / Window 阶段已有的验证记录也不变更为 Layer 本阶段的通过证明。

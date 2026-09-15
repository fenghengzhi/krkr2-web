# 045 — Layer.update 与 onPaint 重绘链路

`Layer.update()` 请求整层重绘，`Layer.update(left, top, width, height)` 请求显示坐标中的矩形重绘。1–3 个参数会报错，多于 4 个参数忽略尾部；矩形参数经过 TJS 的整数转换。默认 `Layer.onPaint` 将包含 `type` 与实际 `target` 的事件交给构造时的 action owner，继续使用阶段 044 的私有状态和临时回调所有权。

依据是原引擎的 [update 参数入口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7839-L7864)、[默认 onPaint](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L8473-L8486)及 [UpdateByScript](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.h#L853-L857)。[官方说明](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_update.html)说明 update 会设置 callOnPaint，实际绘制前的多次请求合并。

LayerTree 先设置一次性 `callOnPaint`，再把矩形裁剪到该层及各级父层的显示边界。空矩形、负尺寸、完全越界或隐藏路径保留标记，但不单独安排可见重绘。这里不改变 bitmap clip，也不使用 imageLeft / imageTop 转换显示坐标；后续其他原因触发 completion 时，隐藏节点仍参加阶段 044 的遍历。

Session 分开记录待重绘 Layer 编号与已经提交的像素。即使 System.eventDisabled 期间像素已呈现，也不会因此丢失待派发的 onPaint。派发前清除一次性标记；一次 completion 中每层至多绘制一次。回调再次 update 自身时，按 Layer 记录独立的请求代次与截止时间；该请求的 16 ms 延时在当前执行完成后才开始。多个 Layer 共用一个指向最早截止时间的宿主计时器，最多一个计时器或排队执行在途，不在原调用栈或 Promise 微任务中循环。

显式的 `update(); piledCopy(); update(); piledCopy();` 仍可在同一个脚本操作中完成两次绘制：第二次外部 update 开始新的同步 completion。正在 onPaint 内请求的重绘继续延后，防止同一回调由尾部呈现或嵌套截图重复进入。`children` 缓存的前后 completion 失效时机保留。

新的同步绘制只替换该 Layer 的旧请求，不改变其他 Layer 的截止时间。否则每 8 ms 主动绘制一次的 B 会不断推迟 A 的 16 ms 自重绘，造成 A 永久得不到绘制。计时器到期时只记录已经到期的 `(Layer, 代次)`，实际取得 VM 执行权后再匹配当前请求、可见性与事件门控；相同 Layer 新产生的请求不能被旧任务提前解除延期，尚未到期的其他 Layer 也不会被一起释放。若 A 已到期但 B 正在异步调用中，A 在 VM 空闲后执行，不因 B 完成而重新等待 16 ms。

暂停、后台隐藏和 System.eventDisabled 撤销宿主计时任务并保留请求及其截止时间；恢复后重新安排，已经到期的请求只恢复一次，不补发历史帧。Layer 原生失效、对象退役或停止会话移除编号，待重绘集合不持有脚本对象。回调可异步挂起，异常经过现有 Input pump 展开和会话失败处理，停止撤销尚未执行的任务。

当前仍以完整场景呈现：矩形决定是否需要重绘，不提供原生复杂区域缓存、局部 GPU 上传或逐区域 completion 的性能等价。默认延时也不是浏览器 requestAnimationFrame 的刷新同步。极端 32 位坐标溢出、原生嵌套 Complete 与转场各阶段的完整交错仍需后续差分；本阶段不宣称解决它们。

新增 `tests/integration/layer-redraw.test.ts` 的源码／字节码用例覆盖 action 路由、参数、区域、快照、延期、自身失效、所有权、暂停、事件禁用以及异步异常；手动宿主时钟验证帧之间存在延时且没有任务累积。独立 `layer-redraw-fairness.test.ts` 检查多个 Layer 的调度公平性与截止时间。`tests/browser/layer-redraw.spec.ts` 覆盖双后端源码／字节码的真实像素和自主重绘，保存截图附件。

初版提交 `3754227` 的 [Node 检查 34926599954](https://github.com/fenghengzhi/krkr2-web/actions/runs/34926599954)通过 1,011 项，完整产物及运行元数据按原 run ID 保留。该结果属于公平性修正前的历史证据；后续源码审查发现其他 Layer 可不断推迟截止时间，以及已经遍历的祖先请求可能丢失，增加 8 项回归后进行了修正。

修正提交 `ebae14e` 的 [Node 诊断 34927092177](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927092177)通过 1,019 项。[完整回归 34927280464](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927280464)随后通过 **1,019 项 Node、750 项浏览器和 6 组直接运行时**，全部 14 个 job 成功；浏览器包含常规 627、游戏库 57、PWA 59、可信生命周期 7，零失败、取消、跳过、flaky 或重试。使用同一构建的[原 KAG／旧 ABI 升级 34927347461](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927347461)另通过 **78 项**。后续合并阶段 044 的记录只改变文档，不改变这些已测应用源文件。

本阶段新增 32 项 Node 与三浏览器双后端的 24 项浏览器检查。原始报告、像素附件、完整构建和 run.json 均按原 run ID 保存在 `out/verification/github-actions/`。本地仅阅读、编辑、格式化和检查已有云端产物；所有构建、类型检查、Node、浏览器与可执行探测均由 GitHub-hosted Actions 执行。阶段 044 及更早的结果作为各自历史证据保留，不替代本阶段回归。

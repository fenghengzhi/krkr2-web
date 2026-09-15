# 045 — Layer.update 与 onPaint 重绘链路

`Layer.update()` 请求整层重绘，`Layer.update(left, top, width, height)` 请求显示坐标中的矩形重绘。1–3 个参数会报错，多于 4 个参数忽略尾部；矩形参数经过 TJS 的整数转换。默认 `Layer.onPaint` 将包含 `type` 与实际 `target` 的事件交给构造时的 action owner，继续使用阶段 044 的私有状态和临时回调所有权。

依据是原引擎的 [update 参数入口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7839-L7864)、[默认 onPaint](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L8473-L8486)及 [UpdateByScript](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.h#L853-L857)。[官方说明](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_update.html)说明 update 会设置 callOnPaint，实际绘制前的多次请求合并。

LayerTree 先设置一次性 `callOnPaint`，再把矩形裁剪到该层及各级父层的显示边界。空矩形、负尺寸、完全越界或隐藏路径保留标记，但不单独安排可见重绘。这里不改变 bitmap clip，也不使用 imageLeft / imageTop 转换显示坐标；后续其他原因触发 completion 时，隐藏节点仍参加阶段 044 的遍历。

Session 分开记录待重绘 Layer 编号与已经提交的像素。即使 System.eventDisabled 期间像素已呈现，也不会因此丢失待派发的 onPaint。派发前清除一次性标记；一次 completion 中每层至多绘制一次。回调再次 update 自身时，剩余请求通过一个延后 16 ms 的宿主任务进入下一次串行执行，不在原调用栈或 Promise 微任务中循环。最多一个任务或排队执行在途，下一次延时在当前工作完成后开始。

显式的 `update(); piledCopy(); update(); piledCopy();` 仍可在同一个脚本操作中完成两次绘制：第二次外部 update 开始新的同步 completion。正在 onPaint 内请求的重绘继续延后，防止同一回调由尾部呈现或嵌套截图重复进入。`children` 缓存的前后 completion 失效时机保留。

新的同步绘制会撤销旧计时器并使已排队的旧任务过期，避免旧任务在异步 onPaint 挂起期间到期后提前触发下一帧。任务只在实际取得 VM 执行权时解除延期，并重新检查代次、可见性与事件门控；启动后的 resize 或其他已排队事件也不能提前消耗回调请求。

暂停、后台隐藏和 System.eventDisabled 撤销宿主计时任务并保留可恢复请求；恢复后重新安排。Layer 原生失效、对象退役或停止会话移除编号，待重绘集合不持有脚本对象。回调可异步挂起，异常经过现有 Input pump 展开和会话失败处理，停止撤销尚未执行的任务。

当前仍以完整场景呈现：矩形决定是否需要重绘，不提供原生复杂区域缓存、局部 GPU 上传或逐区域 completion 的性能等价。默认延时也不是浏览器 requestAnimationFrame 的刷新同步。极端 32 位坐标溢出、原生嵌套 Complete 与转场各阶段的完整交错仍需后续差分；本阶段不宣称解决它们。

新增 `tests/integration/layer-redraw.test.ts` 的源码／字节码用例覆盖 action 路由、参数、区域、快照、延期、自身失效、所有权、暂停、事件禁用以及异步异常；手动宿主时钟验证帧之间存在延时且没有任务累积。`tests/browser/layer-redraw.spec.ts` 覆盖双后端源码／字节码的真实像素和自主重绘，保存截图附件。

验证尚未执行。本地仅阅读、编辑和格式化；所有构建、类型检查、Node、浏览器与可执行探测必须由 GitHub-hosted Actions 执行。阶段 044 及更早的结果不能当作本阶段通过证据。

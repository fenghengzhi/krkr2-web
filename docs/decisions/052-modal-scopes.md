# 052 — 合作式模态循环的 scope 基础

本阶段先实现独立的 `src/engine/scheduler/modal-scopes.ts`。它管理 host 侧身份、栈和等待生命周期，尚未接入 Session、SystemEvents、ExecutionControl、TJS pump 或 DOM。`Window.showModal` 与 `Menu.popup` 的完整嵌套事件循环仍未实现，不能以此组件的测试代替实际 VM/浏览器验证。总体边界见[多窗口规划](048-multiwindow-plan.md)。

每个 scope 只保存种类、数字 owner/window 身份、父 token、原始类型结果和可选同步 host 清理回调；不导入 ScriptRuntime，也不保存或保留 ScriptObject。token 在单个组件实例内单调递增，不随 owner ID 重用；会话之间的消息仍需由 Session generation 隔离。返回的身份和终态对象冻结，外部调用不能修改内部记录。默认最多 16 层，可配置为 1–64 层；这是 host 资源预算，不声明原生引擎具有相同限制。

| API                                                | 合同                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open({kind, ownerId, windowId?, cleanup?})`       | 创建当前 top 的子 scope，返回 token。种类为 window/menu，身份为正安全整数。已结束的 top 必须先 release；stop 后不能再 open。                                                                           |
| `info(token)` / `top` / `depth`                    | 查询登记身份和栈状态，过期 token 返回 undefined；同 owner ID 的后续 scope 仍是不同 token。                                                                                                             |
| `finish(token, value?)` / `cancel(token, reason?)` | 第一个终态生效，重复或过期操作返回 false。value 只能是 undefined/null/boolean/string/number/bigint；cancel 默认原因是 cancelled。结束祖先会将尚未结束的后代标为 ancestor-ended，但保留它们已有的终态。 |
| `wait(token, ready)`                               | 返回 completed/value、cancelled/reason 或 work/token。终态优先于工作；只有 active top 在未暂停时调用 ready。ready 只能检查工作是否就绪，不能取任务或执行脚本。同 token 只能有一个待处理 wait。         |
| `canDispatch(token)`                               | 在实际取工作前重新检查 token 是否仍为未结束、未暂停的 top。work 只是提示，不是不可撤销的执行许可。                                                                                                     |
| `notify()` / `setPaused(boolean)`                  | 工作生产者先更新自身状态再通知；暂停时不检查 ready，恢复时重新检查。没有轮询定时器；终态和 release/stop 仍可解除暂停中的等待。                                                                         |
| `release(token)`                                   | 正常退出必须按 LIFO；释放非 top 报错，过期释放返回 false。先移除记录和解除该 wait，再执行一次 cleanup；即使 cleanup 抛错也通知父层。未先结束的 scope 以 released 原因取消。                            |
| `stop(reason='stopped')`                           | 永久停止，先移除全部身份，逆序解除所有 wait，再逆序执行每项 cleanup。已有终态保留，未结束项取消；全部清理均会尝试，异常以 AggregateError 汇总。重复 stop 无副作用。                                    |
| `pendingWaits` / `stopped`                         | 分别报告仍登记的 scope 中待完成的 wait 数量和终止状态。release/stop 撤销登记后不再计数；被唤醒的 Promise 随微任务完成。                                                                                |

`wait` 先安装唤醒闩，再检查终态和 readiness。因此检查期间同步 notify、结束、暂停或打开子 scope 不会丢失通知；ready 返回 true 后还会重新检查 top、暂停和终态。ready 抛错会拒绝此次 wait 并移除等待状态，调用方可执行正常退出。ready 应当是有界的就绪检查，不能自身不断制造新通知或承担任务派发。

祖先先结束时，后代 wait 可取得取消结果，但祖先 wait 仍等它再次成为 top 后才返回；调用栈的正常退出保持严格嵌套。只有终止整个组件的 stop 会强制撤销所有层，它不依赖脚本 catch/end 是否能执行。cleanup 必须同步、仅清理 host 状态，不能返回 Promise、执行 TJS 或等待另一层；异步媒体关闭仍由后续 Session 生命周期接线负责。

未来 host pump 可 `await scopes.wait(token, hasRunnableWork)`，work 分支在 `canDispatch(token)` 后再取工作并返回既有 `HostReply.invoke`，完成分支返回对应结果；无需打开 ScriptRuntime 的顶层重入或改变原生 ABI。这个组件没有决定 SystemEvents 的优先级/截止序号、输入接受 ACK、帧提交或视频完成屏障；这些都是后续真实模态循环的必要部分。ExecutionControl 的暂停、恢复、取消也需要显式接到组件，当前没有自动注册。

新增 `tests/conformance/modal-scopes.test.ts` 的 34 项纯逻辑测试，检查外部通知与暂停、完成优先、严格嵌套、祖先结束、陈旧身份、异常和重入清理、永久终止。全部可执行验证只由 GitHub-hosted Actions 运行；本地仅阅读、编辑与格式化，本次尚无新增通过结果。

## 系统事件的受控嵌套入口

`SystemEvents` 同时增加只读 `hasDispatchableWork()`、返回原有 TJS pump continuation 的 `beginNested()`，以及宿主唤醒订阅 `subscribePending()`。它们不另起 VM 入口，也不抽取 SerialQueue 任务。优先级、外层正在执行的事件、全局截止序号以及 `System.eventDisabled=false` 的原有同步嵌套语义保留。

只有不可重入的连续事件通知时，就绪查询返回 false；真正的嵌套轮次若因其他排队事件进入连续派发阶段，仍按原生顺序先消费合并通知再拒绝重入，不能将其擅自留给父轮。通知、暂停、禁用和释放会唤醒订阅者，抛错的订阅者会被移除，避免遗留尚未完成的排队 Promise。新增 10 项纯调度测试与上述 34 项 scope 测试共同等待 Actions 验证。

这两个组件尚未相互接线。输入接受 ACK、每事件原生安全 checkpoint、视频完成屏障、绘制推进与真实 `Window.showModal`／`Menu.popup` 仍是后续实现，当前不声明模态功能完成。

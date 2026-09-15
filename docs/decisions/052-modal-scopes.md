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

## 首轮 Actions 记录

[Node 诊断 34941302575](https://github.com/fenghengzhi/krkr2-web/actions/runs/34941302575)在 `ce17a66` 完成类型检查与生产构建，但整体失败。新增 scope 34 项、嵌套调度 10 项全部实际通过；总计 1,300 个案例通过、1 个测试文件因 SIGTRAP 失败，预期 1,340 个案例中另有 40 个未报告。文件失败占位不能计为一个普通案例，未报告也不能计为跳过或通过。浏览器及直接运行时在该诊断中未运行。

中止的是原有 `object-lifetime.test.ts`，其 68 项只报告 28 项通过。Node v24.19.0 的 V8 再次触发 `jit_page_->allocations_.erase(addr) == 1`，本次回溯经过 NativeModule::FreeCode。它与此前记录的断言相同，但不能据此断定根因相同或已修复。完整 run.json、TAP 和回溯保留在该 run 的独立归档；只读逐项核算在 `out/verification/multiwindow/node-v8-34941302575.md`。这次组件通过不代表尚未接线的模态功能完成。

## 接收与事件体结算

`SystemEvents.enqueue()` 现在同步返回 accepted/discarded 及该事件体的 completion Promise。销毁、容量或参数拒绝在接管新任务前同步抛出；旧 `post()` 包装它并保留 Promise 接口。新增 `onSettled(outcome, roundToken?)` 在事件体结束、失效、丢弃或取消时同步调用一次，早于 completion；已取队任务携带所属 round，未取队任务没有 round。调用者必须先登记自己的资源记录，再调用 enqueue，因为丢弃或同步调度失败可以立即结算。

任务先从队列／current 分离再结算，重入取消和销毁不会覆盖后来的任务。取队时 onTaken／valid 抛错也会收敛取出的任务；hook 与诊断回调异常隔离，实际原生引用释放错误在尝试其余清理后继续向调用方传播。新增 17 项测试检查这些边界，尚待 Actions。这里的事件体完成仍不代表 native release、画面提交或完整 Session checkpoint；浏览器接受 ACK、逐事件 checkpoint 和视频屏障还没有接线。

## Windows 菜单参考探针

新增 `tests/probes/native-menu-flags.cpp` 和独立 Actions 工作流，仅在 GitHub-hosted Windows 2022／2025 上运行。首版对自建菜单验证 NoNotify／ReturnCmd／Recurse 三个位的八种组合及选择／Esc，共每平台 16 项；通过本进程窗口和线程的真实菜单消息循环注入，记录原始返回值与 WM_COMMAND 顺序。没有全局输入，也没有运行本机探针。每例和进程均有截止时间，失败、不可执行、超时与未运行保留原始产物。

它只比较 Win32 TrackPopupMenuEx，不证明旧 VCL 命令 ID 分配，也尚未测试已有菜单中的真正递归。无 ReturnCmd 的取消 BOOL 原样记录，不预先规定值。执行结果与尚未完成的覆盖见下面记录，不能将部分用例成功作为整轮通过证据。

## 接线前的失败记录与修订

[首次完整回归 34945297088](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945297088)，提交 `6671c42`，在测试类型检查阶段因新夹具的 `retain` 缺少参数而失败（TS2352）。Node、浏览器和直接运行时案例均未执行。修订让夹具接收 `ScriptObject` 参数，与实际接口一致，没有绕过类型检查或放宽断言。

同一提交的[首次 Windows 菜单参考运行 34945297180](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945297180)在 Windows 2022、2025 均停于编译器定位，尚未编译或执行 C++，每个平台的 16 项均未运行。原工作流没有保存足够的 Visual Studio 查询信息，不能据此断定 runner 缺少编译器。修订从 `installationPath` 解析 `vcvars64.bat` 和默认 x64 工具，保存完整安装清单、查询参数、stdout、stderr、退出码及文件存在状态，并区分查询失败、无匹配和布局缺失。两次失败的完整产物及 run.json 保留在各自独立归档，后续结果不会覆盖它们。

[第二次 Windows 菜单参考运行 34946408599](https://github.com/fenghengzhi/krkr2-web/actions/runs/34946408599)，提交 `9cb5e92`，两平台均成功发现并运行编译器：Windows 2022 使用 VS `17.14.37614.0`／默认 MSVC `14.44.35207`，Windows 2025 使用 VS `18.9.12120.119`／默认 MSVC `14.51.36231`；`compilerDiscoveryState=ready`、编译退出码均为 0。两平台探针均以 1 退出，整体失败。每个平台 16 个用例实际进入菜单循环，其中 8 个取消用例完成观察并通过现有断言，8 个选择用例为 `not-executable`，没有超时或普通断言失败。取消时，无 ReturnCmd 的四组均返回 1，有 ReturnCmd 的四组均返回 0，没有 WM_COMMAND；这些仅是本次两平台的 Win32 取消观察，不证明旧 VCL 或真正嵌套行为。

选择失败来自探针没有建立真实高亮：两平台 case 2 的 Home 按下／抬起确实经过系统 MSGF_MENU，后续 hook 返回 0，但发送 Enter 前 `GetMenuState=0`、`MF_HILITE=false`，没有目标项的 WM_MENUSELECT，之后 Enter 使菜单结束且没有 WM_COMMAND。其余选择组合相同。返回 BOOL=1 不能证明选中了命令；原有高亮门槛正确拒绝了这些结果。轨迹只能证明这条 Home 注入路径没有建立选择，不能确定 Windows 内部忽略它的具体原因。

修订改用 [Win32 标准菜单键盘接口](https://learn.microsoft.com/en-us/windows/win32/menurc/about-menus#standard-keyboard-interface)明确列出的 Down，补齐 [WM_KEYDOWN 导航键的 extended 位](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-keydown)，每次配对抬起后再读取真实高亮。两个叶子最多尝试两次 Down；只有目标实际高亮才发送 Enter，否则发送本窗口的 Esc 清理并保留选择用例 `not-executable`，不会改计取消成功。没有人工设置高亮或合成 WM_COMMAND，原始返回／通知顺序断言和 3 秒／180 秒截止时间保留。该修订尚未运行；第二轮完整产物与 run.json 保存于 `out/verification/github-actions/34946408599`，前一轮归档保留原状。

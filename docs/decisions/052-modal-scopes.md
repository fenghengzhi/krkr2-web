# 052 — 协作式 Window 模态循环与原生检查点

输入接收确认、逐事件 native checkpoint、视频完成票据、ModalLoop 与 Window.showModal 业务已在精确提交 `2683b304fa32e409941c84b723d80d53b5d6ac8d` 通过完整 Actions：**1,646 项 Node、1,095 项浏览器、6 组直接运行时**；同一提交、同次构建的兼容检查另通过 **78 项**。已测应用在 `5e54ceb` 合入 main，完整来源见文末。会话协议 11、TJS ABI 5、字体 ABI 2；内核要求 `nativeReleaseState: 1`。

Menu.popup 的新嵌套业务仍在 052 工作目录实现，未验证、未合入 main，不能纳入本次通过范围。旧 VCL 二进制关闭时序、菜单 flags 及真正原生递归的未知项仍保留，完整非插件目标未完成。以下按步骤保留当时的实现状态、失败及未报告证据；早期“尚未执行／尚待接线”描述不覆盖文末的最新验证结果。

## 初始 scope 基础（阶段历史）

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

## Session 与浏览器的接收确认

EngineSession 增加同步的 `acceptInput`、`acceptActivateWindow`、`acceptCloseWindow`、`acceptMenuClick`，返回 accepted／ignored 及独立 completion；参数或入队拒绝同步抛错。原同名完成接口（不含 accept 前缀）继续返回 Promise。关闭和菜单回调的临时 lease 在 onSettled 同步释放，真实释放错误保留在该操作的 completion 中。当前 completion 仍等待原 execute 尾部和队列 drain，尚未替换为逐事件 native checkpoint。

会话协议升为 11：上述四类 Worker RPC 在接收后立即回复状态，页面输入协调器因此可以继续发送后续包，不等待第一个脚本回调结束。Worker 的 64 项未完成预算覆盖这些入口及原 click／pointerMove，直到对应 completion 结算才释放；同步拒绝立即回滚，异步拒绝由捕获的 Session 处理。旧 click／pointerMove 仍等待完成。普通 TJS 回调错误继续走 System.exceptionHandler／eventDisabled，不因 ACK 改成会话强制失败。

新增 18 项源码／字节码 Session 检查，覆盖挂起期间接收后续事件、FIFO、执行尾部、忽略／拒绝、回调期间与排队期间的不同引用规则，以及 Stop 清理；新增 6 个浏览器模板，分别检查真实 HTTP 读取未完成时鼠标／键盘包已接收，放行后的顺序，以及回调异常后 VM 保留。全部尚待 Actions；这些用例不证明模态泵、视频 ACK 或帧提交屏障已经接通。

接收修订之前的[第二次完整回归 34946408644](https://github.com/fenghengzhi/krkr2-web/actions/runs/34946408644)在 `9cb5e92` 最终失败：Node **1,378／1,378**、直接运行时 **6／6** 通过；浏览器 **1,040／1,041** 通过，无跳过、flaky 或未运行案例。14 作业中 WebKit 常规及汇总作业失败，其余 12 成功。Node 包含新增结算 17 项、scope 34 项及嵌套调度 10 项，不含本节接收接口及 18／6 项新测试。

唯一失败为原有 `image-writing.spec.ts` 的 Asyncify 保存／重载场景，等待首次 `saved-ready:0:1` 超时；尚未进入编码与像素断言。trace 在上传完成约 220ms 后记录 WebGL context loss，页面等待恢复，Window1 仍隐藏，图层与存档均为零。同期游戏库存储的 unknown transient 错误不能作为 OOM 证明；没有 Page crashed、pageerror 或失败网络记录，根因未知。完整产物、run.json、WebKit 作业日志和逐项摘要独立归档，不能与旧 JSPI TLG5 Stop 场景混为同一次故障。

## 第三次 Windows 参考结果

[34947283449](https://github.com/fenghengzhi/krkr2-web/actions/runs/34947283449)，提交 `c9a57d8`：两平台编译成功，每平台 **16 项全部完成观察，14 通过、2 断言失败**，零超时或不可执行。所有选择均通过一次 Down 建立真实高亮，再经 Enter 返回。失败仅在 flags=0x80／0x81 的选择场景：NoNotify 且无 ReturnCmd 时仍收到一条正确命令的 WM_COMMAND，顺序均在 TrackPopupMenuEx 返回之后。此前“任一 N/R 位都会抑制命令”的 N-only 部分只是文档推断，已被本次观察反驳，不能继续作为确定实现合同。

本轮所有 ReturnCmd 组合选择返回 16913、取消返回 0，且无 WM_COMMAND；无 ReturnCmd 的选择与取消均返回 1，选择各有一条命令，取消无命令。原始 flags 原样传入 USER32，消息处理器只记录，没有补发命令。此结果不证明硬件输入、鼠标选择、旧 VCL 或真正递归；官方说明与该键盘观察的差异仍待进一步对照。整体失败及原始断言保留，未通过修改预期追认本轮成功。完整产物、run.json 和 workflow.log 保存在独立归档。

## 接收确认的首轮回归

[34947632067](https://github.com/fenghengzhi/krkr2-web/actions/runs/34947632067)，提交 `18b1c71`：Node **1,396／1,396** 通过，包含 18 项新接收检查；浏览器 **1,053／1,059** 通过，直接运行时 **6／6** 通过。Chromium／Firefox 常规各 312 项全通过；WebKit 原 306 项全部通过，新增 6 项均在启动夹具等待第一次鼠标回调时失败，未进入 ACK 断言。

六份 trace 的实际 mouseMove／mouseDown 坐标都是 `(485,-1353.3125)`，视口为 `1280×720`。WebKit 的 canvas.focus 没有将画布滚回视口，后续原始指针操作未命中游戏；没有 context loss 或 Page crashed 记录。这是夹具的操作前置问题，不能归为旧 GPU 失败。修订在真实 mouseDown 前显式滚动画布并检查完整可见；保留 HTTP 读取门闩、实际输入 ACK、回调顺序及异常处理断言，不添加再次点击或改变产品焦点规则。完整失败产物与逐项摘要独立保留，修订尚待新 Actions。

## 接收确认的第二轮回归

[34950107231](https://github.com/fenghengzhi/krkr2-web/actions/runs/34950107231)，提交 `07292d5`：**1,396／1,396 Node、1,059／1,059 浏览器、6／6 直接运行时**全部通过，14个作业均成功，无失败、取消、跳过或 flaky。新增18项Node及6模板×3浏览器的18项均实际通过；12份读取门闩附件确认输入接收时storagePending仍为true。完整310文件／14 artifacts、run.json、逐项摘要与哈希独立保留。该提交不含下面的检查点／ModalLoop／原生drain能力，不能作为后者的验证。

## 逐事件原生检查点与模态驱动接线

Session 的接收票据现在分别记录事件体结算、错误处理结束、自己的 native continuation 完成以及轮次尾部处理。取队时连续跳过的失效事件用 round→集合归账；Stop、执行异常和 continuation 进入前的失败也能找到这些已脱离事件队列的票据。关闭／菜单的临时引用按原结算点释放，提前持有的视频引用在未取队取消时由专属清理检查点接管。

TJS SystemEventPump 在每事件之后只推进输入所有权、原生释放和必要关闭清理，**不在每事件之间绘制**。[原版 EventIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.cpp)在 exclusive／input／normal 之后，才经一次尾部许可进入 idle／continuous／window update。新增只读尾部许可与正常耗尽标记，只有合法轮次尾部执行合并绘制；只有帧工作时可进入等价空轮。普通输入票据保留尾部执行或明确跳过的完成边界，视频还要等待相关存活窗口在自身 native 完成之后的成功呈现。renderer=false、隐藏空帧和父 onPaint 尚未返回均不能冒充该视频帧完成。

CheckpointPump、发布与提交通过各自的 HostReply.invoke 在同一个原生调用栈中串联；不开放 busy 重入，也不从模态 host 调用顶层 collect／invoke。祖先释放或 onPaint 尚在栈内时，票据保留但返回驱动循环，让其他可执行事件继续。到期重绘和转场用明确帧工作唤醒，不从 SerialQueue 抽取任意闭包。ModalLoop 只等待与选取工作，已接入 Session 的暂停、恢复、取消和原生回调绑定；具体窗口显示、关闭及菜单 flags 仍属下一步。

新增只读 `krkr_release_draining` 导出及 `runtime.inspect().drainingReleased`。原生释放会先将当前对象从待释放集合移出，再执行可挂起的析构；因此 pendingHandles=0 不代表整个 drain 已完成。新字段直接读取该活动状态。ABI 5 的既有调用形状不变，manifest 新增 `nativeReleaseState:1`；新页面检查该能力，运行时在创建 VM 前检查真实导出，缺少支持的旧内核明确拒绝，不能以默认 false 掩盖缺失。

本片新增 17 项 ModalLoop 生命周期、8 项事件尾部、24 项真实 Session、14 项视频完成边界以及 7 项原生释放状态／缺能力拒绝检查，共预期 70 项 Node；其中原生状态覆盖源码／字节码的正常、析构抛错和取消。额外包含隐藏但未暂停时的普通票据尾部与非模态主窗口关闭后继续执行语句；所有这些检查均尚未执行，不能计为通过。新增接口也尚未在真正 Window.showModal／Menu.popup 嵌套场景下验收，后续仍需实际浏览器双后端验证。

## 检查点首轮失败与修订

[34953109684](https://github.com/fenghengzhi/krkr2-web/actions/runs/34953109684)，提交 `6b81180`，新内核、类型检查及生产构建成功。Node实际报告 **1,456通过、8失败、2取消（各60秒超时）／1,466项**，没有跳过或未报告。五组源码／字节码问题分别为：裸字符串析构异常没有message、旧零所有权期望缺四个字段、开启事件时提前消费延期重绘、主窗口关闭completion早于请求停止，以及隐藏视频窗口一直等待可见呈现。完整TAP、作业日志及逐项诊断保存在本次独立归档，均保留为失败证据。

修订使用带message的Exception夹具并补齐所有权零值，保留原特定消息和清理断言；只有实际模态定时器捕获的Layer/generation才解锁延期绘制。非模态主窗口关闭继续执行当前VM剩余语句，在原生返回后的同一host turn完成票据并请求退出。隐藏视频窗口保留解码像素、明确跳过呈现义务，仍需callback／native／清理／尾部完成；不增加成功present计数，visible且renderer返回false仍必须等待。新增两项从visible转hidden的回归，修订后预期 **1,468 Node**，尚未执行。

同一轮Firefox/PWA实际19／20通过，唯一失败为corrupt deployment夹具在浏览器启动时报 `cannot open display: :99`，进程exit 1，尚未创建页面或执行应用；没有足够Xvfb日志确定原因。旧REPAIR用例本轮通过，不能追认此前竞态已修。这里另外纳入054已加强且实际通过的REPAIR前置及缓存内容断言；该修订并不声称解决显示服务器失败。首轮最终浏览器1,058／1,059、直接运行时6／6；常规三浏览器各312项全通过。14作业中11成功，Node、Firefox/PWA与汇总失败。原早期快照保留，另存finalrun.json与完整逐项摘要。

## 检查点第二轮 Node 证据

[34954669374](https://github.com/fenghengzhi/krkr2-web/actions/runs/34954669374)，提交 `3274d3e`，Node作业失败：TAP的1,467条记录包含1,464个命名案例通过、2个命名案例断言失败，以及1个文件级SIGTRAP占位。预期1,468个真实案例中，graphics-lifecycle.test.ts后两项没有报告，不能计为跳过或通过，也不能用占位编号差推定是否开始执行。其前四项已报告通过。V8报 `jit_page.has_value()`，栈含UnregisterWasmAllocation／FreeCode／FreeDeadCode／TierUpWasmToJSWrapper；这是不同于历史erase断言的新证据，glibc build-id不匹配限制系统帧可信度，根因未知。完整日志、core哈希及回溯独立保留，未运行本地复现。

两个命名失败都是新visible→hidden视频用例：视频票据已完成，但隐藏活跃窗口另产生一项deactivate输入票据，严格全局计数把它误作视频残留。修订在发帧前明确完成deactivate作为setup，关键视频completion之后不追加idle、不放宽计数或呈现断言。测试预期仍为1,468。首轮十项非通过案例本轮均实际通过；这些局部结果不能把第二轮改计成功，修订也尚待新Actions。记录时浏览器矩阵仍在运行。

## Window.showModal 业务接线（尚待验证）

`Window.showModal()`通过既有ModalLoop返回HostReply continuation，在同一TJS调用栈上保留调用者局部变量。独立WindowModals管理窗口请求身份、关闭查询和接受结果，隐藏本身不结束modal；进入前拒绝可见、全屏、已模态或失效窗口。每次TJS调用持有独立request对象，native释放在pump进入前抛错时，catch只撤销匹配identity的尝试，不伤旧scope或同窗口后续调用。

脚本close记录请求，当前窗口自己的wait就绪检查才准备onCloseQuery；父窗口的查询与接受结果不提前结束正在执行的子模态。base onCloseQuery(true)先记录本窗口结果，当前回调仍可继续开子窗口；自己的循环恢复后才消费结果并隐藏。false只清等待查询，不撤销已有接受结果；不调用base或仅return true不构成接受。实际mainWindow按原默认规则失效并请求退出。未进入回调的内部查询被子modal清掉旧输入时，记录带generation的重新查询请求，避免永久queryPending。宿主close completion在已接受时还等待对应scope真正隐藏、解除阻塞和清理；否决或等待异步答复时只等待本次query收尾。

原版固定WindowIntf.cpp的ShowModal调用ClearAllWindowInputEvents；此处清除旧排队输入，保留正在执行的输入generator及其父调用栈。WindowView新增host-only可选blocked；脚本visible/focusable不被改写。页面以inert、Tab排除与输入协调器停止接收处理阻塞，Session也拒绝过期或被阻塞窗口的输入、激活、菜单及宿主几何操作。可交互的模态窗口位于被阻塞的置顶／全屏窗口上方，解除后恢复原堆叠规则。退出时隐藏存活窗口、恢复仍可见可聚焦的原窗口或合格后备；新焦点命令在解除blocked的roster之后发送。

固定原版 `WindowFormUnit.cpp` 的OnCloseQueryCalled明确只为自身写ModalResult，false不清已有结果；已下载原始文件及SHA-256。旧发行使用的具体VCL Forms实现没有随仓库提供，因此“script close先写mrCancel、稍后自己的modal loop发query”及“已接受后再次close可重开查询”是依据原包装与现代VCL合同作出的实现选择，不能写成已观察到的旧VCL运行结果。相关源审记录为 `out/verification/multiwindow/window-modal-close-contract.md`。

本片新增24项纯WindowModals、8项BrowserInputCoordinator、16模板×源码／字节码共32项真实TJS，以及6个两内核真实浏览器模态模板；页面另有6个host交互模板。Node共新增64项，浏览器新增12模板×三浏览器共36项。当前均仅编写，未本地执行，也未以之前基础组件的绿色记录替代这些新路径。完整Menu.popup循环、flags与递归通知仍待后续实现。

## Window业务首轮构建失败

[34955651956](https://github.com/fenghengzhi/krkr2-web/actions/runs/34955651956)，提交 `1795766`，在测试类型检查失败：新增BrowserInputCoordinator用例的空数组deepEqual断言将后续packet元素收窄为never，报TS2339。修订为等价的length=0断言，保留随后另一窗口实际activate包的精确内容检查；未放宽类型检查或产品行为。本轮Node、浏览器、直接运行时案例均未执行，不能报告新模态功能通过。完整build logs与工作流记录独立保留。

## Window业务第二轮与定向诊断

[34955789389](https://github.com/fenghengzhi/krkr2-web/actions/runs/34955789389)，提交 `2c3ba46`：Node **1,530／1,532**，浏览器 **1,093／1,095**，直接运行时 **6／6**。新增24项纯scope、8项输入协调器、30／32项Window集成，以及全部36项新浏览器模态／host交互实际通过；失败和未完成断言不计为通过。整轮11作业成功，Node、WebKit常规及汇总失败。

两项Node失败在显式失效后看见一个未执行的激活票据。[Node诊断34988293427](https://github.com/fenghengzhi/krkr2-web/actions/runs/34988293427)，提交 `ac085d3`，记录了实际状态：TJS回调失效自身后继续通过该失效对象上下文查找mark函数，抛出“The object is already invalidated”，正常异常处理因此禁用事件；scope已释放、父调用已返回，剩余票据尚未进入事件体。修订在失效前将日志函数绑定到global，保留失效、父窗口可用和eventDisabled=false断言，没有改变TJS失效语义或绕过事件错误处理。

诊断共 **1,529通过、3失败／1,532**；除上述两项外，源码视频隐藏夹具在首个renderer拒绝后只等待一个host turn，就要求checkpoint已完成，实际仍有一个合法检查点。修订在隐藏操作之前等待对应事件队列返回，renderer仍拒绝且视频completion仍须保持pending；隐藏后的ACK、引用计数及像素断言不增加idle，不放宽检查。诊断的浏览器与直接运行时未执行，独立失败证据保留。

第二轮WebKit两项失败均属既有模板：图像保存首次启动前记录真实WebGL context loss，最终graphics=lost并等待恢复，未到编码像素断言；视频时钟的period／EOF已到达，但原故障夹具未实际收到可丢弃的播放帧回调，dropped=0。前者根因仍未知，三个macOS诊断manifest没有匹配原生报告，不能据此排除崩溃。后者将故障注入改为播放开始时撤销真实已登记回调、播放中登记后立即撤销，保存registered／withheld／primed证据；继续要求真实首帧、明确被阻止的回调、period／EOF及Stop清理，避免把原生回调恰好未到达当成故障注入已执行。

## Window 与检查点完整验证及合入 main

[完整回归 34989855109](https://github.com/fenghengzhi/krkr2-web/actions/runs/34989855109)在精确提交 `2683b304fa32e409941c84b723d80d53b5d6ac8d` 最终成功，14 个作业全部通过。该提交包含本阶段的输入 ACK、原生检查点和 Window.showModal，以及已合入的 053／054／055 图层组合。

| 验证范围                  | 实际结果                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| Node 行为与集成           | 1,646／1,646；TAP 编号连续，失败、取消、跳过、todo 均为 0           |
| 常规浏览器                | Chromium、Firefox、WebKit 各 324／324，共 972 项                    |
| 游戏库／PWA／可信生命周期 | 57／57、59／59、7／7；浏览器合计 1,095／1,095                       |
| 直接运行时                | 三浏览器 × Asyncify／JSPI 共 6／6 组；failures 和各组 errors 均为空 |
| 同次构建的兼容检查        | 78／78；KAG 36、原菜单／面板 6、诊断 6、旧 ABI 离线迁移 30          |

浏览器案例均首次执行通过，没有 flaky、重试、结果错误或全局报告错误。其中真实 Window 模态的源码／字节码与 Stop 为 6 模板 × 3 浏览器，共 18 项；页面宿主的阻塞、焦点、置顶／全屏堆叠和移动／缩放取消另有 6 模板 × 3 浏览器，共 18 项，均已包含在上述总数内。Node 包含修订后的内部关闭查询重试、宿主关闭完成边界、父子模态、显式失效及原生释放／视频票据用例；不再以早期组件测试代替这些实际接线路径。

[兼容检查 34991339560](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991339560)使用同一精确提交和完整回归 `34989855109` 的构建，三浏览器各 26 项通过。全部 36 份 KAG 详细记录的 `observedWithoutError=true`，错误数组为空；30 项离线迁移的目标 build 均为 `9e74646937621c2b840267f1683a8566b9d9c7054a6ff2b659a732954a698e08`，与生产归档的 Service Worker／HTML 标记一致。

完整回归的 13 份外部 build-info 与归档内 1 份字节相同，SHA-256 为 `af6b0f33bead2b26c21ef64684f88907340eadd20cf4f17843813fdff0f2756a`，均标记上述提交、run `34989855109`、attempt `1`。内核复用了相同原生源码的缓存，本轮没有重新编译内核；ABI 5、`nativeReleaseState: 1`、`diagnosticAllocator: false`，归档资源的大小和哈希匹配清单。共享 build-info 描述的是构建环境，不是各浏览器测试 runner 的环境。

已下载完整回归 14 个 artifact／379 个原始文件，兼容检查 3 个 artifact／261 个原始文件。逐例结果、构建来源和 SHA-256 清单分别保存于 `out/verification/github-actions/34989855109/root-evidence-summary.json` 和 `out/verification/github-actions/34991339560/root-evidence-summary.json`，并有同名 Markdown 摘要；原始产物在各自 `complete/` 目录。全部测试、构建和探针由 GitHub-hosted Actions 执行，本地只解析已完成运行的证据。

本轮三个 WebKit 原生诊断清单均没有候选报告或收集错误；Node 产物保留 TAP、日志和 core-pattern 信息，没有 core／backtrace 或崩溃清单。没有报告不证明未发生崩溃，也不能据本轮通过将历史 V8 断言、WebGL context loss 或显示服务器故障追认为已修复。前述全部失败、取消、文件级占位和未报告案例仍按原运行保留。

已测应用在 `5e54ceb` 合入并推送 main；该合入提交带 `[skip ci]`，不另计一次通过结果。相对 `2683b304`，只另有原版 SDK 参考工作流和两份参考夹具，应用／内核源码保持已测状态。Menu.popup 的新嵌套业务仍留在 052 工作目录，未验证、未合入，现有 main 的旧 popup 队列限制继续成立。

本阶段通过的是 Web 实现的上述合同。旧发行所用 VCL Forms 二进制的确切关闭时序、NoNotify 观察差异和原生菜单递归仍有未知项；增加原版参考工作流不等于已取得这些结论。其余非插件功能继续实现，不能将 Window 模态接通写为整个目标完成。

## Menu.popup 业务接线与原版关闭校准（新改动尚待 Actions）

MenuModals 将 popup 接入同一 TJS 栈上的 ModalLoop。MenuTree 保留每次请求及其结果，选择或撤销只移除该层 UI；即使父菜单的 Window 被子 showModal 阻挡，也先记录不可用结果，等自己的 wait 恢复为栈顶才结束，不取消正在运行的子 Window。打开失败、异常和 Stop 按请求身份清理，服务不额外强持有脚本对象。

选中通知在该 scope 清理后进入普通输入队列，TJS popup 不再内联调用 onClick。取队时才升级原 MenuRecord 的弱引用，并沿当前 Parent 查找 Window、检查平台项和祖先 enabled；其间只改变叶项 visible、caption 或 children 不抹掉已经选中的通知。新的 DOM 点击仍校验原 Window、请求、epoch 和可见叶项，旧请求不能借重挂载或命令编号复用进入另一窗口。通知继续使用既有错误处理、原生引用释放和逐事件完成检查点。

无 ReturnCmd 的普通选择返回 BOOL=1；带 ReturnCmd 返回选中瞬间捕获的独立 Word 命令编号，取消为 0。命令池采用 Web 自己的最小可用正 Word，与 view/request/Window 身份分离；这不宣称复刻未知旧 VCL 的分配序列。flags 和坐标先在 TJS 整数域取低 32 位，再跨入 JavaScript，保留大整数的低位。显式 UI 取消目前采用已观察到的 Win32 Esc BOOL=1；窗口不可用、暂停、后台撤销和调用前拒绝仍返回 0，不能把 Esc 观察推广为所有原生撤销方式。

无 Recurse 的嵌套调用返回 0 且保留父菜单；有 Recurse 时子菜单结束并收尾后恢复父请求。这是当前 Web 行为，完整原版递归仍待对照。ReturnCmd 抑制通知；NoNotify 单独使用暂沿文档抑制，但两轮 Windows synthetic 键盘观察与此不同，不能声称该位已完全兼容。最新对照 [34989280346](https://github.com/fenghengzhi/krkr2-web/actions/runs/34989280346)，`4f01cec`，在每个平台记录 32 项，28 通过、4 断言失败；hook 改写和直接 PostMessage 两种输入均在 N-only 的选择中收到 WM_COMMAND。失败保留，独立输入只排除了本探针改写 MSG 是该反例的必要条件，没有证明旧 VCL 或真实鼠标路径。

宿主菜单组件在 Window blocked 或字体对话框活跃时移除 body 上的菜单浮层，不抢回父窗口焦点，不拦截子窗口指针与 Esc；旧 DOM 即使被重新挂回页面也不能提交给新请求。焦点恢复仅接受仍连接、可见且非 inert/disabled 的目标，并保留从非活动窗口的显式 popup 返回实际原输入窗口的规则。

原版 SDK 的[基础观察 34992096141](https://github.com/fenghengzhi/krkr2-web/actions/runs/34992096141)和[修订后扩展 34993108821](https://github.com/fenghengzhi/krkr2-web/actions/runs/34993108821)在 GitHub-hosted Windows 2022/2025 执行固定哈希的 2.32r2 引擎。后者四场景×两平台共 8 份观察完成：close 先返回再 query；已接受后同回调再次 close 会覆盖未消费结果；已接受父窗口仍等待子 modal 完整返回；隐藏后 Timer 继续，但 close 的 query 被丢弃，直到显式 base 答复才结束。这里统计的是原版观察完成，不是 Web 回归通过。最初无项目参数的超时和扩展状态机尚未建立时的失败均保留在对应原运行，见参考夹具 README。

这也校正了前文已经测试过、但源于推断的“丢弃关闭查询自动重试”：固定 WindowFormUnit 的 Closing 在排队时置位，隐藏投递失败及 ClearAllWindowInputEvents 都不清该位，SetVisible 也不清；再次 close 因 Closing 直接返回。因此新实现让被丢弃的已入队查询保持 pending，只有显式 base true/false 答复解除；仅在适配器同步入队前失败时回滚。新增隐藏关闭源码/字节码对照，并改正既有父查询被子模态取消的预期，保留取消确实发生、子窗口继续运行和显式答复后才能继续的断言。历史 `2683b304` 的绿色结果仍对应旧行为，不追认这些新改动已验证。

本片新增 18 项 MenuTree、12 项 MenuModals、24 项真实 TJS 菜单、2 项原版隐藏关闭回归及 1 项关闭入队回滚测试，预期共新增 57 项 Node（合计 1,703）；页面新增 5 个宿主模板及 10 个真实 Worker 模板，预期新增 45 项浏览器（合计 1,140）。所有新增和修订均未在本地运行，需以推送后的 GitHub Actions 实际报告为准。

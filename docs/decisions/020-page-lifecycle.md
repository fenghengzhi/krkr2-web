# 页面生命周期与后台策略

播放器默认勾选“切到后台时暂停”。页面隐藏时暂停脚本、计时器、转场和媒体；回到前台后保留原 VM 和资源继续执行。用户可以关闭该选项，让隐藏页面继续运行，但浏览器的 freeze 与 pagehide 仍要求暂停。用户主动暂停、GPU 尚未恢复和页面暂停是独立原因，任何一个仍成立都不能自动继续。

这是一项 Web 播放策略，不把浏览器后台节流当作 KRKR 原生事件调度的实现。关闭后台暂停不保证隐藏页面实时运行，浏览器仍可以节流、冻结或丢弃页面。

## 模块与协议

- `engine/ports/activity.ts` 定义无 DOM 依赖的 `ActivityState`：单调递增的 sequence、visible/hidden/frozen/away 状态与 pauseWhenHidden 偏好。
- `player/page-activity.ts` 收集主线程页面事件，去重并发布状态。freeze/resume 在 document 上监听，pagehide/pageshow 在 window 上监听；优先级为 away、frozen、可见性。普通焦点切换不触发页面暂停。
- `player/create-player.ts` 立即控制主线程输入/媒体入口，并通过 SessionClient 通知 Worker。恢复时先发送页面状态，再开放输入，保持 RPC 消息顺序。
- `engine/session.ts` 合并暂停原因，保留 VM、图层、资源、存档和用户意图，忽略旧 sequence。会话快照增加 revision，页面拒绝较旧 RPC 返回覆盖较新的状态事件。
- `workers/session.worker.ts` 分开处理逻辑和画面：可见时检查呈现，隐藏时降低检查频率，冻结/离开时停止检查；停止、失败的会话不会被新页面事件重新启动。
- `app/preferences.ts` 保存全局偏好并处理存储不可用的情况。其他标签页修改偏好会更新当前播放器；偏好写入失败时仍应用本次选择。

Session 协议由 4 升到 **5**，初始化携带当前页面状态，增加 `setActivity()`、activity 和 snapshot revision。TJS WASM ABI 仍为 1，两种 WASM 产物不需要重新编译。初始化期间收到的更新在初始化返回后补发，隐藏页面的启动脚本可等待前台，也可直接停止。

## 状态与执行边界

| 页面状态 | 默认策略 | 关闭“切到后台时暂停” | 输入/画面 |
| --- | --- | --- | --- |
| visible | 按用户/GPU 状态运行 | 同左 | 输入还要求会话 running；提交需要更新的画面 |
| hidden | 暂停 | 可继续逻辑与媒体 | 清除临时输入；不连续提交隐藏画面 |
| frozen | 暂停 | 暂停 | 不接收游戏输入；停止呈现检查 |
| away | 暂停 | 暂停 | 等待 pageshow 或页面结束 |

浏览器 freeze 后又收到 visible 不足以解除冻结，必须收到 resume 或 pageshow；resume 也不能解除尚未返回的 pagehide。新鲜序号与状态优先级共同防止迟到信号覆盖当前状态。

`ExecutionControl.wait()` 使用循环，避免同一个事件循环内“恢复后立即暂停”错误地放行等待者。WASM host import 在处理宿主调用前和异步结果返回前都检查暂停；错误返回同样等待，因为它会执行 TJS 的 catch 和后续异常处理。顶层 execute/invoke 在进入 VM 前也等待，覆盖启动脚本刚读完才隐藏页面的情况。取消会解除等待并让原生执行退出，不新建 VM，不重复执行已完成脚本。

已经开始的 I/O 可以完成，但其结果在恢复前不能继续进入脚本。主线程监听器不能同步停住 Worker 的当前指令；逻辑暂停在 Worker 收到状态并到达挂起点后生效。没有使用共享内存、主线程阻塞或全资源预加载规避这一边界。

Timer 保留剩余期限，后台暂停会废弃尚未开始执行的旧 Timer 回调，恢复后不补发暂停期间的 tick；已明确请求的 AsyncTrigger 不因此丢弃。转场沿用暂停时间补偿。`System.getTickCount()` 保持宿主单调时钟语义，不伪装成游戏暂停时钟。

隐藏时保留画面 dirty。GPU 恢复可以完成一次首帧上传以解除图形条件；页面暂停条件继续有效，只有返回前台才恢复正常呈现。返回页面也不能跳过丢失或失败的 GPU 状态。

## 输入、媒体与存档

主线程清空待发按键、鼠标、触摸、合成文字和实际 pointer capture。Worker 清除按键/悬停/捕获等临时状态，保留脚本焦点与模态层；队列和正在执行的输入回调使用 epoch，防止暂停前的操作在恢复后继续建立旧捕获。中断的 compositionend 及其紧随的 input 不提交旧文字，新一轮合成可以正常提交一次。

主线程音频和视频分别组合 Worker pauseAll 与页面暂停，页面恢复不能覆盖用户/GPU 暂停。AudioWorklet 收到暂停命令，冻结声部位置；输出 gain 立即归零，电平报告也归零。视频元素立即 pause 并取消取帧。没有为暂停关闭 AudioContext 或重建声部，也不主动 suspend AudioContext 来阻断 Worklet 命令响应。浏览器自行挂起了此前已运行的 context 时，恢复会尝试 resume；自动播放策略仍由浏览器决定。

首次从 visible 离开时，Worker 尝试提交已经进入存档覆盖层的字节。它不会从生命周期事件重入暂停的 VM 去强制关闭原生文件流。提交失败保留 dirty 数据并记录错误，后续正常提交、停止重试或导出仍可使用这些字节。已开始提交有独立版本核对，不能把较新的写入标为已保存。

页面事件只能提供尽力提交机会，不能保证操作系统终止进程前异步事务完成。没有添加 unload 回调或“已完整保存游戏”的提示；浏览器丢弃页面不等于保存当前 VM 堆。游戏刷新后仍依靠原有游戏存档恢复。

## 验证方式

`tests/integration/activity.test.ts` 使用真实 Asyncify TJS VM，覆盖 14 个案例：状态重排、用户暂停、初始隐藏/取消、嵌套读取和读取错误、顶层解码、排队输入、正在执行的鼠标/触摸回调、恢复后立即暂停、Timer 期限以及存档提交成功/失败。

三浏览器双后端的 `activity.spec.ts` 与 `activity-media.spec.ts` 使用可控制的可见性和生命周期信号，验证状态组合、隐藏启动/停止/重启、GPU 条件、输入法清理、声音与视频位置。`activity-settings.spec.ts` 在三浏览器验证真实 storage 事件与拒绝持久化的降级。这部分的合成事件用于确定性验证应用行为，不冒充浏览器原生冻结。`activity-controls.spec.ts` 另在三浏览器检查按住暂停/声音按钮跨越 Timer/Worklet 更新后，松开仍能触发操作。

`playwright.activity.config.ts` 单独运行 Chromium 原生验证。常规 Playwright 页面会通过 CDP 强制保持焦点/活跃；仅创建其他标签页或增加一个 CDP session 无法关闭原 session 的覆盖。测试使用独立临时 profile 启动工具自带的完整 Chromium，再通过 `connectOverCDP({ noDefaults: true })` 接入默认 context；不操作用户浏览器。

原生测试使用 Browser.setWindowBounds 最小化/恢复产生真实 visibilitychange，再使用 Page.setWebLifecycleState 触发实际 freeze/resume。断言事件 isTrusted，并用 Node 时钟观测冻结时长。隐藏状态查询使用数值轮询，不等待已经停止的 requestAnimationFrame。每次测试回收拥有的浏览器进程和临时 profile，失败时保留 trace/截图，事件记录附在报告中。

原生 7 个案例覆盖双后端 VM 保留、用户暂停、选择后台继续、真实 Worklet 声部位置/视频时间及一次超过既有媒体请求超时时长的 21 秒冻结。后者验证正常播放过程中冻结/解冻没有超时故障，并不穷举每一种正在加载或 seek 的媒体请求与操作系统调度次序。

执行 `npm run test:activity` 可重跑专项；`npm run check` 顺序执行完整构建、Node、常规三浏览器、游戏库、PWA 和原生生命周期测试。原有 2 个 worker、30 秒用例超时和 12 秒断言超时保持不变。原有 WebKit PWA 网络模拟排除项和磁盘 trace 设置也保留。

本阶段完整 `npm run check` 通过 **230 项行为/集成与 438 项浏览器测试**（339 常规、57 游戏库、35 PWA、7 原生生命周期），新增 14 项 Node 与 52 项浏览器案例；选中案例无失败或跳过，既有 PWA 排除项单独保留。日志为 `out/verification/activity/check.log`，最终源码/测试/配置/发布文件/WASM 哈希与原生可信事件记录于 `out/verification/activity-matrix.json`。本阶段未重跑外部 KAG 36 场景矩阵。中间诊断日志保留，用于区分真实引擎缺陷、测试表达式错误与自动化环境限制。一次完整回归中，WebKit 双页面设置案例超过 30 秒；trace 显示同步断言均通过，但复选框操作各耗时约 4～5 秒。测试在完成跨页验证后立即关闭副页面，保留全部断言、录制和原有超时；与媒体案例并行的定向验证降至 11.1 秒。原日志与 trace 保存在 `out/verification/activity/settings-failure/`，该失败不计为通过。

另一次完整回归暴露了实际界面缺陷：Timer 通知会反复设置按钮的 textContent；WebKit 在按下/松开之间替换文字节点，即使内容不变，也可能取消 click。最小按钮对照中，WebKit 的无修改、仅改 disabled、重设相同文字分别触发 1、1、0 次点击，Chromium/Firefox 三种情况均为 1；实际播放器的按住跨 tick 测试同样先失败。`app/dom.ts` 现在只在内容改变时写入，用于暂停、声音和离线准备按钮。根因探测、修复前失败及之后三浏览器验证保存在 `out/verification/activity/pause-click-failure/` 与 `controls-after.json`；没有用重复点击或增加超时掩盖问题。

尚未验证移动操作系统强杀/长时挂起、真实 BFCache 恢复、所有解码/seek 中断排列以及长期后台资源压力；Firefox/WebKit 的原生冻结尚无本测试夹具，只验证应用信号路径。页面生命周期实现不代表完整 System 事件、窗口/IME 或其他非插件功能已经完成，继续以 [非插件进度](../non-plugin-progress.md) 为准。

规范依据：[HTML 页面可见性](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility)、[Chrome 页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)。原生测试关闭默认覆盖的依据是当前安装的 Playwright connectOverCDP 类型及 Chromium 初始化实现，并由本机 isTrusted 事件探测验证。

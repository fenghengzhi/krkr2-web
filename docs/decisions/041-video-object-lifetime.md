# 041 — 视频对象生命周期：实现进行中

本阶段从声音生命周期分支的 `1e5579e` 开始，在独立工作目录推进。完整 VideoOverlay 所有权尚未实现，不能把首批端口修改视为阶段完成。构建、类型检查、测试和浏览器探测只在 GitHub-hosted Actions 运行。

首批修改为 `PortVideoBackend` 增加每次打开操作的独立标记。关闭同一 ID、替换打开、会话取消或 shutdown 撤销标记；元数据读取结束后只有仍有效的请求能发给浏览器宿主。元数据解析和传输使用同一份私有输入副本。shutdown 在等待远端回执前关闭命令入口，多次调用共享同一次关闭操作，待处理回执与定时任务在结束时统一释放。六个新增用例使用真实 MessageChannel 与受控的元数据 Promise，验证请求顺序、输入字节所有权及并发关闭。[首轮完整回归 34896332070](https://github.com/fenghengzhi/krkr2-web/actions/runs/34896332070) 已通过，绑定 `c3b59716960049ef69f27eb1dbfeff62a9ea044f`；该结果仅验证端口首批修改，不代表完整视频所有权阶段已完成。

## 当前实现与验证进度

视频自身、窗口和 layer 属性已改用独立弱观察；脚本显式保留的窗口 action owner 沿用强引用。服务不再通过 `window.add(this)` 或绑定 dispatch 永久持有视频。排队事件独立持有接收者，按成员名投递，在完成或取消后释放；窗口断开与视频失效分别处理，异步打开和关闭都有资源请求及进行中操作记录。Session 在执行边界和 idle 等待视频关闭；存档提交成功后，一项媒体清理失败不会阻止其余媒体、VM 和渲染器的清理。

原生桥新增弱引用返回值：有效观察直接写入拥有引用的 TJS reply，过期或撤销观察返回 null，不额外分配永久宿主句柄。另增加可挂起的 collect 入口，处理取消队列时在原 VM 返回后才释放的句柄。视频事件完成会把该清理排入 Session 执行队列；通知仍不执行脚本。

首轮核心实现 [34899772270](https://github.com/fenghengzhi/krkr2-web/actions/runs/34899772270) 为 Node 762/764、浏览器 651/651、直接运行时 6/6。两个取消视频事件场景留下一个待释放句柄和一个对象，精确基线断言失败；新增 collect 入口修正此路径，原断言保留。

后续 [34901201286](https://github.com/fenghengzhi/krkr2-web/actions/runs/34901201286) 中，这两个场景和新增 collect 场景在 Node 通过；但 JSPI 的 collect 尚未加入 `JSPI_EXPORTS`，`ccall` 收到普通返回值后报 `ret.then is not a function`。原生媒体启动失败的 trace 也保存了这一运行错误，不是单纯加载较慢。构建列表现已补上此入口，尚待新一轮验证。

同次运行的声音测试子进程收到 SIGSEGV：原 TAP 记录 751 个通过用例及一个文件级失败，82 个声音用例只记录到 61 个通过，剩余未执行部分不能计入通过。独立 [进程诊断 34902191020](https://github.com/fenghengzhi/krkr2-web/actions/runs/34902191020) 在同一应用源码/产物上连续运行该文件三次均通过，没有复现崩溃；原始 SIGSEGV 根因尚未确定。诊断保留逐次 TAP、退出状态，并在托管 runner 发生崩溃时记录原生回溯；不因重复通过删除历史失败。

常规 Node 作业也已加入崩溃回溯保留步骤，继续使用原测试命令和进程隔离方式。若完整并发负载下再次终止，将记录核心文件哈希和原生线程回溯；测试仍会失败，不自动重试或替换原结果。

浏览器宿主也已补上创建中途回滚、单个资源断开失败后继续清理及共享关闭结果。新增真实 DOM/MP4 解码场景观察对象 URL、首帧回调、DOM 和音频连接边界；Web Audio 节点构造、连接、断开的受控失败检查另行记录，不将受控音频设备等同于物理硬件测试。整个视频阶段仍在验证中。

窗口断开后的事件时序仍需与 Window 原生生命周期一起补齐：当前断开静默关闭媒体；原生 Shutdown 注释要求不派发事件，但实现中的 SetStatus 调用仍有可疑的可派发状态。当前结果不证明这一时序已经与所有原生窗口路径完全一致。

## 原始审计依据

[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 保留 Window action owner，弱引用视频自身，并向 Window 注册 native 指针；这不等同于 `Window.add`。基础 finalize 为空，资源清理由原生 Invalidate 执行。当前 Web bootstrap 自动 `window.add(this)`，服务永久保留绑定 dispatch，且依赖脚本 finalize 关闭，均待调整。

同一文件的同步与异步状态变化都会取消此前尚未派发的视频事件，frame/period 是立即事件，ended 状态是入队事件。不能直接照搬 Sound 中保留 label 后接 ended 的规则；排队的实际视频事件需要独立持有并在完成或取消后释放。

[VideoOvlImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp) 的 Disconnect 关闭底层 overlay 并解除 Window 指针，不直接 invalidate VideoOverlay 脚本对象。窗口失效和视频对象失效需要分别处理。其 layer1/layer2 存 native 指针，当前 bootstrap 的强引用与宿主数字 ID 也需要审计和对应的失效处理。

后续应补声音阶段同样的弱 owner、实际事件持有、异步关闭等待和主异常保留，同时验证浏览器视频元素、对象 URL、AudioNode、帧回调、seek/load 等待器与迟到回执的实际释放。当前 WebVideoHost 在加载前发布 Movie 并用 AbortController 取消等待，但创建回滚、关闭期间回执及所有资源清理排列仍需专项验证。窗口断开时的状态与事件行为应结合原生源码和托管对照记录，不宣称全部兼容。

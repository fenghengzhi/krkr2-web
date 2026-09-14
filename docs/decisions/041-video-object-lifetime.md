# 041 — 视频对象生命周期：实现进行中

本阶段在 `codex/video-lifetime` 分支实现视频自身、窗口和图层的所有权、事件持有与媒体回收。已合入声音阶段的已验证源码。构建、类型检查、测试和浏览器探测只在 GitHub-hosted Actions 运行；下面保留首轮失败和各次通过的范围，尚不宣称全部非插件功能完成。

首批修改为 `PortVideoBackend` 增加每次打开操作的独立标记。关闭同一 ID、替换打开、会话取消或 shutdown 撤销标记；元数据读取结束后只有仍有效的请求能发给浏览器宿主。元数据解析和传输使用同一份私有输入副本。shutdown 在等待远端回执前关闭命令入口，多次调用共享同一次关闭操作，待处理回执与定时任务在结束时统一释放。六个新增用例使用真实 MessageChannel 与受控的元数据 Promise，验证请求顺序、输入字节所有权及并发关闭。[首轮完整回归 34896332070](https://github.com/fenghengzhi/krkr2-web/actions/runs/34896332070) 已通过，绑定 `c3b59716960049ef69f27eb1dbfeff62a9ea044f`；该结果仅验证端口首批修改，不代表完整视频所有权阶段已完成。

## 当前实现与验证进度

视频自身、窗口和 layer 属性已改用独立弱观察；脚本显式保留的窗口 action owner 沿用强引用。服务不再通过 `window.add(this)` 或绑定 dispatch 永久持有视频。排队事件独立持有接收者，按成员名投递，在完成或取消后释放；窗口断开与视频失效分别处理，异步打开和关闭都有资源请求及进行中操作记录。Session 在执行边界和 idle 等待视频关闭；存档提交成功后，一项媒体清理失败不会阻止其余媒体、VM 和渲染器的清理。

原生桥新增弱引用返回值：有效观察直接写入拥有引用的 TJS reply，过期或撤销观察返回 null，不额外分配永久宿主句柄。另增加可挂起的 collect 入口，处理取消队列时在原 VM 返回后才释放的句柄。视频事件完成会把该清理排入 Session 执行队列；通知仍不执行脚本。控制台展示脚本表达式的结果后，也先释放返回对象再完成 collect 和媒体关闭，避免临时视频或声音等到下一条脚本才回收。

首轮核心实现 [34899772270](https://github.com/fenghengzhi/krkr2-web/actions/runs/34899772270) 为 Node 762/764、浏览器 651/651、直接运行时 6/6。两个取消视频事件场景留下一个待释放句柄和一个对象，精确基线断言失败；新增 collect 入口修正此路径，原断言保留。

后续 [34901201286](https://github.com/fenghengzhi/krkr2-web/actions/runs/34901201286) 中，这两个场景和新增 collect 场景在 Node 通过；但 JSPI 的 collect 尚未加入 `JSPI_EXPORTS`，`ccall` 收到普通返回值后报 `ret.then is not a function`。原生媒体启动失败的 trace 也保存了这一运行错误，不是单纯加载较慢。构建列表已补上此入口，[34902819922](https://github.com/fenghengzhi/krkr2-web/actions/runs/34902819922) 随后完整通过 772 项 Node、675 项浏览器和 6 组直接运行时，绑定 `6a483869a86f0b0e8096d58ded3b6e608679c694`。

更新的 `d064226dcdc61b0df0ce9bd83bb84c81cdf0946f` 增加 4 项临时返回对象用例，并把 10 种真实视频 Session 场景接入三浏览器、双后端、源码/字节码的直接运行时检查；[34904119374](https://github.com/fenghengzhi/krkr2-web/actions/runs/34904119374) 正在验证这一版。该运行与独立 KAG、对象、句柄、分配诊断尚未全部结束，不能将新增结果提前计入通过。

同次运行的声音测试子进程收到 SIGSEGV：原 TAP 记录 751 个通过用例及一个文件级失败，82 个声音用例只记录到 61 个通过，剩余未执行部分不能计入通过。独立 [进程诊断 34902191020](https://github.com/fenghengzhi/krkr2-web/actions/runs/34902191020) 在同一应用源码/产物上连续运行该文件三次均通过，没有复现崩溃；原始 SIGSEGV 根因尚未确定。诊断保留逐次 TAP、退出状态，并在托管 runner 发生崩溃时记录原生回溯；不因重复通过删除历史失败。

常规 Node 作业也已加入崩溃回溯保留步骤，继续使用原测试命令和进程隔离方式。若完整并发负载下再次终止，将记录核心文件哈希和原生线程回溯；测试仍会失败，不自动重试或替换原结果。

浏览器宿主已补上创建中途回滚、单个资源断开失败后继续清理及共享关闭结果。15 个真实 DOM/MP4 解码场景观察对象 URL、首帧回调、DOM 和音频连接边界；三浏览器另覆盖 96 个 Web Audio 节点构造、连接、断开失败点及 9 个无故障对照。两类观察已在 34902819922 通过，JSON 附件保留逐项资源计数。受控音频设备不等同于物理硬件测试。最终报告会同时绑定源码、发布字节和原始观察，整个视频阶段仍在验证中。

窗口断开后的事件时序仍需与 Window 原生生命周期一起补齐：当前断开静默关闭媒体；原生 Shutdown 注释要求不派发事件，但实现中的 SetStatus 调用仍有可疑的可派发状态。当前结果不证明这一时序已经与所有原生窗口路径完全一致。

## 原始审计依据

[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 保留 Window action owner，弱引用视频自身，并向 Window 注册 native 指针；这不等同于 `Window.add`。基础 finalize 为空，资源清理由原生 Invalidate 执行。旧 Web bootstrap 自动 `window.add(this)`、永久保留绑定 dispatch 和依赖脚本 finalize 关闭的路径已由本阶段替换。

同一文件的同步与异步状态变化都会取消此前尚未派发的视频事件，frame/period 是立即事件，ended 状态是入队事件。不能直接照搬 Sound 中保留 label 后接 ended 的规则；排队的实际视频事件需要独立持有并在完成或取消后释放。

[VideoOvlImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp) 的 Disconnect 关闭底层 overlay 并解除 Window 指针，不直接 invalidate VideoOverlay 脚本对象。本阶段分别处理窗口失效和视频失效；layer1/layer2 原有强引用已替换为弱观察，读取仍返回具有正常引用所有权的脚本对象，图层失效后返回 null。

窗口断开时的状态与事件顺序仍需结合 Window 原生生命周期和托管对照继续实现。旧视频编码、其他容器的帧索引、流式媒体、完整 mixer/色彩控制也不在本轮生命周期验证范围内，继续列在非插件总进度中。

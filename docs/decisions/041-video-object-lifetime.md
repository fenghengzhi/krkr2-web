# 041 — 视频对象生命周期与媒体资源清理

[最终完整回归 34905170428](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905170428) 已通过 **776 项 Node、678 项浏览器检查和 6 组直接运行时**，绑定 `e02c1d5259c1b87e035d64132c889cd6f253b31f`。[KAG/离线升级兼容性](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905448820) 另通过 78 项；[独立对象](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905451538) 120 项、[独立句柄](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905453867) 64 项和[分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905131147) 均已通过。无跳过、重试或 flaky 结果。

[最终证据报告 34906206305](https://github.com/fenghengzhi/krkr2-web/actions/runs/34906206305) 已通过，报告提交为 `0a4c3a432217c09f9632f92550e609ca3ad700bd`，绑定 543 份证据。`video-object-lifetime-matrix.json` SHA-256 为 `7996d5d822fbdbbc1acde1c019e247a3cb60b994f474cbe766d6fe78e2921a5d`。src 树为 161 个文件、932,753 字节，SHA-256 `19b0d45006580f591c6b72f5fd4520d0e0e7c590d1ef73775835493c770621ca`；发布树 32 个文件、5,787,857 字节，SHA-256 `39262f2402e06b1f8a798d20b6b3fc6ef0cdae51f664e529332996a62c5d9e1e`。构建标识 `914a31bed42796706b5a22db622d67f64eceb3d5800a195068db8292e0e7807f`，原生源码 SHA-256 `a3f98ac1bda85a1ade0cc0733f7d71d1c3762fc8f75cb13333e553c1b62f1b70`。声音阶段矩阵和失败运行原始记录继续保留。

直接运行时包含 12 个视频 Session、120 个视频生命周期场景和 144 个弱引用返回/collect 场景；每个视频 Session 关闭 10 个独立媒体实例，停止后所有计数归零。浏览器另验证 18 个真实 DOM/MP4 宿主场景、96 个受控 Web Audio 故障点和 9 个无故障对照。分配诊断记录 600 个弱观察、24 个从属对象、21 个集合终结、1,060 个执行及 188 个字节码故障点。可信冻结间隔为 21,052.9 ms。TJS ABI 5 新增 `videoObjectLifetime: 1`；字体 ABI 2、协议 9 不变。

本阶段在 `codex/video-lifetime` 分支实现视频自身、窗口和图层的所有权、事件持有与媒体回收。已合入声音阶段的已验证源码。构建、类型检查、测试和浏览器探测只在 GitHub-hosted Actions 运行；下面保留首轮失败和各次通过的范围，尚不宣称全部非插件功能完成。

首批修改为 `PortVideoBackend` 增加每次打开操作的独立标记。关闭同一 ID、替换打开、会话取消或 shutdown 撤销标记；元数据读取结束后只有仍有效的请求能发给浏览器宿主。元数据解析和传输使用同一份私有输入副本。shutdown 在等待远端回执前关闭命令入口，多次调用共享同一次关闭操作，待处理回执与定时任务在结束时统一释放。六个新增用例使用真实 MessageChannel 与受控的元数据 Promise，验证请求顺序、输入字节所有权及并发关闭。[首轮完整回归 34896332070](https://github.com/fenghengzhi/krkr2-web/actions/runs/34896332070) 已通过，绑定 `c3b59716960049ef69f27eb1dbfeff62a9ea044f`；该结果仅验证端口首批修改，不代表完整视频所有权阶段已完成。

## 当前实现与验证进度

视频自身、窗口和 layer 属性已改用独立弱观察；脚本显式保留的窗口 action owner 沿用强引用。服务不再通过 `window.add(this)` 或绑定 dispatch 永久持有视频。排队事件独立持有接收者，按成员名投递，在完成或取消后释放；窗口断开与视频失效分别处理，异步打开和关闭都有资源请求及进行中操作记录。Session 在执行边界和 idle 等待视频关闭；存档提交成功后，一项媒体清理失败不会阻止其余媒体、VM 和渲染器的清理。

原生桥新增弱引用返回值：有效观察直接写入拥有引用的 TJS reply，过期或撤销观察返回 null，不额外分配永久宿主句柄。另增加可挂起的 collect 入口，处理取消队列时在原 VM 返回后才释放的句柄。视频事件完成会把该清理排入 Session 执行队列；通知仍不执行脚本。控制台展示脚本表达式的结果后，也先释放返回对象再完成 collect 和媒体关闭，避免临时视频或声音等到下一条脚本才回收。

首轮核心实现 [34899772270](https://github.com/fenghengzhi/krkr2-web/actions/runs/34899772270) 为 Node 762/764、浏览器 651/651、直接运行时 6/6。两个取消视频事件场景留下一个待释放句柄和一个对象，精确基线断言失败；新增 collect 入口修正此路径，原断言保留。

后续 [34901201286](https://github.com/fenghengzhi/krkr2-web/actions/runs/34901201286) 中，这两个场景和新增 collect 场景在 Node 通过；但 JSPI 的 collect 尚未加入 `JSPI_EXPORTS`，`ccall` 收到普通返回值后报 `ret.then is not a function`。原生媒体启动失败的 trace 也保存了这一运行错误，不是单纯加载较慢。构建列表已补上此入口，[34902819922](https://github.com/fenghengzhi/krkr2-web/actions/runs/34902819922) 随后完整通过 772 项 Node、675 项浏览器和 6 组直接运行时，绑定 `6a483869a86f0b0e8096d58ded3b6e608679c694`。

更新的 `d064226dcdc61b0df0ce9bd83bb84c81cdf0946f` 增加 4 项临时返回对象用例，Node 776 项通过；同版 KAG/离线升级、独立对象、句柄和分配诊断也通过。但新增直接运行时检查在 [34904119374](https://github.com/fenghengzhi/krkr2-web/actions/runs/34904119374) 失败：测试打开视频后才设置逐帧模式，原生 SetMode 在打开后忽略此设置。六组运行都停在源码场景的 frame-last-reference，此前四个场景已通过。fixture 现改为打开前设定模式，并在发送事件前核对实际模式；回收和事件断言未放宽。

修正后的 [34904603674](https://github.com/fenghengzhi/krkr2-web/actions/runs/34904603674) 完成了每组的 10 个源码视频场景，但最后的日志断言把主动触发并捕获的 disconnected open 错误所产生的原生 VM dump 判为失败。fixture 现单独核对这一错误及其一次原生诊断，并保存原始输出，其他操作仍要求无错误日志。该失败运行未进入后续字节码 Session，不能计为完整通过。

随后复查发现 cancel 命令在首个视频关闭报错时会停止遍历其他视频；已改为继续清理所有视频后再报告首个错误。新增三浏览器场景在调用最终 shutdown **之前** 检查全部媒体已释放，避免最终关闭掩盖取消错误。这些修改与源码/字节码 Session 已由上面的最终完整回归验证。CI 对同分支后续运行采用排队，保留正在执行的完整回归。

同次运行的声音测试子进程收到 SIGSEGV：原 TAP 记录 751 个通过用例及一个文件级失败，82 个声音用例只记录到 61 个通过，剩余未执行部分不能计入通过。独立 [进程诊断 34902191020](https://github.com/fenghengzhi/krkr2-web/actions/runs/34902191020) 在同一应用源码/产物上连续运行该文件三次均通过，没有复现崩溃；原始 SIGSEGV 根因尚未确定。诊断保留逐次 TAP、退出状态，并在托管 runner 发生崩溃时记录原生回溯；不因重复通过删除历史失败。

常规 Node 作业也已加入崩溃回溯保留步骤，继续使用原测试命令和进程隔离方式。若完整并发负载下再次终止，将记录核心文件哈希和原生线程回溯；测试仍会失败，不自动重试或替换原结果。

浏览器宿主已补上创建中途回滚、单个资源断开失败后继续清理及共享关闭结果。首批 15 个真实 DOM/MP4 场景及 96 个受控 Web Audio 故障点、9 个对照在 34902819922 通过；最终版本又增加 3 个 cancel 故障场景。JSON 附件保留逐项资源计数，最终报告绑定源码、发布字节与原始观察。受控音频设备不等同于物理硬件测试，下面的兼容性限制仍保留。

窗口断开后的事件时序仍需与 Window 原生生命周期一起补齐：当前断开静默关闭媒体；原生 Shutdown 注释要求不派发事件，但实现中的 SetStatus 调用仍有可疑的可派发状态。当前结果不证明这一时序已经与所有原生窗口路径完全一致。

## 原始审计依据

[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 保留 Window action owner，弱引用视频自身，并向 Window 注册 native 指针；这不等同于 `Window.add`。基础 finalize 为空，资源清理由原生 Invalidate 执行。旧 Web bootstrap 自动 `window.add(this)`、永久保留绑定 dispatch 和依赖脚本 finalize 关闭的路径已由本阶段替换。

同一文件的同步与异步状态变化都会取消此前尚未派发的视频事件，frame/period 是立即事件，ended 状态是入队事件。不能直接照搬 Sound 中保留 label 后接 ended 的规则；排队的实际视频事件需要独立持有并在完成或取消后释放。

[VideoOvlImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp) 的 Disconnect 关闭底层 overlay 并解除 Window 指针，不直接 invalidate VideoOverlay 脚本对象。本阶段分别处理窗口失效和视频失效；layer1/layer2 原有强引用已替换为弱观察，读取仍返回具有正常引用所有权的脚本对象，图层失效后返回 null。

窗口断开时的状态与事件顺序仍需结合 Window 原生生命周期和托管对照继续实现。旧视频编码、其他容器的帧索引、流式媒体、完整 mixer/色彩控制也不在本轮生命周期验证范围内，继续列在非插件总进度中。

# 039 — 宿主对象观察、句柄释放与事件所有权

本阶段的 [最终报告 34883625695](https://github.com/fenghengzhi/krkr2-web/actions/runs/34883625695)已通过，报告与最终回归绑定提交 `056417a7f86f93c0bba76832c2d46ecfc2a96ac9`。矩阵 `out/verification/host-object-lifetime-matrix.json` 的 SHA-256 为 `e2c75876777e77b4b834551a7558d3527e4431ef5f7daf6180fd85d148368d9c`，包含 542 份证据。以下失败记录保留历史顺序；最终通过不抹除未确定根因的故障，也不代表完整非插件目标完成。

[完整回归 34882175516](https://github.com/fenghengzhi/krkr2-web/actions/runs/34882175516)通过 594 项 Node、639 项浏览器、6 项直接运行时；[兼容性 34877215012](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877215012)通过 78 项。独立 [宿主句柄 34877207118](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877207118)通过 64 项，[对象终结 34877210694](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877210694)通过 120 项。[分配诊断 34876790697](https://github.com/fenghengzhi/krkr2-web/actions/runs/34876790697)通过 600 次 owner 分配失败（注册 16、销毁 576、升级 8）、20 次集合清理、1,064 次执行和 188 次字节码分配失败。[字体重启 34882204693](https://github.com/fenghengzhi/krkr2-web/actions/runs/34882204693)通过 20 次原用例重复，保留浏览器协议日志，没有增加等待期限或重试。

正式构建 ID 为 `e53d491afaf98e2654c51923bed866b1836cc14cff4715267ef8ef9ee248e1a1`，TJS 源码摘要为 `66fba7f55e5bd1084d7e6e7810c9d547a0aedbe5484c835b0d6ec45fd3e33bac`，发布树摘要为 `c763292b28c63b1fb3102868fb6b79a8a49a8c7b807a070ffc76a993361be420`。TJS ABI 5、字体 ABI 2、协议 9；新增 `hostObjectLifetime: 1`，正式产物不含故障分配器。可信冻结为 21,059.1 ms。本地只恢复精确云端构建，旧产物和 038 矩阵保持保留。

本阶段实现宿主句柄异常清理和 Timer / AsyncTrigger 的实际资源生命周期，未完成全部非插件对象。首轮完整 [Tests 34871902361](https://github.com/fenghengzhi/krkr2-web/actions/runs/34871902361) 的 Node 为 592/594，639 项浏览器与 6 项直接运行时通过；源码为 `7c08baa9951b114a1ae22eacb8a7e7a455dec93f`。两个字节码暂停/停止夹具使用无条件 TextDecoder，误把编译输出作为文本解析，已改用保留 TJS2/KBAD 二进制的 readScript，仅拦截等待标记。该失败整体仍是失败，不能由后续运行覆盖。全部构建、测试与可执行探测仅在 GitHub-hosted Actions 运行，未本地执行。

修订后的 [Tests 34873398038](https://github.com/fenghengzhi/krkr2-web/actions/runs/34873398038) 已全部成功，绑定源码 `cf6248c0c9bb9fe6f60d1c5d5fd50586a2c1d50a`；14 个作业均成功，Node 为 594/594，包含上述字节码暂停/停止场景，浏览器、直接运行时和生产构建作业也成功。材料归档至 `out/verification/github-actions/34873398038/complete/`，元数据位于上级 `run.json`。该运行早于后述保留字表销毁修复，不能作为修复后源码或完整 039 阶段的通过证明。

[分配诊断 34872335592](https://github.com/fenghengzhi/krkr2-web/actions/runs/34872335592) 在 VM 销毁的 `after=71` 分配点失败（阶段 11，440 字节）。原生对象计数虽已归零，销毁仍触发 WASM abort，分配账本与全局字符串/调试资源未回到成功对照，不能据对象数宣称回收完成。源码还发现 Shutdown 在 Release 成功后才清空 Global；Release 消费引用后抛错会留下悬空指针，已调整为先分离。诊断构建保留 WASM 函数名，正式构建不加入该调试选项。

随后的 [分配诊断 34873432311](https://github.com/fenghengzhi/krkr2-web/actions/runs/34873432311) 绑定 `cf6248c0c9bb9fe6f60d1c5d5fd50586a2c1d50a`，两个后端仍失败；Global 指针分离没有解决 `after=71`、440 字节的销毁异常。该轮的字节码、执行临时内存和集合清理分配步骤通过，但弱观察/VM 销毁分配步骤失败，因此整轮仍记为失败。完整材料和元数据分别保存在 `out/verification/github-actions/34873432311/complete/` 与 `run.json`。

[分配诊断 34874097344](https://github.com/fenghengzhi/krkr2-web/actions/runs/34874097344) 绑定 `90a5c7eefeb5aabd532fac28c8add935e9e27177`，在异常展开前记录分配失败堆栈；两个后端仍在同一位置失败。其 `allocationTrace` 从失败位置向调用者回溯，除去 Emscripten 包装帧后为：

```text
DeleteAllMembers -> Finalize -> BeforeDestruction -> tTJSDispatch::Release
-> TJSReservedWordsHashRelease -> tTJS::Cleanup -> ~tTJS -> tTJS::Release -> Vm::~Vm
```

这将 440 字节的失败定位到保留字表成员清理。保留字表的 Release 已消费引用、删除对象后继续抛出异常；异常离开 `tTJS` 析构函数导致 abort，全局字符串池、正则状态和调试注册的后续清理未完成。该轮失败堆栈、账本与对照结果保存在 `out/verification/github-actions/34874097344/complete/`，元数据为上级 `run.json`；新增诊断没有把旧失败改成成功。

修复提交 `e2adc68128b6925010695a57950f5a5c85da75f6` 修改 `tjsLex.cpp` 的 `TJSReservedWordsHashRelease()`：先分离 `TJSReservedWordHash`、清空全局指针并重置初始化标记，再使用 `krkr::ReleaseNative` 释放。这个 noexcept 释放器捕获错误并交给外层已经 suppress 的 `CleanupErrors`，避免终止析构，让后续字符串池、正则和调试资源清理继续执行。

[分配诊断 34875061460](https://github.com/fenghengzhi/krkr2-web/actions/runs/34875061460) 的两个后端均通过全部 324 条 owner 注册、升级和销毁记录，包括原来失败的销毁位置；实际每后端注入 300 次分配失败。但是 Asyncify 的既有集合清理探测在 debug/dictionary/implicit 的 `after=1` 记录一次“命中分配失败但执行没有抛错”，整轮仍为失败。旧探测在断言之前没有保存失败分配大小和原生栈，无法从这次记录确定分配来源。现已调整为先保存原始返回、异常、命中、字节数和分配栈，再作断言，保留原有判定要求。

新增诊断记录后的 [34875659518](https://github.com/fenghengzhi/krkr2-web/actions/runs/34875659518) 在两个后端全部通过，源码为 `7bcf9ca79a2cd23cdd418d25b40b7eedb8352502`；这不能抹除上轮偶发错误或证明其根因已修复。后续检查并修复 Asyncify 挂起空间的分配边界，最终结果见本文开头；该重复运行自身不构成完整阶段证明。两轮完整材料均按 run ID 保存在 `out/verification/github-actions/`。

源码检查发现固定版本 [Emscripten 6.0.9 的 Asyncify](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libasync.js) 在异步操作开始、状态进入 Unwinding 后才分配挂起缓冲区，并直接使用返回地址。新增保护在 C++ 进入两个异步 import 之前检查并预留挂起空间，失败时沿现有脚本异常边界退出，避免先启动宿主操作；JSPI 不需要该缓冲区。受版本约束的 allocateData 适配只消费已预留的空间，原有 rewind 流程负责释放，未使用的预留由 C++ 作用域释放。头部大小、栈大小、执行状态和独占持有条件均检查。这个检查修复有明确源码依据，但没有据此反推此前缺少分配栈的偶发失败已被证明来自此处。

[完整回归 34875029792](https://github.com/fenghengzhi/krkr2-web/actions/runs/34875029792) 绑定 `e2adc68128b6925010695a57950f5a5c85da75f6`，594 项 Node 和 6 项直接运行时通过，浏览器为 638/639：WebKit/Asyncify 的启动字体对话框停止后重启场景未显示新会话日志。trace 显示整个用例约 2 秒，最后断言只执行约 184 ms，尚未到配置的 12 秒期限；停止与关闭对话框成功，新 Worker 的 manifest、模块和 WASM 请求已完成。空的断言调用日志与固定 Playwright 1.63 的 WebKit protocol session 关闭/崩溃处理路径吻合，但没有记录能确定浏览器退出原因的 crash 事件，不能据此断言应用停止/重启代码或原生内存不足是根因。OPFS 错误在第一个字体对话框之前已出现，第一场游戏仍能运行，也不能单独解释重启失败。原始 trace、错误上下文与完整失败记录保留；不延长用例期限或将这轮算为通过。

修复前的 [宿主句柄诊断 34869766340](https://github.com/fenghengzhi/krkr2-web/actions/runs/34869766340) 绑定 `4bc02b9f95a6ba4c398c1aa38dc90bca99e8012e`，已终结为失败。每个后端分别执行 20 个独立子进程用例，只有 `nested-release` 的四个源码/字节码、调试开关组合通过。批量释放在首个终结器错误后遗留对象；终结期间仍可保留正在退出的旧句柄；宿主主异常处理失败；重复释放触发 WASM 内存越界或子进程超时。完整材料保存在 `out/verification/github-actions/34869766340/complete/`，元数据为同目录上级的 `run.json`。这些失败和超时作为历史证据保留，不由新工作流或后续成功覆盖。

[回归 34876763323](https://github.com/fenghengzhi/krkr2-web/actions/runs/34876763323) 为 590/594 Node、638/639 浏览器和 6/6 直接运行时。四个增强的事件用例已观察到完整终结日志以及零事件源、零弱观察、零待释放句柄；原生对象数量比原基线多 25。新增的 Debug.message 日志首次构造 variadic Array，初始化 `TJSCreateArrayObject` 的静态 Array 类；夹具现在在记录基线前执行同样的日志调用，仍要求回调完成后、任何再次 evaluate 之前回到完整基线，不减弱对象数量断言。WebKit 游戏库的文件 flush 故障用例则在首次 load 阶段提前中断，尚未执行被测的保存/flush：trace 中断言约 613 ms，带相同的空 protocol 错误日志，不能解释为 12 秒超时或存储回滚错误。该轮完整材料与 Node 原始部分下载均保留。

目标仍是 TJS2 引用计数。原引擎不自动收集任意引用环，本阶段也不引入环收集器；宿主额外制造的永久强引用需要单独修正，不能以原生不收集环为理由保留。有关失效、删除及显式断环的边界沿用 [038](038-object-finalization.md)。

宿主句柄释放队列先从 `handles` 提取待释放节点，撤销其 ID，再执行可能暂停、抛错或回调宿主的 `Clear()`。因此终结器执行期间的 retain、identity、snapshot、再次 release 都不能找到正在退出的节点。最外层 drain 持续处理新增释放请求，嵌套 host 调用不递归进入同一 drain；首个清理异常在全部排空后传播。host 已有主异常或取消时，仍完成清理，但次要终结错误不能覆盖主异常。该队列与深层对象析构队列是不同机制，诊断分别检查它们。

`tTJSCustomObject` 新增独立的 `tTJSObjectObserver` 侵入式链表，不占四个 native-instance 槽，不持有对象引用，attach、detach 和通知不分配内存。observer 必须位于稳定地址，不可复制或移动。成功执行 script finalize 和 native instance invalidation 后，在删除成员前通知；实际析构开始时再次兜底，覆盖失败的隐式终结和构造清理。脚本 finalize 抛错不撤销观察，允许显式 invalidate 重试；一旦到达原生资源失效边界，即使之后删除成员失败，也不重新开放观察。

通知先永久关闭该对象的生命周期，再 unlink 当前 observer，复制 callback/context 后调用；之后重新读取对象的当前 head。callback 可以删除自身或其他 observer，但不能执行 TJS 或同步释放被观察对象的引用。`IsLifetimeValid()` 在首个通知前就变为 false，避免一个 listener 升级同对象尚未轮到通知的其他 token。正常退出、异常兜底与 VM shutdown 共用该边界，不依赖子类调用 `super.finalize()`。

TypeScript 的 `HostObjectLifetime` 提供 `observe(owner, invalidated)`、`upgrade(token)` 和 `unobserve(token)`。token 含运行时身份，VM 内编号不复用；它不属于普通脚本值，也不是 JS `WeakRef`。当前仅观察实际 custom-object 实例，拒绝函数、原生类以及绑定到另一个上下文的闭包。upgrade 产生独立强句柄，token 失效则返回 undefined，分配失败单独报告，不能误判为对象已经死亡。观察记录和句柄本身仍需分配，不能把 observer 链表的无分配特性推广到整个 API。

原生在发出同步通知前撤销对象指针，runtime 在调用服务回调前移除 token。服务只能取消时钟、移除注册、结算队列等宿主状态；通知错误被保存，到安全边界报告，不跨越 native noexcept 回调传播。`dispose()` 使用重入 guard：通知中的再次 dispose 不销毁同一个 VM，upgrade 和新的执行被禁止，必要的 unobserve、排队 release 与诊断读取仍可完成。VM 先撤销全部宿主观察，再释放根对象；若 `Shutdown()` 在清理临时分配处失败，仍释放 engine 所有权以进入析构兜底，并恢复先前 shutdown 状态。

Timer / AsyncTrigger 注册时传入实例 `this`，服务保存弱 owner 和固定的动态方法名。每个实际投递的事件 upgrade 一份独立强句柄，持续持有至 dispatch promise 的 finally；`onTaken` 只调整 pending/capacity，不能提前释放正在等待调用或已暂停的对象。禁用丢弃、cached 替换、cancel、投递失败和服务销毁都必须结算对应 lease；失效后升级失败会移除陈旧源，时钟 generation 拒绝已经取消但迟到的唤醒。事件使用 `member: onTimer/onFire` 在执行时查找方法，保留覆盖和方法替换行为；用户 action owner 仍由实例强持有。

两个基础类的 `finalize()` 恢复为空方法，资源清理由原生观察通知负责。直接调用 `.finalize()` 不等于 invalidate；子类调用 `super.finalize()` 后抛错时，事件源仍应保留以便重试。此前 bootstrap 的 `finalize(){ Events.destroy(...) }` 会过早关闭资源，即使改成弱注册也不能保留这一差异。

这一划分来自原始 [TimerIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/TimerIntf.cpp) 和 [EventIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.cpp)：Timer / AsyncTrigger 的 Owner 为非持有指针，ActionOwner 单独保留用户对象，基础 finalize 为空；实际 `tTVPEvent` 才 AddRef Target/Source，投递或取消后释放。持续事件的用户注册 callback 则有明确强引用，不应随 Timer 注册表一起弱化。

`session.inspectOwnership()` 独立返回 `eventSources`、`weakOwners`、`scriptObjects`、`pendingHandles`，用于对照资源数量与真实原生存活对象。它没有加入产品 UI 的 `SessionSnapshot`。用例检查注册、队列、暂停中的持有关系、释放边界、重入销毁与恢复执行；只有句柄数归零无法证明原生对象或宿主源已经释放。本轮完整 Actions、独立双后端诊断和分配故障结果已由最终报告绑定实际源码与产物；未列入验证的其他宿主类型继续实现。

后续仍需按各类原有所有权实现，不能把所有引用统一改弱：

- Sound 的宿主表仍保留绑定实例的 dispatch。原始 [SoundBufferBaseIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/SoundBufferBaseIntf.cpp) 将非持有 Owner 与强 ActionOwner 分开；服务需要同样区分注册、实际事件和音频资源清理。
- Layer 的 `__parent`、`__children`、Window.primaryLayer 和 session callbacks 表仍引入强引用。原始 [LayerIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp) 的基础树关系使用原始指针，而 children 缓存 Array 与活动转场 callback/source/destination 又有正当强引用。[LayerManager.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp) 还单独保留 capture、hover、focus、modal 对象。重建弱树时必须补齐这些所有者。
- Window 的 dispatch/menu callback 尚为宿主永久根；Window 显式 `add()` 的对象则需要强持有。[WindowIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp) 区分了用户注册对象和仅存 native 指针的 VideoOverlay 列表。
- VideoOverlay 当前自动执行 `window.add(this)`，并由视频表强持有 dispatch。[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 的原生注册不等同于 Window.add；窗口 ActionOwner、视频事件、底层解码资源必须分别处理。
- MenuItem 的父持有子节点是原生明确行为，不能因窗口/菜单出现引用环就全部删掉。[MenuItemIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp) 的 Parent/Window 指针、ActionOwner 和子节点引用各有不同责任。

这些剩余差异及其他非插件能力仍属于原目标，当前 Timer / AsyncTrigger 实现与有限诊断不能证明整个非插件模拟器完成。

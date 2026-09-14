# 039 — 宿主对象观察、句柄释放与事件所有权

本阶段实现宿主句柄异常清理和 Timer / AsyncTrigger 的实际资源生命周期，未完成全部非插件对象。首轮完整 [Tests 34871902361](https://github.com/fenghengzhi/krkr2-web/actions/runs/34871902361) 的 Node 为 592/594，639 项浏览器与 6 项直接运行时通过；源码为 `7c08baa9951b114a1ae22eacb8a7e7a455dec93f`。两个字节码暂停/停止夹具使用无条件 TextDecoder，误把编译输出作为文本解析，已改用保留 TJS2/KBAD 二进制的 readScript，仅拦截等待标记。该失败整体仍是失败，新增实现与修订还须完成后续验证。全部构建、测试与可执行探测仅在 GitHub-hosted Actions 运行，未本地执行。

[分配诊断 34872335592](https://github.com/fenghengzhi/krkr2-web/actions/runs/34872335592) 在 VM 销毁的第 71 个分配点失败（阶段 11，440 字节）。原生对象计数虽已归零，销毁仍触发 WASM abort，分配账本与全局字符串/调试资源未回到成功对照，不能据对象数宣称回收完成。源码还发现 Shutdown 在 Release 成功后才清空 Global；Release 消费引用后抛错会留下悬空指针，已调整为先分离。诊断构建保留 WASM 函数名以进一步定位余下异常边界，正式构建不加入该调试选项；是否解决须由新故障枚举确认。

修复前的 [宿主句柄诊断 34869766340](https://github.com/fenghengzhi/krkr2-web/actions/runs/34869766340) 绑定 `4bc02b9f95a6ba4c398c1aa38dc90bca99e8012e`，已终结为失败。每个后端分别执行 20 个独立子进程用例，只有 `nested-release` 的四个源码/字节码、调试开关组合通过。批量释放在首个终结器错误后遗留对象；终结期间仍可保留正在退出的旧句柄；宿主主异常处理失败；重复释放触发 WASM 内存越界或子进程超时。完整材料保存在 `out/verification/github-actions/34869766340/complete/`，元数据为同目录上级的 `run.json`。这些失败和超时作为历史证据保留，不由新工作流或后续成功覆盖。

目标仍是 TJS2 引用计数。原引擎不自动收集任意引用环，本阶段也不引入环收集器；宿主额外制造的永久强引用需要单独修正，不能以原生不收集环为理由保留。有关失效、删除及显式断环的边界沿用 [038](038-object-finalization.md)。

宿主句柄释放队列先从 `handles` 提取待释放节点，撤销其 ID，再执行可能暂停、抛错或回调宿主的 `Clear()`。因此终结器执行期间的 retain、identity、snapshot、再次 release 都不能找到正在退出的节点。最外层 drain 持续处理新增释放请求，嵌套 host 调用不递归进入同一 drain；首个清理异常在全部排空后传播。host 已有主异常或取消时，仍完成清理，但次要终结错误不能覆盖主异常。该队列与深层对象析构队列是不同机制，诊断分别检查它们。

`tTJSCustomObject` 新增独立的 `tTJSObjectObserver` 侵入式链表，不占四个 native-instance 槽，不持有对象引用，attach、detach 和通知不分配内存。observer 必须位于稳定地址，不可复制或移动。成功执行 script finalize 和 native instance invalidation 后，在删除成员前通知；实际析构开始时再次兜底，覆盖失败的隐式终结和构造清理。脚本 finalize 抛错不撤销观察，允许显式 invalidate 重试；一旦到达原生资源失效边界，即使之后删除成员失败，也不重新开放观察。

通知先永久关闭该对象的生命周期，再 unlink 当前 observer，复制 callback/context 后调用；之后重新读取对象的当前 head。callback 可以删除自身或其他 observer，但不能执行 TJS 或同步释放被观察对象的引用。`IsLifetimeValid()` 在首个通知前就变为 false，避免一个 listener 升级同对象尚未轮到通知的其他 token。正常退出、异常兜底与 VM shutdown 共用该边界，不依赖子类调用 `super.finalize()`。

TypeScript 的 `HostObjectLifetime` 提供 `observe(owner, invalidated)`、`upgrade(token)` 和 `unobserve(token)`。token 含运行时身份，VM 内编号不复用；它不属于普通脚本值，也不是 JS `WeakRef`。当前仅观察实际 custom-object 实例，拒绝函数、原生类以及绑定到另一个上下文的闭包。upgrade 产生独立强句柄，token 失效则返回 undefined，分配失败单独报告，不能误判为对象已经死亡。观察记录和句柄本身仍需分配，不能把 observer 链表的无分配特性推广到整个 API。

原生在发出同步通知前撤销对象指针，runtime 在调用服务回调前移除 token。服务只能取消时钟、移除注册、结算队列等宿主状态；通知错误被保存，到安全边界报告，不跨越 native noexcept 回调传播。`dispose()` 使用重入 guard：通知中的再次 dispose 不销毁同一个 VM，upgrade 和新的执行被禁止，必要的 unobserve、排队 release 与诊断读取仍可完成。VM 先撤销全部宿主观察，再释放根对象；若 `Shutdown()` 在清理临时分配处失败，仍释放 engine 所有权以进入析构兜底，并恢复先前 shutdown 状态。

Timer / AsyncTrigger 注册时传入实例 `this`，服务保存弱 owner 和固定的动态方法名。每个实际投递的事件 upgrade 一份独立强句柄，持续持有至 dispatch promise 的 finally；`onTaken` 只调整 pending/capacity，不能提前释放正在等待调用或已暂停的对象。禁用丢弃、cached 替换、cancel、投递失败和服务销毁都必须结算对应 lease；失效后升级失败会移除陈旧源，时钟 generation 拒绝已经取消但迟到的唤醒。事件使用 `member: onTimer/onFire` 在执行时查找方法，保留覆盖和方法替换行为；用户 action owner 仍由实例强持有。

两个基础类的 `finalize()` 恢复为空方法，资源清理由原生观察通知负责。直接调用 `.finalize()` 不等于 invalidate；子类调用 `super.finalize()` 后抛错时，事件源仍应保留以便重试。此前 bootstrap 的 `finalize(){ Events.destroy(...) }` 会过早关闭资源，即使改成弱注册也不能保留这一差异。

这一划分来自原始 [TimerIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/TimerIntf.cpp) 和 [EventIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.cpp)：Timer / AsyncTrigger 的 Owner 为非持有指针，ActionOwner 单独保留用户对象，基础 finalize 为空；实际 `tTVPEvent` 才 AddRef Target/Source，投递或取消后释放。持续事件的用户注册 callback 则有明确强引用，不应随 Timer 注册表一起弱化。

`session.inspectOwnership()` 独立返回 `eventSources`、`weakOwners`、`scriptObjects`、`pendingHandles`，用于对照资源数量与真实原生存活对象。它没有加入产品 UI 的 `SessionSnapshot`。用例检查注册、队列、暂停中的持有关系、释放边界、重入销毁与恢复执行；只有句柄数归零无法证明原生对象或宿主源已经释放。完整 Actions、独立双后端诊断和分配故障结果仍须绑定实际源码与产物后再记为通过。

后续仍需按各类原有所有权实现，不能把所有引用统一改弱：

- Sound 的宿主表仍保留绑定实例的 dispatch。原始 [SoundBufferBaseIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/SoundBufferBaseIntf.cpp) 将非持有 Owner 与强 ActionOwner 分开；服务需要同样区分注册、实际事件和音频资源清理。
- Layer 的 `__parent`、`__children`、Window.primaryLayer 和 session callbacks 表仍引入强引用。原始 [LayerIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp) 的基础树关系使用原始指针，而 children 缓存 Array 与活动转场 callback/source/destination 又有正当强引用。[LayerManager.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp) 还单独保留 capture、hover、focus、modal 对象。重建弱树时必须补齐这些所有者。
- Window 的 dispatch/menu callback 尚为宿主永久根；Window 显式 `add()` 的对象则需要强持有。[WindowIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp) 区分了用户注册对象和仅存 native 指针的 VideoOverlay 列表。
- VideoOverlay 当前自动执行 `window.add(this)`，并由视频表强持有 dispatch。[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 的原生注册不等同于 Window.add；窗口 ActionOwner、视频事件、底层解码资源必须分别处理。
- MenuItem 的父持有子节点是原生明确行为，不能因窗口/菜单出现引用环就全部删掉。[MenuItemIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp) 的 Parent/Window 指针、ActionOwner 和子节点引用各有不同责任。

这些剩余差异及其他非插件能力仍属于原目标，当前 Timer / AsyncTrigger 实现与有限诊断不能证明整个非插件模拟器完成。

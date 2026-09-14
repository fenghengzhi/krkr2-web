# 042 — Window 与关联对象生命周期：实现进行中

以已验证的视频阶段 `2cc4ab4` 为基线，在 `codex/window-lifetime` 独立分支实现。全部构建、类型检查和测试只在 GitHub-hosted Actions 运行。本阶段尚未完成，也不表示全部非插件功能完成。

Window 原生登记强持有对象，remove 必须释放这项登记而不失效被移除对象。第一项实现为可撤销的从属对象绑定：bindDependent 返回包含 VM 身份的独立 token；unbindDependent 同步拆除观察并排队释放原生引用，实际释放仍在可挂起的 VM 边界。这样最后一项引用的析构、脚本 finalizer 及其异常不会从同步撤销入口逃出。已开始失效的登记先从映射中摘除，迟到或重复撤销不回滚已经执行的操作，也不影响新的登记。不同 VM 的 token 即使数字相同也会被拒绝。

新增源码/字节码、普通/调试模式覆盖：保持外部实例有效、撤销最后一项引用、可挂起终结器异常、owner 已失效但登记未处理、失效中重入撤销、重新登记、独立 owner、跨 VM token 和终止时仍待释放的登记。同一 fixture 接入三浏览器双后端。当前修改尚待 GitHub Actions 验证。

首轮 [34907178124](https://github.com/fenghengzhi/krkr2-web/actions/runs/34907178124) 通过 812 项 Node 和 6 组直接运行时，其中包含 216 个撤销登记场景。完整回归仍为失败：WebKit/Asyncify 的既有大图模糊停止用例出现 box-finished，678 个浏览器检查中 677 个通过。trace 中看到开始日志的观察结果与真实点击之间约相隔 1.5 秒，原测试不能证明 stop 抵达时模糊仍未完成。现沿用 TLG 取消用例的受控 Worker 边界方式，在真实列和、累加器及 64 MiB 输出图像已分配后的协作让出点等待，收到实际 stop RPC 后释放；仍保留原图、模糊算法、1.8 秒停止要求及禁止 fallback/完成标记的断言，并记录该边界的资源尺寸。该检查证明进行中的协作取消，不替代真实最坏执行延迟的测量。原失败记录完整保留，后续原生入口和修改后的取消 fixture 尚待验证。

第二项实现为原生实例失效入口：附着在 TJS 对象的 native instance slot 中，弱指向所属对象，通过已有可挂起宿主桥调用清理操作。时序为脚本 finalize → native Invalidate → 弱观察通知 → 成员删除；它不把 Window 清理推迟到成员已经不可访问的阶段。原生入口成功后不重复执行，失败允许显式失效重试；VM 终止时不调用宿主脚本。新增源码/字节码和普通/调试模式验证成员可见性、直接 finalize、脚本/原生异常重试、四个 slot 的逆序、非法登记、重入、暂停/取消和 VM 销毁。原生入口也仍在验证中，尚未接入 Window 的实际对象服务。

后续继续实现 Window 原生失效顺序、弱注册与实际事件持有、可移除的托管对象登记，以及惰性菜单。基础 Window.finalize 应为空，子类 finalize 失败时仍能保持原生对象有效并重试；直接调用 finalize 不应代替原生失效。托管对象失效失败的记录/继续处理策略，需区别于 Sound labels 的错误传播。Window.add 接受的 closure 及 bound context 也不能无条件缩减为当前从属实例 API 支持的类型。

Window/Layer/Menu 的关系分别处理：Window 不应额外强持有 primaryLayer；Layer 原生 parent 为弱指针，children Array 有独立的惰性强引用；Menu 具有强子节点登记和弱 parent，并使用稳定的惰性 children Array。聚焦、捕获、悬停、模态和转场角色本身的强引用需保留。原引擎不回收任意脚本引用环。

源码依据与 SHA-256 已保留在工作区 `out/verification/window-layer-ownership/` 和 `out/verification/menu-ownership/`。主要参考：[WindowIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp)、[LayerIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp)、[MenuItemIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp)。原生 Window 先断开视频，再失效托管对象、菜单和 draw device；Web 的异步资源关闭与这一脚本可见顺序需一同验证。上述剩余行为尚未实现，不应把绑定 API 的通过认定为 Window 阶段完成。

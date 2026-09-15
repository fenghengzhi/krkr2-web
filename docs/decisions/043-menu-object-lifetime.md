# 043 — MenuItem：实现进行中

独立分支 `codex/menu-lifetime` 从 Window 分支 `3219099` 开始，现已合入验证完成的主分支 `4cb4b4b`。菜单改造尚未合并到主分支；测试、构建与可执行验证只在 GitHub-hosted Actions 执行。

首先接入原先为空的 MenuItem.onClick：调用 action owner 的 action 成员，传递 type 和实际 target，保留返回值及闭包绑定上下文。[原生事件宏](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.h)忽略 FuncCall 返回的状态码，但不会捕获抛出的异常。因此宿主 invoke 增加 ignoreStatus，使用原生 reply kind 9；它与返回状态码的 statusOnly 互斥，不改变普通严格调用。缺失 action、null owner、成功返回对象、绑定上下文与异常传播均已写入源码／字节码用例，并接入三浏览器双后端的直接运行时。

随后增加只读原生实例身份查询。native instance 的 class id 按操作名称区分，查询直接读取原生 slot，保留同一类型最早登记项的语义；不读取可被脚本修改的 __menuId 等字段，并在显式失效后继续支持原生类型识别。0 和 uint32 最大编号、不同绑定上下文、失效／释放、不同操作和无原生实例的函数均有检查。

[34917227632](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917227632)通过 **906 项 Node**；[34917229893](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917229893)通过 **6 组直接运行时**，包含 12 组菜单调用和 24 组原生身份检查。两者均为限定范围的诊断，未替代完整应用浏览器回归。首轮测试缺少 scheduler 和脚本格式循环作用域，已保留类型检查失败记录；后续异常测试实际捕获到类型转换错误，诊断确认回调执行一次，改为显式 global.Exception 后预期异常通过。原始 34914651478、34914654028、34914919363 等失败及后续通过的原始材料均已按 run id 归档。

完整生命周期仍待接入。依据 [MenuItem 接口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp)和[成员定义](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.h)，需要区分强 action owner、强子节点登记、弱 parent，以及只保存在根菜单的弱 Window。children 是惰性创建、稳定身份的可变 Array，登记改变后才在下次 getter 重建；它不应每次返回副本。子节点登记顺序与平台显示 index 也需分开核对。

[安全对象列表](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/ObjectList.h)负责在遍历时保留列表快照，删除会同时在快照留下空位，新增项不进入当前轮次；该容器本身不管理对象的构造或析构。原生 Menu 的子节点引用由 AddChild/RemoveChild/Invalidate 显式管理。当前 Web 的父子引用环、直接 finalize、失效中修改与异常重试、缓存 Array 所有权、菜单事件临时引用和 popup 清理仍未完成。本阶段不能以 action 转发的通过代替完整菜单实现。

## 原生状态与实际菜单接入（验证进行中）

`60f8721` 开始将 MenuItem 接入独立的 `MenuService`。每个脚本实例在原生 HostLifetime 中持有私有 Dictionary，其中保存 action owner、登记子项、惰性 children Array 与原生 Array.clear 方法。TypeScript 服务只保留弱观察和显示/登记元数据；不会用永久宿主句柄把菜单根住。成功原生失效后清空状态，实际析构则使用 Variant 现有的延迟异常清理。

脚本 finalize 保持空实现，资源清理由原生实例在脚本终结器成功之后调用。子项按登记顺序失效并逐个释放，已处理的登记不在失败重试时重复持有。删除后续登记会使当前清理跳过该项。为避免原实现中向正在析构的容器新增引用的不确定行为，Web 实现明确拒绝向正在原生失效的菜单插入子项；每个实例最多累计 65,536 个登记槽，并保留现有 4,096 个活菜单和 64 层显示树限制。这些是明确的 Web 运行时边界。

`children` 返回同一个 Array，用户修改持续到登记关系再次改变；仅调整显示 index 不刷新登记缓存。失效子项仍可被父项登记和独立缓存持有，remove 对已失效非根子项不做操作。正常子项 window 为 null，只有 `(actionOwner, window)` 构造的根包装对象持有弱 Window。同一个 Window 的多个根包装对象共享显示根，分别管理各自的脚本登记；未声称复现旧 VCL 所有异常别名操作。

普通点击直接观察实际 MenuItem，在取队时取得临时强引用并在回调结束后释放；popup 返回后也直接找到实际目标，不遍历用户可修改的 children 数组。窗口终止断开显示根，子项显示资源由各自原生生命周期处理。

首轮 [34920227167](https://github.com/fenghengzhi/krkr2-web/actions/runs/34920227167) 基于 `60f8721`；后续 [34920481319](https://github.com/fenghengzhi/krkr2-web/actions/runs/34920481319) 基于 `db6eaeb`，加入 12 项源码／字节码生命周期集成用例与析构异常修正。记录此段时两轮尚未完成，不能作为通过证据。除 Node 检查外，完整应用浏览器回归和三浏览器双后端直接运行时检查仍待运行。

# 043 — MenuItem：实现进行中

独立分支 `codex/menu-lifetime` 从 Window 分支 `3219099` 开始，现已合入验证完成的主分支 `4cb4b4b`。菜单改造尚未合并到主分支；测试、构建与可执行验证只在 GitHub-hosted Actions 执行。

首先接入原先为空的 MenuItem.onClick：调用 action owner 的 action 成员，传递 type 和实际 target，保留返回值及闭包绑定上下文。[原生事件宏](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.h)忽略 FuncCall 返回的状态码，但不会捕获抛出的异常。因此宿主 invoke 增加 ignoreStatus，使用原生 reply kind 9；它与返回状态码的 statusOnly 互斥，不改变普通严格调用。缺失 action、null owner、成功返回对象、绑定上下文与异常传播均已写入源码／字节码用例，并接入三浏览器双后端的直接运行时。

随后增加只读原生实例身份查询。native instance 的 class id 按操作名称区分，查询直接读取原生 slot，保留同一类型最早登记项的语义；不读取可被脚本修改的 __menuId 等字段，并在显式失效后继续支持原生类型识别。0 和 uint32 最大编号、不同绑定上下文、失效／释放、不同操作和无原生实例的函数均有检查。

[34917227632](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917227632)通过 **906 项 Node**；[34917229893](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917229893)通过 **6 组直接运行时**，包含 12 组菜单调用和 24 组原生身份检查。两者均为限定范围的诊断，未替代完整应用浏览器回归。首轮测试缺少 scheduler 和脚本格式循环作用域，已保留类型检查失败记录；后续异常测试实际捕获到类型转换错误，诊断确认回调执行一次，改为显式 global.Exception 后预期异常通过。原始 34914651478、34914654028、34914919363 等失败及后续通过的原始材料均已按 run id 归档。

完整生命周期仍待接入。依据 [MenuItem 接口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp)和[成员定义](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.h)，需要区分强 action owner、强子节点登记、弱 parent，以及只保存在根菜单的弱 Window。children 是惰性创建、稳定身份的可变 Array，登记改变后才在下次 getter 重建；它不应每次返回副本。子节点登记顺序与平台显示 index 也需分开核对。

[安全对象列表](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/ObjectList.h)负责在遍历时保留列表快照，删除会同时在快照留下空位，新增项不进入当前轮次；该容器本身不管理对象的构造或析构。原生 Menu 的子节点引用由 AddChild/RemoveChild/Invalidate 显式管理。当前 Web 的父子引用环、直接 finalize、失效中修改与异常重试、缓存 Array 所有权、菜单事件临时引用和 popup 清理仍未完成。本阶段不能以 action 转发的通过代替完整菜单实现。

# 043 — MenuItem：实现进行中

独立分支 `codex/menu-lifetime` 从 Window 分支 `3219099` 开始。Window 的完整应用回归仍在排队，本阶段尚未合并；测试、构建与可执行验证只在 GitHub-hosted Actions 执行。

首先接入原先为空的 MenuItem.onClick：调用 action owner 的 action 成员，传递 type 和实际 target，保留返回值及闭包绑定上下文。[原生事件宏](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.h)忽略 FuncCall 返回的状态码，但不会捕获抛出的异常。因此宿主 invoke 增加 ignoreStatus，使用原生 reply kind 9；它与返回状态码的 statusOnly 互斥，不改变普通严格调用。缺失 action、null owner、成功返回对象、绑定上下文与异常传播均已写入源码／字节码用例，并接入三浏览器双后端的直接运行时。当前尚无通过结果。

完整生命周期仍待接入。依据 [MenuItem 接口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp)和[成员定义](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.h)，需要区分强 action owner、强子节点登记、弱 parent，以及只保存在根菜单的弱 Window。children 是惰性创建、稳定身份的可变 Array，登记改变后才在下次 getter 重建；它不应每次返回副本。子节点登记顺序与平台显示 index 也需分开核对。

[安全对象列表](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/ObjectList.h)负责在遍历时保留列表快照，删除会同时在快照留下空位，新增项不进入当前轮次；该容器本身不管理对象的构造或析构。原生 Menu 的子节点引用由 AddChild/RemoveChild/Invalidate 显式管理。当前 Web 的父子引用环、直接 finalize、失效中修改与异常重试、缓存 Array 所有权、菜单事件临时引用和 popup 清理仍未完成。本阶段不能以 action 转发的通过代替完整菜单实现。

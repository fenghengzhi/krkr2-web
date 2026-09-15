# 043 — MenuItem 的原生生命周期

菜单由 `src/engine/scene/menu-items.ts` 的 MenuService 管理；MenuTree 只保存显示状态，TJS 类负责脚本接口。原生状态、子项登记、显示顺序和事件目标分开管理。

## 对象与引用

`registerNativeLifetime` 可以接收私有状态对象。HostLifetime 强持有该 Dictionary，其中保存 action owner、登记子项、惰性 children Array 与原生 Array.clear 方法。TypeScript 只保存弱观察及元数据；全局清理函数只持有一次，不通过永久宿主句柄持有菜单。

原生类型查询直接读取实例 slot，不读取可被脚本修改的字段。查询允许显式失效的实例，支持不同绑定上下文；类编号按操作名称区分，重复登记仍选择最早匹配项。菜单操作先做实际原生类型识别，因而可以接受失效子项并按原生规则处理。

依据 [MenuItem 接口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.cpp)和[成员定义](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/MenuItemIntf.h)：action owner 和登记子项是强引用，parent 是弱引用；正常子项 window 为 null，只有 `(actionOwner, window)` 构造的根包装对象引用弱 Window。Window.menu 惰性调用 `(this, this)`，多个包装对象共享窗口显示根，同时保留各自的脚本身份和登记。

`children` 返回同一个可修改的 Array。用户修改一直保留到登记关系改变，随后 getter 在原缓存中重建。缓存本身独立持有其中的子项。显示 index 与登记顺序分开，调整 index 不刷新缓存；index 和显示编号保留 TJS Integer 类型。已失效非根子项仍可由父项登记或缓存持有，remove 对它不做操作。

## 失效与停止

脚本 finalize 是空实现。原生实例在脚本终结器成功后运行清理，此时脚本成员仍可读取。子项按登记顺序逐个失效、释放，再释放缓存、Array.clear 和 action owner。脚本终结器失败会保留原生状态；子项失效失败会保留尚未完成的登记，允许重试。

[原生安全对象列表](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/ObjectList.h)允许删除当前清理中尚未访问的项。Web 用带空位的登记槽实现相同的跳过行为，不创建额外强持有整个子项集合的快照。为避免向正在析构的容器新增引用所产生的不确定行为，Web 明确拒绝向正在原生失效的菜单插入子项。限制为 4,096 个活菜单、64 层显示树和每个实例累计 65,536 个登记槽。

成功原生失效会释放私有状态；实际析构使用 Variant 现有的延迟异常机制，保留主错误。VM 维护不持有对象的状态登记，在终止会话时切断原生持有边，不再执行脚本或宿主回调。这支持原生状态有意持有自身 owner 的情况，不是运行期间的任意脚本引用环回收器。

显示节点独立清理。窗口终止断开显示根；删除一个显示节点只解除子节点的显示父关系，子项自身的资源由它的原生生命周期处理。

## 调用与输入

onClick 调用 action owner 的 action，传递 type 与实际 target，保留返回值和闭包上下文。[原生事件宏](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.h)忽略负的 FuncCall 状态，但保留抛出的异常。桥接使用独立的 ignoreStatus，不改变严格调用或 statusOnly。

普通点击直接观察实际 MenuItem，在取队时取得临时强引用并在回调结束后释放。popup 返回后也直接取得实际目标，修改 children 缓存不会改变事件路由。保留页面可见性、输入 epoch、eventDisabled、popup flags 和取消语义。

popup 目前仍要求附着到 Window.menu，且不在挂起期间运行另一个计时回调；原生窗口句柄、全部 Win32 布局标志及旧 VCL 异常别名操作尚未覆盖。完整非插件目标仍在进行。

## 验证与失败历史

全部构建、类型检查、测试和可执行探测都在 GitHub-hosted Actions 上运行，本地只检查和编辑源文件、格式化及整理云端产物。

`6e1522a` 的[完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921184943)通过 **918 项 Node、678 项浏览器检查和 6 组直接运行时**；[原 KAG／离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921436630)通过 **78 项**。所选案例零失败、取消、跳过和 flaky。直接运行时包含 12 组源码／字节码菜单调用与生命周期报告，以及 24 组原生身份、私有状态、引用环、析构失败和停止检查；所有私有状态停止检查的原生 slot 数为零。

最后的整数类型修正在 `a9403d0`。其 [Node 诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921990896)通过 918 项，[完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921937558)通过全部 14 个 job：918 Node、678 浏览器和 6 组直接运行时，零失败／跳过／flaky。24 组原生状态检查的停止后 slot 数全部为零。TJS ABI 5、字体 ABI 2、会话协议 9 保持不变。

首次[兼容性检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34922040505)在 WebKit ZIP／Asyncify 存档刷新场景失败：存档和两种缩略图已写出并读回，刷新后测试在 KAG 构造完成前检查退出全屏按钮，后续全屏画布遮挡了控制台。trace 记录该检查返回 false，随后执行按钮点击被画布拦截 30 秒。`fc72347` 让初次启动和刷新都等待执行按钮可用，再通过实际 UI 退出全屏并等待布局完成；没有强制点击或增加固定延时。修正后的[兼容性检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34922607852)通过全部 **78 项**，应用产物仍来自 `a9403d0` 的精确云端构建。

此前原生 action／身份基础的 [906 项 Node](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917227632)和[直接运行时](https://github.com/fenghengzhi/krkr2-web/actions/runs/34917229893)保留为早期证据。完整日志与产物都按 run ID 保存在 `out/verification/github-actions/<id>/complete/`。

失败材料同样保留：

- 34920227167、34920481319：构造器误用小写 object，修正为 TJS 的 Object。后者还暴露了字节码测试夹具的解码错误。
- 34920652888：909/915，含预期原生类型拒绝日志的错误断言、两个字节码夹具和缺少分号的挂起脚本；另有 Debug 测试进程触发 V8 `jit_page_->allocations_.erase(addr) == 1` 断言。原始 core 与回溯已归档，原因未确认。
- 34920968188：913/918，剩余 5 项夹具错误；4 组原生状态／停止检查已经通过，Debug 断言未再出现。
- 34920654814、34920970231：直接运行时因上述预期拒绝日志断言失败；后续 6e1522a 完整检查通过。不能用后续通过覆盖原始失败。

更早的 349143* 类型检查失败、34914651478／34914654028 及 34914919363 异常夹具失败仍保留。字典 action 中使用显式 global.Exception 后获得预期异常；原错误实际是类型转换异常，并未被 ignoreStatus 吞掉。

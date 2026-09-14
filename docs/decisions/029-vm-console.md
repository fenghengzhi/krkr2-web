# 原生调试类、VM 控制台与脚本转储

调试面板阶段只用 TJS 实例承载显示属性，与原 KRKR2 返回原生类对象的行为不同。VM 本身的编译警告和异常代码输出也没有接入 Debug 历史。本阶段补上这两个边界，并提供 `Scripts.dump()` 的独立文件输出。

## 原生类边界

`ScriptClass` 描述宿主类名、命名空间、标识和属性；薄 C++ 适配器使用原 `tTJSNativeClass` 管理类身份、构造和静态成员复制。属性操作通过已有的可挂起宿主调用进入 TypeScript。Console/Controller 的 `visible` 使用原生 TJS 布尔转换，状态仍在 `DebugPanels`，页面 RPC 和 DOM 不变。

`Debug.console/controller` 保持稳定的只读入口，同时识别自身类名与 `Class`。没有全局 Console/Controller 名称，但可以通过 Debug 的属性构造实例；实例识别自身类名，不识别 Class，也不包含类的静态 `visible` 属性。上一阶段把构造拒绝写入测试是错误的兼容假设，现已按原生规则修正。

## 控制台与编译

独立运行时默认不安装输出回调。EngineSession 在创建日志服务后调用 `setConsoleOutput`，把 `iTJSConsoleOutput.Print/ExceptionPrint` 接到历史、观察者与文件输出。回调返回现有 HostReply，嵌套脚本继续在原 C++/TJS 栈内运行；不会从 JavaScript 再次进入正在执行的 WASM。

编译阶段也可能产生警告，因此 `ScriptRuntime.compile()` 改为返回 Promise，并使用同一串行、可暂停和可取消的入口。JSPI 导出列表包含 `krkr_compile`。回调可等待资源、执行嵌套脚本，完成后原编译继续；源码尚未执行时，其顶层变量仍未初始化。执行中的运行时拒绝替换控制台回调，以免干扰暂时切换的转储输出目标。

VM 的原生诊断可能在游戏自己的 catch 之前出现，包含脚本位置、反汇编与寄存器。历史与页面因此会多出实际 VM 输出。与源代码/地址有关的文本不能假装是跨构建稳定的固定日志。诊断观察者抛错时，原 VM 异常生成代码的三个 catch 分支保留主要错误；取消仍由外层执行控制处理。

整体销毁前先清除原生输出指针，再释放句柄与 VM，避免停止后的输出启动脚本回调。现有“整个 VM 销毁时跳过用户 finalizer，显式 invalidate 仍正常执行”的平台规则保持不变。

## Scripts.dump

原 KRKR2 的 dump 使用独立文件接收端，不把每一行转储发给日志观察者。本项目同样临时切换输出目标，保留原 `tTJS::Dump` 内容，形成带 BOM、CRLF 的 UTF-16LE 字节。正常结束和异常退出都会恢复控制台目标。

在 Web 中，输出路径映射为 `savedata/krkr2-web.dump.txt`；原生路径是可执行文件名加 `.dump.txt`。每次成功生成都替换旧内容，完成后通过 Debug 派发一条 `Dumped to ...` 消息。完整转储正文不通知观察者，因此不会在遍历 ScriptBlocks 时由观察者编译、释放或修改正在遍历的对象。

转储上限为 16 MiB，收集过程中按约 8 ms 时间片让出，支持暂停和取消。完整字节生成后才进入 SaveOverlay；中途停止不发布半份文件。文件随存档导出、导入及浏览器持久恢复。

只有转储的事务失败时保留可导出的字节，提示尚未持久化，游戏继续运行；下一次显式 dump 会重试提交。覆盖层已满时保留已有游戏文件并报告转储失败。同一路径上尚未提交的游戏写入仍保持严格失败语义，不会因为转储覆盖而被降为可忽略的诊断写入。

## 版本与验证

新增原生类、控制台和转储桥，并改变编译入口的异步约定，因此 TJS WASM ABI 从 **2 升到 3**。字体 ABI **2**、会话协议 **9** 保持不变。前一阶段发布完整保存在 `out/verification/vm-console/abi2-root`，树哈希与原矩阵一致，供真实旧/新发布离线检查使用。

38 项 Node 专项、36 项浏览器面板/VM 检查以及三浏览器双后端的 6 项独立运行时探测已通过。独立探测直接使用生产运行时适配器的浏览器构建，检查异步 compile、嵌套回调、转储、主要异常、暂停、取消和释放；没有使用仅测试用的 WASM 导出。

初次全 Node 检查有一项旧断言只接受用户日志，未包含新接入的原生反汇编；等待期间不输出的断言保留，恢复后的断言现区分诊断与原来的 catch/完成顺序。独立探测最初把带转译辅助函数的代码直接序列化到页面，产生 `__name` 缺失；改为加载完整构建后的探测模块。旧失败记录均保留。6 项冷离线专项也已通过。本地完整回归随后按用户要求中止（退出码 143），此后测试仅在 GitHub Actions 上执行。新的 [GitHub Actions 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809918318)已通过 346 项 Node、603 项浏览器测试及 6 项直接运行时专项；[外部兼容性运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812505215)另通过全部 66 项：原 KAG 36 项、菜单 6 项、异常恢复 6 项、TJS ABI 1→3 和 2→3 各 6 项、字体 ABI 1→2 共 6 项。原 XP3/ZIP 和三份历史发布现固定在仓库中，云端先核对全部字节与构建哈希；离线升级实际关闭服务器并启动旧/新 Worker。迁移范围见 [测试说明](../testing.md)。

[最终阶段报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812958010)已在 GitHub Actions 通过并生成 `out/verification/vm-console-matrix.json`，SHA-256 为 `81beb0d8763cfc667c01b6e799d561ab80db8fb9944cba4c1e40408a9f18059d`。它绑定当前应用与发布、旧发布样本、上述完整回归及 66 项兼容性、3 次额外可信长冻结，以及 487 份证据文件。TJS ABI 3、字体 ABI 2、协议 9 的本阶段验证完成；其他接口仍按下述范围继续实现。

## 剩余范围

本阶段尚未接入的 `Scripts.getTraceString` 已在后续 [脚本调用栈阶段](031-script-stack-traces.md)实现，使用拥有的指令偏移处理挂起期间的栈记录所有权，也接通了调试模式的额外异常输出。原生错误 UI 的自动打开策略、其他隐式回收/异常路径和整个非插件目标仍未完成。当前的绿色检查只证明各阶段列明的行为。

参考：[Scripts](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts.html)、[Debug.console](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_console.html)、[原 KRKR2 DebugIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/utils/DebugIntf.cpp)、[原生调试类](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/utils/win32/DebugImpl.cpp)。参考源码的副本和哈希继续保留于前一 Debug 阶段。

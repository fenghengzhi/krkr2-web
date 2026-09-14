# 原生 Scripts 宿主

当前 [完整回归 34823979389](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823979389) 已通过 **362 项 Node、615 项浏览器及 6 项直接运行时检查**；[对应兼容性 34824129905](https://github.com/fenghengzhi/krkr2-web/actions/runs/34824129905) 已通过 **78 项**。所选用例无失败、跳过、flaky 或重试。下文较早的“待执行”和计费阻塞记录属于保留的历史状态。

此前 `Scripts` 是 TJS 字典，exec/eval 等包装函数多出桥帧，缺少参数时仍会进入宿主，非对象 context 还会被忽略。本阶段使用原 `tTJSNativeClass` 和原生方法对象注册 Scripts，禁止创建实例，保留 Function/Class 身份和静态成员语义。

## 边界

`native/tjs2/scripts.cpp` 负责原生参数数量、字符串/整数/对象转换、TJS 执行和编译，以及 `getClassNames`、`setCallMissing` 的原生对象操作。它通过小型 HostCall 接口请求数据，不管理浏览器资源、网络或持久化。`exec/eval` 直接进入同一 VM，`execStorage/evalStorage` 继续使用挂起后的宿主回复；调用栈不再包含 Scripts 自身的 TJS 包装函数。资源执行的位置名使用解析后资源的末段名称，inline 执行未提供名字时使用原生空名称，行偏移由 TJS 转换。

`compileStorage(input, output, result=false, debug=false, expression=false)` 先读取文本，再创建原生输出流并调用同一 TJS 编译器。三个标志使用原生整数转换。编译不执行输入；后续可立即执行写出的 TJS 字节码，也可通过存档备份和浏览器持久化恢复。

输出流沿用原生 Array/Dictionary 的桥接写入队列和 64 MiB 预算。读取失败不会打开输出；一旦输出已打开，编译失败或取消仍会关闭并发布空/部分流，符合参考的析构路径。编译输出按游戏文件处理，持久化失败仍是严格失败，不使用 dump 的可忽略诊断写入规则。浏览器原始导入文件保持只读，写入落在存档覆盖层。

后续源码检查发现，参考 TJS 的全局 `IsBytecodeCompile` 在日志回调中嵌套编译结束时被清空，外层随后注册的类成员因而缺少导出元数据。现把模式改为脚本块所有，普通嵌套执行与两层编译彼此独立；成员元数据改为值容器，由上下文析构释放，避免编译失败时跳过只在成功导出路径里的释放代码。新增案例在外层警告中分别执行成功与失败的内层编译，然后检查外层构造函数、方法和 getter/setter；Node 还在新 VM 回读最终字节码，浏览器案例覆盖两种后端。当前预期 Node 总数为 361，仍待 Actions 实际执行，不能凭源码检查认定通过。

账户限制随后不再拦截任务，[34821659023](https://github.com/fenghengzhi/krkr2-web/actions/runs/34821659023) 已编译全部原生内核，类型检查发现字体测试的 Worker 拦截函数遗漏 transfer 数组重载，修正后 [34822033340](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822033340) 进入完整回归。新案例进一步暴露 Bison 错误回调只记录日志、未增加编译错误计数的问题；现接回 `_yyerror`，并在 parse 失败时阻止执行或导出已解析前缀。字节码加载器也修正了匿名上下文 `-1` 名称索引和调试表 `new[]`/`TJS_free` 分配释放不匹配。调试标志验证直接读取字节码中的字符位置表；原格式没有源码行表，加载后行号仍为 1。新增语法失败/恢复案例后预计 362 项 Node，以上修复待新提交的云端回归确认。

`dump/getTraceString` 使用相同的原生方法绑定。dump 仍通过独立 UTF-16 收集器输出，不把正文发给观察者；getTraceString 仍受启动时的脚本调试选项控制。其他 TVP 接口的 TJS 桥帧尚待迁移，不通过过滤文件名隐藏。

## 文本编码扩展

参考快照中的 `textEncoding` 支持 UTF8/UTF-8、GBK 和四种 SJIS 名称。选择保存在会话中，影响后续 Scripts、原生文本流、KAG 读取与编译；BOM 和明确的 utf-8 模式优先。getter 保留原输入拼写。无效赋值按参考先改变名称、再抛错，实际解码器仍沿用前值。

未显式选择时仍使用现有 Web 解码策略（严格 UTF-8，失败后 Shift-JIS）。参考的自动探测次序、解码器锁定行为和全部旧字符映射尚未对齐，不能将该扩展视为完整原生文本兼容。TJS 二进制序列化数据通过 Scripts 资源接口读取、带前缀字节码及完整存储路径行为也仍需独立验证。

## 版本与验证

增加原生 Scripts 类构造桥，TJS WASM ABI 升到 **5**；字体 ABI **2**、会话协议 **9** 不变。验证仅在 GitHub Actions 执行，覆盖原生类和参数、反射/missing、准确调用栈、编译标志、输出生命周期、编码、暂停/取消、浏览器与冷离线恢复。云端结果待补齐。

修复提交 `1ef4775e3e11e1474aec56e8c36e6d141adb91da` 的 [Actions 34821034573](https://github.com/fenghengzhi/krkr2-web/actions/runs/34821034573) 被 GitHub 账户计费检查阻止，构建步骤尚未启动。官方 annotation 为：`The job was not started because recent account payments have failed or your spending limit needs to be increased.` 因此修复后的类型检查、编译、360 项 Node、615 项浏览器及兼容性矩阵均待执行，不把该次运行或先前 ABI 4 成果视为本次通过。账户恢复后应在当前源码重新执行 Tests，再执行 compatibility 和 Verification report；不得改用本地测试。

首轮 [Actions 34819597478](https://github.com/fenghengzhi/krkr2-web/actions/runs/34819597478) 的 Node 检查发现字节码导出表只登记复合赋值、自增/自减的寄存器形式，漏掉直接成员、索引成员和属性对象形式。现按原 VM 连续枚举登记四种形式，并把组起始指令传给转换函数；新增 64 组源码/导出执行比较。测试中的多语句命令改用 `Scripts.exec`，避免表达式接口隐式 return 导致后续语句不执行；匿名调用栈保留原生地址名称，直接在 try 中捕获的原生异常不再产生已移除包装帧的诊断。

同轮 Firefox 字体选择失败的 trace 显示：异步 sample 到达后，canvas 从默认 300×150 变为 640×96，居中弹窗和按下的选项随之移动；字体缩略图也改变行高。界面现在预留实际 sample 比例、固定选项高度，并保留按钮子节点。原浏览器案例新增可控的预览请求门控，在按下后才放行所有预览，检查选项矩形不变，再释放鼠标并验证原有选择与像素结果。失败记录和截图保留，修复结果由后续 Actions 证明。

首轮全部实际测试作业已结束：Node 353/359 通过，浏览器 614/615 通过，6 项直接运行时通过；失败为上述 6 项 Node 与 1 项 Firefox 字体选择。其汇总阶段与后续 push 重叠，GitHub 将整体运行记为 cancelled，不能视为完整成功。全部产物、逐项结果和 terminal 元数据保存在 `out/verification/github-actions/34819597478/`；计费失败运行的元数据和两份 annotation 保存在 `out/verification/github-actions/34821034573/`。ABI 4 的旧发布包已另按原字节保存；新增 78 项兼容性与 ABI 5 报告流程尚未执行。

[34822580654](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822580654) 的全部 362 项 Node 已通过；原生生命周期 fixture 在初始页面尚未发布时使用 `pages()[0]`，修正为在原 30 秒 fixture 预算内等待页面事件。[34823107202](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823107202) 中 Node、7 项可信生命周期和 6 项直接运行时已通过，但 Firefox 切换到第二个 Scripts 样本时出现 `RPC client has been disposed`：两次页面 stop 同时等待相同播放器，第一个完成后销毁了第二个请求。页面现共用正在进行的停止 Promise，并立即更新忙碌状态；回归门控旧 stop RPC，直到下一次文件 change 已请求启动后才放行，检查停止请求只有一次且第二个样本完成。未增加 Worker 的 2 秒停止期限或浏览器断言期限。

两个中间构建的 [34822108506](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822108506) 和 [34823023871](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823023871) 均通过 78 项原 KAG/跨 ABI 专项，但页面或内核继续修改后仍须验证当前构建。它们及各次失败/取消产物均按 run ID 保存在 `out/verification/github-actions/`。字节码完整边界校验和其他异常、回收与并发启动排列仍不属于这些选定案例已经证明的范围。编译暂停/取消案例目前依赖警告回调的异步边界；无回调的大脚本解析/导出尚未接入主动检查点，不能由这些案例推断已支持任意编译阶段的及时取消。

参考：[KRKR2 Scripts 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts.html)、[原 KRKR2 ScriptMgnIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/base/ScriptMgnIntf.cpp)，以及固定参考快照的 ScriptMgnIntf.cpp/TextStream.cpp。完整非插件目标仍未完成。

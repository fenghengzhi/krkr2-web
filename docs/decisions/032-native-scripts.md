# 原生 Scripts 宿主

原生 Scripts 阶段的 [完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823979389)已通过 **362 项 Node、615 项浏览器及 6 项直接运行时检查**；[对应兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34824129905)已通过 **78 项**。所选用例无失败、跳过、flaky 或重试。TJS WASM ABI 为 **5**，字体 ABI **2**、会话协议 **9**。

## 原生对象与 Web 边界

此前 `Scripts` 是 TJS 字典，exec/eval 包装函数多出桥帧，缺少参数时仍进入宿主，非对象 context 还会被忽略。现在由原 `tTJSNativeClass` 和原生方法对象注册 Scripts，禁止创建实例，保留 Function/Class 身份、静态成员、原生参数数量和字符串/整数/对象转换。

`native/tjs2/scripts.cpp` 负责执行、编译、`getClassNames` 和 `setCallMissing`，通过小型 HostCall 请求数据。浏览器资源、解码、网络和持久化仍由 TypeScript 管理。`exec/eval` 直接进入同一 VM；`execStorage/evalStorage` 使用挂起后的宿主回复。Scripts 自身的 TJS 包装帧已移除，其他 TVP 桥帧保留。资源位置名使用解析后资源的末段；inline 未提供名字时保留原生匿名名称，行偏移由 TJS 转换。

`dump` 仍使用独立 UTF-16 收集器，不把正文发送给日志观察者。`getTraceString` 仍由启动时的脚本调试选项控制。直接在 try 中捕获的原生错误不会产生已移除包装帧的额外诊断。

## 编译与输出生命周期

`compileStorage(input, output, result=false, debug=false, expression=false)` 先读文本，再创建原生输出流并调用同一 TJS 编译器。三个标志采用原生整数转换。编译不执行输入；输出可以立即执行，也可通过浏览器持久化、备份和冷离线启动恢复。

输出使用原生 Array/Dictionary 的桥接写入队列和 64 MiB 预算。读取失败不会打开输出；打开后，编译失败或取消仍会关闭并发布空/部分流。编译输出是严格的游戏写入，持久化失败仍会报错并保留可导出内容。原始导入文件保持只读，写入位于存档覆盖层。

本阶段修复了参考快照中的以下问题：

- 字节码导出表只登记复合赋值、自增/自减的基础形式，漏掉直接成员、索引成员和属性对象。现登记全部四种形式，64 组源码/导出执行对照通过。
- 全局 `IsBytecodeCompile` 会被日志回调中的内层编译清空。模式现由脚本块独立持有；成员元数据使用值容器，编译失败时也能随上下文释放。验证覆盖内层成功/失败、外层构造函数/方法/getter/setter，以及新 VM 回读。
- Bison 错误回调只记录日志，未增加编译错误计数。现在接回 `_yyerror`，失败解析不能执行或导出已经解析的前缀。
- 加载器将匿名上下文的 `-1` 名称索引当作数组下标，并用 `new[]` 分配由 `TJS_free` 释放的调试表。现分别处理匿名名称，并配对原生分配/释放接口。

`debug` 标志控制导出的字符位置表。原字节码格式不保存源码行表，因此加载后的原生行号仍为 1；测试直接核对字符位置表，不伪造原始行号。

## 文本编码

`textEncoding` 支持 UTF8/UTF-8、GBK、SJIS/shiftjis/shift_jis/shift-jis。选择保存在会话中，影响后续 Scripts、原生文本流、KAG 读取和编译；BOM 与明确的 utf-8 模式优先。UTF-8 BOM 只移除一次。getter 保留输入拼写；无效赋值按参考先改变名称再抛错，解码器沿用前值。

未显式选择时仍采用现有 Web 策略：严格 UTF-8，失败后 Shift-JIS。参考的自动探测次序、解码器锁定和全部旧字符映射尚未对齐。

## 验证中发现的页面问题

字体 sample 加载后，canvas 从默认 300×150 变为 640×96，居中弹窗和按下的选项随之移动；缩略图也改变行高。现在预留实际 sample 比例、固定选项高度并保留按钮子节点。浏览器测试在按下后才放行预览，检查矩形不变，再释放鼠标并检查选择和像素结果。

停止未完成时导入下一游戏，原来会对同一播放器发送两个 stop RPC，第一个完成后销毁第二个请求。页面现在共用停止 Promise，并立即更新忙碌状态。浏览器门控旧 stop，直到下一次文件 change 已请求启动才放行，检查只有一次停止请求、第二个 Scripts 样本完成，以及最终正常停止。Worker 的 2 秒停止期限与浏览器断言期限保持不变。

## 云端证据与历史

[最终报告 34825096969](https://github.com/fenghengzhi/krkr2-web/actions/runs/34825096969)生成 `out/verification/native-scripts-matrix.json`，绑定源码、构建、逐项结果和 **495 份证据**。报告 SHA-256 为 `1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d`。当前生产 build 为 `321e186539bc622b2d22dd69a108deeb6183073c34b539b8ccbf6d3bc8dae861`，原生可信冻结间隔为 **21,055.2 ms**。当前阶段没有额外三次冻结或输入时序复测，不把历史重复次数计入本轮。

全部验证只在 GitHub 托管 runner 执行。产物按 run ID 保存在 `out/verification/github-actions/`；当前 `.generated` 和 `dist` 从已通过的云端构建恢复，旧工作区产物保存在 `out/verification/native-scripts/prior-local-artifacts/`。

| 运行 | 保留的结果与处理 |
| --- | --- |
| [34819597478](https://github.com/fenghengzhi/krkr2-web/actions/runs/34819597478) | Node 353/359、浏览器 614/615、直接运行时 6 项通过；暴露导出指令问题、测试对表达式/诊断的错误预期及 Firefox 字体点击失效。汇总与后续 push 重叠，整体为 cancelled。 |
| [34821034573](https://github.com/fenghengzhi/krkr2-web/actions/runs/34821034573) | GitHub 付款/支出限制阻止所有步骤启动，无测试结果；随后限制不再拦截任务。 |
| [34821659023](https://github.com/fenghengzhi/krkr2-web/actions/runs/34821659023) | 原生编译成功，类型检查拒绝字体测试里遗漏的 postMessage 重载；已修正测试转发签名。 |
| [34822033340](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822033340) | 新测试暴露语法错误未阻止编译、元数据加载和字节码行号预期问题；修复后重新回归，原运行被后续提交取代。 |
| [34822580654](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822580654) | 362 项 Node 通过；原生 fixture 在初始页面出现前创建 CDP 会话。现于原 30 秒 fixture 预算内等待页面事件。 |
| [34823107202](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823107202) | Node、7 项可信生命周期和 6 项直接运行时通过；Firefox 暴露并发停止导致的 RPC 销毁错误，WebKit 被后续提交取代。 |
| [34822108506](https://github.com/fenghengzhi/krkr2-web/actions/runs/34822108506)、[34823023871](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823023871) | 两个中间构建各通过 78 项兼容性；当前构建仍独立完成了文首对应专项。 |

## 仍未完成

Scripts 资源接口读取二进制序列化 Array/Dictionary、带前缀字节码、完整存储路径和字节码边界校验仍需继续。编译暂停/取消案例目前依赖异步 I/O 或警告回调；无回调的大脚本解析/导出尚未接入主动检查点。其他 TVP 桥帧、原生错误 UI、隐式回收和更多并发启动排列也仍未完成。本阶段通过不代表完整非插件兼容目标完成。

参考：[KRKR2 Scripts 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts.html)、[原 KRKR2 ScriptMgnIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/base/ScriptMgnIntf.cpp)，以及固定参考快照的 ScriptMgnIntf.cpp、TextStream.cpp 和 TJS2 源码。

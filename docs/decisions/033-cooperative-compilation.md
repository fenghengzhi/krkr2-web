# 长脚本编译的暂停与取消

TJS 源码准备、词法/语法分析、代码生成与字节码导出已接入主动让出。[完整云端回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829312486)已通过 **371 项 Node、621 项浏览器测试和 6 项直接运行时检查**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829383281)另通过 **78 项**。所选用例无失败、跳过、flaky 或重试。直接运行时包含三浏览器双后端的 36 条编译控制路径。TJS ABI **5**、字体 ABI **2**、会话协议 **9**。

## 控制边界

编译使用现有 WASM → JavaScript `onYield`，和执行指令共用约 8 ms 的工作期限。扫描与大循环每 1,024 个工作单元检查一次期限；到期先交回事件循环，再等待会话 `ExecutionControl`。暂停保持当前 C++ 栈，继续后接着编译；取消走原生异常清理并由运行时返回 `AbortError`。

检查点覆盖源码长度与复制、行表、词法预处理、注释/空白/标识符/文字扫描、条件编译表达式、取 token、代码生成、跳转修正、常量/调试表导出和输出复制。输出按 64 KiB 片段写入。分阶段作用域在嵌套编译、日志回调返回和异常展开时恢复此前状态；普通值转换不单独启用编译扫描暂停。构造函数发出的初始指令尚未交给上下文栈管理，因此避开该处的暂停。

`onYield` 的可选参数标记执行、源码准备、解析/代码生成、导出、转储。既有无参回调仍可使用；C 导出和外部 ABI 不变。TJS manifest 保持 ABI 5，添加 `capabilities.cooperativeCompilation: 1`。报告由能力标记区分这一阶段，不覆盖历史原生 Scripts 矩阵。

## 取消后的释放

复制中的源码、词法值、条件编译缓冲区、octet 文字和导出临时容器采用自动所有权，异常展开也会释放。octet 文字使用增长容器，保留原来的奇数半字节与逗号规则。常量导出读取 octet 时使用不增加引用计数的访问器。

直接 `compile()` 取消不返回部分字节码。`Scripts.compileStorage` 仍遵循打开输出后的原生语义：关闭并发布空/部分内容，随后提交存档；输入读取失败则不打开输出。该行为与上一阶段保持一致。

## 验证设计

新辅助器在真实 `ModuleFactory` 的 `onYield` 外层观察阶段，命中时暂停，检查 25 ms 内编译不结算且让出计数不再推进。没有编译警告或宿主回调负责制造挂起。源文件包含大注释与 2,048 个独立字符串常量，恢复后读取实际导出的常量并验证结果为 4,096，同时检查编译本身没有执行输入。

- Node 分别验证三个阶段的暂停/继续和暂停/取消，另验证三个阶段中 `compileStorage` 关闭并持久化已打开的输出。
- 直接浏览器运行时在 Chromium、Firefox、WebKit 的 Asyncify/JSPI 中重复六种控制路径，保存阶段计数、结果大小和宿主句柄数。
- 页面用例在连续长编译期间点击暂停、停止，再启动新 VM；保留现有 Worker 2 秒停止期限，并检查没有触发强制停止错误。
- 原有完整测试、KAG 和跨 ABI 离线升级仍须对同一生产构建通过，最终报告绑定构建、源码和逐项证据。

首轮 [34827073341](https://github.com/fenghengzhi/krkr2-web/actions/runs/34827073341) 的 Chromium、Firefox 各有两项新页面测试失败，日志均记录了重复 stop：用户停止让 startup 拒绝，启动的 catch 又调用一次 Player.stop，第一个响应销毁了第二个 RPC。页面现在在停止期间保留停止流程对清理、忙碌状态与错误呈现的控制；Player 本身也共用停止 Promise，使输入、媒体和消息端口只执行一次收尾。测试增加只有一个 stop RPC 和取消不显示为启动错误的断言，保留原失败截图、trace 和日志。该轮 WebKit 常规套件被后续提交中断，整体为 cancelled，不计为通过。中间构建的 [34827454268](https://github.com/fenghengzhi/krkr2-web/actions/runs/34827454268) 已通过 78 项兼容性，但页面修复后的生产构建仍独立执行新专项。

第二轮 [34827988522](https://github.com/fenghengzhi/krkr2-web/actions/runs/34827988522) 的编译与停止用例均通过，完整结果为 371 项 Node、620/621 项浏览器和 6 项直接运行时。唯一失败为 Chromium Asyncify 视频混合截图：定位到第 6 帧后仍取得初始红色，原绿色通道断言失败；截图与 trace 均保留。对应 [34828130875](https://github.com/fenghengzhi/krkr2-web/actions/runs/34828130875) 的 78 项兼容性通过，不替代失败回归。

固定 [40 次原视频场景诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34828858754)未复现失败，记录了 currentTime 设置、原生 seek 事件、解码像素和呈现时间戳。`seeked` 与呈现回调是分开的事件，前者不是截图同步点；[requestVideoFrameCallback 文档](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)定义后者为帧提交给合成器时的回调。因此像素用例现增加目标帧 `mediaTime=0.5` 的呈现条件，再进行原来的单次截图和颜色断言，附带呈现次数、位置及像素记录。未更改生产视频实现、颜色范围或超时。诊断观察可能影响时序，浏览器内部的偶发原因仍未确认，不把 40 次诊断通过视作原失败消失的证明。

## 云端构建与证据

[最终汇总报告 34830361115](https://github.com/fenghengzhi/krkr2-web/actions/runs/34830361115)已通过，生成 `out/verification/compiler-matrix.json`，绑定 495 份证据、36 条直接编译控制路径和 6 份视频呈现/像素附件。报告 SHA-256 为 `bd314e7bf7383553468685c6cea0db2d53998f265dd09b882d09733cdc7c55b9`。

当前生产 build 为 `2ee17c89ffae95f3c5e05f6f27245ffd5d31654531b3e11245e6c5f58be8f08b`；发布树为 32 个文件、5,639,839 字节，摘要 `3b404a984088ece14ed7c59ae6638e4fc827ecb9ca9c71f1c811f5e9083336c7`。可信冻结间隔为 21,053.2 ms，本阶段没有额外三次冻结或输入复测。

所有运行及产物按 ID 保存在 `out/verification/github-actions/`。工作区 `.generated` 和 `dist` 从通过的 34829312486 云端构建恢复；上一阶段的工作区产物保留在 `out/verification/compiler/prior-local-artifacts/`。本阶段没有在本地运行测试、构建或浏览器验证。

## 限制

8 ms 是检查期限，不是最坏响应延迟保证。内存分配、标准库字符串/映射/排序、部分原生复制、JavaScript 与 UTF-16 桥复制、字节码加载及对象销毁仍可能同步执行。宿主句柄为零不能证明 C++ 分配无泄漏；完整原生分配统计、恶意字节码校验、深递归和极端输入预算仍待完成。此项不代表完整非插件目标完成。

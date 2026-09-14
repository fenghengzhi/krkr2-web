# Debug 历史、文件输出与日志回调

原 KAG 的 `Initialize.tjs` 在处理 ConductorException 时调用 `Debug.logAsError()`，随后显示错误并恢复事件开关。此前缺少该方法，导致处理原始场景错误时再次抛错。本阶段补齐日志历史、文件输出和脚本日志观察回调，让这条原有异常处理路径能够完成并继续加载场景。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `engine/diagnostics/log.ts` | 带时间的历史、重要消息、文件开关、UTF-16LE 分批写入和输出故障处理 |
| `engine/diagnostics/service.ts` | 按绑定闭包身份注册回调、单次派发状态、失败移除与引用释放 |
| `engine/tvp/debug.ts` | TJS 参数转换、属性和同步回调循环；在可挂起的 TJS 栈内调用观察者 |
| `engine/storage/save-overlay.ts` | 按写入来源区分待提交的游戏数据与日志，保留版本和原子事务语义 |
| `engine/session.ts` | 脚本边界、文件读取、后台、导出和停止时的日志提交；保留主要异常 |

所有新增实现使用 TypeScript 和现有 TJS 桥。TJS WASM ABI **2**、字体 ABI **2** 与会话协议 **8** 均未改变，也没有新增原生运行时依赖。

## 脚本行为

`Debug.message/notice` 接受一个或多个参数，在 TJS 中转换成字符串后以 `, ` 连接；缺少消息报错。`notice` 同时保留重要记录，后来开启文件输出时会写入这些记录。

`getLastLog(lines=2148)` 返回带本地时刻和 CRLF 的历史，数量按 unsigned 32 位解释。只有省略参数才使用默认数量；显式 `void` 转换为 0。通常最多保留 2147 条，到 2148 条时删除最早的 100 条。时间使用独立的墙上时钟，不受暂停游戏时钟影响；测试可通过 `wallNow` 注入。

`startLogToFile(clear=false)` 首次开启时追加或清空文件，写入重要记录、分隔线与最近 100 条普通历史。已经开启时再次调用不清空。`logAsError()` 仅在 `logToFileOnError` 为真时开始输出，并采用 `clearLogFileOnError`；两个开关默认分别为 true、false。切换 `logLocation` 会重新打开输出位置，按照原生规则重新应用 `-forcelog=yes/clear` 和 `-logerror=no/clear`。

文件名为 `krkr.console.log`，默认目录是本项目的 `savedata/`。相对目录经 VFS 规范化；空值表示游戏根目录。归档内地址、URL 和越出游戏根的路径明确拒绝。新文件写入 UTF-16LE BOM，追加保留已有字节，行结束符为 CRLF。文件开启说明使用 ISO 时间；它不模拟 Windows 的区域化日期文本。

日志文件在脚本读取、写入其他文件、导出、后台提交以及脚本操作完成前进入 SaveOverlay。连续记录先保留片段，统一编码，避免每条消息都复制整份文件。文件可通过原有 Array 文本流读取，并随备份导出、导入和刷新恢复。历史本身按会话重建，不会把上次文件的内容自动变成新会话的 `getLastLog()`。

## 回调与异常

`addLoggingHandler/removeLoggingHandler` 使用对象和绑定上下文的完整身份；重复注册不增加调用，null 不参与派发。每个观察者收到 `HH:mm:ss message`。回调按注册顺序执行，移除的项跳过，在正在进行的派发中新增的项继续按顺序处理。

脚本 `Debug.message/notice` 先记录历史，再同步调用观察者，最后发出页面消息并追加文件。因此观察者里的嵌套消息先于外层消息进入输出；嵌套消息仍记录，但不再次通知观察者。观察者可挂起读取脚本或资源。不可调用的对象被移除并继续派发；观察者抛错时移除该项、终止当次派发并保留原异常。

未捕获的脚本异常在原 VM 调用退出后、取消会话之前通知观察者，之后提交日志。观察者再抛错或存档同时失败时，原始脚本错误仍是主要错误。浏览器来源的已接入诊断在下一次串行 VM 执行中通知当时的观察者，不在挂起的宿主调用中重新进入 WASM；停止后的浏览器诊断不会启动脚本回调。

## 写入失败与预算

游戏写入和日志写入共享实际文件覆盖层，但待提交数据保留来源。日志追加不能降低同一路径上尚未提交的游戏写入的重要性；新版本在旧版本提交期间写入时，也不会被旧提交清掉。导入备份属于明确的游戏数据写入。

包含游戏写入的事务失败，仍保留完整待写文件、报告失败，并允许导出和停止重试。只有日志的事务失败时，游戏继续运行，已形成的日志文件仍可导出；暂停该目录的继续输出，避免每次脚本调用都重复失败。停止时再尝试一次，仍失败也不会阻止停止。重新设置日志目录会重置文件输出的故障状态。

如果覆盖层已满，日志无法形成可提交文件，停止文件输出并提示，游戏文件保持可读、可导出和可停止；没有写出的日志片段不能视为已保存。文件达到自身预算时采取相同处理。重要历史和普通历史仍可在当前会话读取。

| 预算 | 行为 |
| --- | --- |
| 单条消息 256 Ki 个 UTF-16 单元，参数 4096 个 | 脚本消息超过限制时报错；引擎异常只截断日志副本并注明，原始异常不截断 |
| 普通历史 8 MiB | 在条数裁剪之外淘汰最旧记录 |
| 重要历史 4 MiB | 拒绝超限的新重要记录，不悄悄淘汰旧重要消息 |
| 单日志文件 16 MiB、待编码文件共 32 MiB、32 个文件 | 超限停止文件输出，并提示 |
| 4096 个有效观察者、派发期间 8192 个注册项 | 超限报错，避免不断新增回调造成无界增长 |
| 游戏覆盖层 64 MiB | 保持既有预算；日志不会扩大该预算或占满后阻止游戏导出 |

## 验证与范围

从原 KRKR2 `DebugIntf.cpp` 抽取历史、重要消息、开始输出和错误开关函数，在本机以 ASan/UBSan 编译并运行 **96** 组参考案例。Unicode 字符串、时间和文件接收端受控；参考覆盖实际原生算法，但不包含操作系统的文件打开说明、错误 UI 钩子或 TJS 回调。生产结果比较完整 UTF-16 历史、输出正文和观察消息的 SHA-256。

Node 验证参数转换、绑定上下文、回调重入/异常/挂起/停止、文件追加与清空、真实 64 MiB 满额覆盖层、独立日志提交故障和同路径游戏写入保护。三浏览器双后端检查文件导出、刷新追加、实际 IDB 连接关闭后的原始异常与回调；另检查关闭服务器和整个浏览器后的日志恢复。原 KAG 专项保留其异常处理脚本，触发真实 ConductorException，再加载恢复场景，检查导出的实际日志文件。

原生参考生成入口为 `tests/probes/debug-native.py`，输入为 `out/verification/debug/reference/krkr2-DebugIntf.cpp`；下载来源和实际源码哈希写入 `tests/fixtures/debug/native.json`。原 KAG 探测入口为 `tests/probes/debug-kag.ts`，需要本地参考 `kag3_template.xp3`。常规验证运行 `npm run check`，汇总入口为 `tests/probes/debug-matrix.mjs`；矩阵只接受全部必需报告和构建身份匹配的结果。

最终 `npm run check` 通过 **328 项行为/集成与 561 项浏览器测试**（444 常规、57 游戏库、53 PWA、7 原生生命周期），无失败、跳过或 flaky；本阶段新增 20 项 Node 和 24 项浏览器测试。最终构建另通过 **36 项原 KAG 场景、6 项 KAG 异常日志与恢复、6 项 TJS 跨 ABI 和 6 项字体跨 ABI 离线升级检查**。原生 trusted 冻结实测 **21,054.8 ms**，110 份持久 context 准备记录均保留独立的 30 秒 fixture 和 30 秒正文预算。

权威完整日志为 `out/verification/debug/check.log`；`out/verification/debug-matrix.json` 绑定源码、测试、文档、构建、原生参考和外部探测，`out/verification/debug/reverification.json` 记录再次校验的结果。Debug 的 Console/Controller 界面对象、完整 VM 控制台输出入口和所有原生异常/隐式析构路径仍需后续实现或差分；本阶段不表示完整非插件目标完成。

完整检查还揭示了既有 GPU 恢复测试的等待顺序问题：Worker 的 16 ms 绘制定时器可以在启动脚本让出时上传纹理，测试注入的 GPU 丢失因此可能先于最后的启动日志。旧测试在恢复 GPU 前等待该日志，形成互等。Firefox 与 WebKit 的三次失败 trace 已保留；修正后的测试先观察丢失、恢复 GPU，再等待脚本完成，并继续验证重建程序、重新上传、精确像素与交互状态。该场景三浏览器双后端各重复三次，共 18 次通过。

另一次 Firefox 游戏库测试已完成损坏块拒绝和缓存失效检查，但初始磁盘 profile 启动耗时约 9.4 秒，与正文共用 30 秒预算而超时。持久 context fixture 现有独立的 30 秒准备/清理预算，并记录每次准备耗时；正文仍为 30 秒，包括在正文中进行的再次冷启动。四套浏览器配置和断言超时均保持不变，失败 trace 和原 fixture 已保留。TJS 显式 `void` 数量参数与省略参数的区别也有独立失败与修复检查。

主机于 2026-09-14 09:29:46（+08）重启，中断了一轮尚未完成的检查；旧进程句柄和进程均已确认不存在。该轮重启前还记录了一次 WebKit 暂停后视频位置归零，原因未确认。重启后的 6 次原测试和 12 次带媒体事件/seek 记录的复测均通过，严格的位置断言未放宽；记录保存在 `out/verification/debug/host-restart/`。视频时序的完整边界仍属于后续工作。

依据：[KRKR2 Debug](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug.html)、[notice](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_notice.html)、[logAsError](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_logAsError.html)、[logLocation](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_logLocation.html)、[原 KRKR2 实现](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/utils/DebugIntf.cpp)、[KRKRZ 日志回调与 getLastLog](https://github.com/krkrz/krkrz/blob/master/utils/DebugIntf.cpp)。本地参考 fork 改动过回调时间前缀，本阶段采用原上游的带时刻消息。

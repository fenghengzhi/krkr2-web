# 074 — Web 帮助文档链路

## 2026-10-05 实施候选，尚待 Actions 验证

候选提交 `a0ec1b9d7abc11a9abf6b82a31889b5aa1ce5edc` 已触发 [37227951808](https://github.com/fenghengzhi/krkr2-web/actions/runs/37227951808)。只确认了运行创建及提交身份，未取回终态；所有下述新增验证定义仍不算通过。

已新增真正的 native `Storages.getLocalName`、`System.shellExecute`，并接通 Session/VFS、独立 MessagePort 和非模态只读帮助面板。会话协议由 22 升至 **23**，单独要求 **`nativeHelp:1`**；TJS ABI 5、`nativeSystem:2`、`nativeStorages:2`、`nativeTextStreams:2` 保持。以下描述源码候选，不代表构建、类型或运行通过；原计划和原有验证历史保留在后文。

`getLocalName` 采用专用 native 包装：检查参数数量后，丢弃结果的调用不转换参数、不访问宿主。使用结果时按现有 public path 规则做词法转换，空 `System.exePath` 明确映射 `game://./`；不查询存在性，不搜索 autoPath，不改变大小写。归档成员、越根、其他媒体和超长地址抛错。`System.exePath` 本身保持原空串约定。

`shellExecute` 始终先转换 target，再转换已提供的 execparam，包括调用方丢弃结果的情况。第二参数缺省为空；额外参数求值但不转发。native 保留整数返回值并拒绝非法宿主类型。Web 实现仅接受当前 VFS 中 `.txt`、`.md`、`.log`：复用现有 overlay、唯一大小写匹配、autoPath 和文本解码器，正文由实际资源读取。缺文件、非空执行参数、不支持地址或类型、归档成员及超预算返回 0；查找歧义、读取、解码和呈现错误保留异常。归档 autoPath 命中的实际归档地址同样拒绝。

预算为文件字节 4 MiB、解码后 1,048,576 个 UTF-16 code units、路径和标题各 4096 个 code units；读取前检查声明大小，读取后复查实际字节。文本预算在解码后检查，解码器自身的展开预算仍适用，不声称在解码前限制到 1 Mi 字符。只通过 `textContent` 呈现，保留换行，可滚动、选择和复制；不执行 HTML、外部链接或 OS 命令。

宿主同步安装可见 DOM 后才 ACK 成功，脚本随后继续，无需等待用户关闭。自定义宿主必须同步安装视图；异步 callback 返回的 thenable 明确拒绝，未提供宿主返回 0。请求带 generation 和递增 ID，重复文档替换旧视图，旧按钮监听器撤销；显示不主动抢游戏焦点，帮助中的键盘不触发游戏输入或菜单快捷键。隐藏、失联、inert 宿主或已有浏览器模态对话框导致呈现异常。暂停保留阅读面板；Stop 先移除面板并禁止后续 ACK，再由取消 RPC 解除 Worker 等待，最后关闭端口，避免 Stop 前的错误 ACK 恢复脚本 catch。读、解码、ACK 的晚到结果不能恢复已取消会话。

已增加 native 源码/字节码、Session/VFS、真实 MessageChannel 故障与生命周期、浏览器 DOM/Stop/能力拒绝及原 KAG Help Index 的验收定义。原 KAG 探针从固定 XP3 启动，启用隐藏菜单并点击原委托，保留文件、正文、截图、trace 和精确构建身份。兼容工作流改为同时支持 `workflow_call`，由完整 Tests 在 build 成功后调用、下载当前 run 的 `test-build`；最终 All tests 同时要求兼容矩阵成功。旧手动 `build-run` 仍保留，诊断模式不冒充完整回归。当前库存不是通过数。

帮助面板在普通播放时进入页面布局，避免覆盖调试和 Stop 控件；全屏窗口存在时改为位于其上方的固定面板，保留顶部退出全屏按钮。呈现会滚入可视区但不夺取键盘焦点。新增浏览器断言通过真实菜单进入全屏、检查关闭按钮中心的 `elementFromPoint`，退出后检查恢复普通布局；这些实际可达性断言仍待 Actions。

原版依据字节已归档于 `out/verification/web-help/source/`，版本仍为下文固定 commit；`SystemImpl.cpp` 为 25,253 bytes，SHA-256 `93a72b4cc904e46f7d600ab946c6be8cdde8ebc117f4a5a3d13315d8387a83a0`；`StorageImpl.cpp` 为 34,192 bytes，SHA-256 `e9f4063a5e96257a962255cb0dc8a3983d782c8ddb550e1d4a0c59bb11dfc942`。这只是来源归档，没有在本机执行 Windows 程序。

## 原始实施计划（历史记录）

状态：**计划，未实现，未验证**。本文件记录下一实施切片的已知调用链、合同差异和验收要求；没有增加 `Storages.getLocalName`、`System.shellExecute` 或帮助查看器。源码静态阅读、原始 KAG 文件阅读不代表执行通过。本批 073 的实际写入路径绑定与本计划是不同切片。

## 固定来源与真实调用链

原版依据固定为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788`，路径前缀为 `kirikiri2/branches/2.32stable/kirikiri2/src/core/base/`：

- [win32/StorageImpl.cpp:1227](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/StorageImpl.cpp#L1227)：`getLocalName` native static 包装、参数数量和结果使用规则。
- [win32/SystemImpl.cpp:663](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L663)：`shellExecute` native static 包装、参数转换和整数返回值。
- [win32/SystemImpl.cpp:173–215](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L173)：调用 Windows ShellExecute，依据调用返回结果报告是否成功；没有等待用户关闭目标程序的逻辑。

以上是固定源代码依据，没有在本机或本切片运行原版 Windows 程序。实施时应将实际使用的原始来源字节、版本和哈希纳入证据归档，不能把网页阅读称为完整来源归档。邻接 `kirikiroid2-web` 仓库中的 `TVPShellExecute` 已被改为恒真 stub，不能用来证明文档真实打开或作为成功返回值的 oracle。

KAG 来源为仓库现有固定 `tests/fixtures/compatibility/kag3_template.xp3`，SHA-256 为 `5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644`。可读配对 ZIP 的 SHA-256 为 `bc14c13281aa9d00e714e6b9d1053d8d0cbde639cf6b7c84d7715551baea00de`；两者的配对清单和逐文件哈希见 `tests/fixtures/compatibility/kag3_template.zip.json`。本计划沿用清单中记录的身份，不把清单阅读表述为本轮重新计算哈希。

ZIP 中的实际源码位置：

- `system/MainWindow.tjs:867–870`：`onHelpIndexMenuItemClick(sender)` 调用 `System.shellExecute(Storages.getLocalName(System.exePath) + helpFile)`。
- `system/Config.tjs:267–269`：帮助文件应在可执行文件所在目录，默认 `helpFile = "readme.txt"`。
- `system/Menus.tjs:129–134`：Help 菜单的 Index 项绑定上述原方法。
- `system/Config.tjs:371–372`：帮助索引菜单默认隐藏。因此已有 KAG 启动或存读档通过，不能证明帮助链可用。

`system/MainWindow.tjs` 的清单哈希为 `8f850acfd1c87b77bb37c792e9f80630f4a15f9c5bd0d9aafce5ce59cfedcea7`。验收应使用固定原始 XP3 中的方法及菜单委托，不替换成自行重写的等价函数。

## Native 包装边界

`getLocalName` 至少需要一个参数。原版先检查数量，仅在结果被使用时才进行第一个参数的 TJS 字符串转换、路径规范化和本地名字转换；丢弃结果时不发生这些转换。额外参数仍由 TJS 正常求值，但包装不读取它们。

当前 `native/tjs2/bridge.cpp` 的通用 `StorageMethod` 为已有九个路径方法先转换第一个参数，再判断是否丢弃返回值。新增 `getLocalName` 不能只加入同一个策略表而沿用这一转换顺序；需要有明确策略或专用 native 包装，并保留真实 native Function、static、receiver、参数数量、异常及源码/字节码语义。

`shellExecute` 至少需要一个参数；原版始终依次转换 target、已提供的 execparam，即便调用方丢弃结果也执行。第二参数未提供时为空，额外参数只求值、不转换或转发。结果为整数成功值。Web 不应把未显示的文档、排入队列但尚未接收的请求、缺文件或不支持的目标一律报告成功；读取、显示及清理错误也不能被恒真返回吞掉。

## 待定的 Web 路径约定

当前 `src/engine/system/environment.ts` 的 `System.exePath` 是空字符串，表示现有游戏虚拟根前缀；公开存储名字则使用 `game://./`。`getFullStoragePath("")` 仍返回空字符串。帮助链实施前必须确定并记录下列选择的兼容影响：保留空串根约定并让 `getLocalName` 明确处理，或调整 `exePath` 为公开根并核对既有拼接调用。此处不预先宣布其中一种已成为合同。

`getLocalName` 的 Web 返回值应是当前游戏空间可用的地址表示，不能伪装成真实 OS 文件路径。它不应隐式采用 autoPath 搜索，不应通过读取文件来制造地址转换的成功，也不能假设路径必须已存在。归档成员没有原版可直接交给 OS 的本地路径；最小方案应明确拒绝这类转换，而非暗中解包、创建临时宿主文件或声称与 Windows 等价。大小写、尾部分隔符、根边界和不支持媒体的策略需与现有公共路径规范一致。

## 最小只读文本方案

首个实现范围限定为游戏 VFS 中的只读文本帮助。资源解析复用现有 overlay/挂载资源规则和文本解码器；文档只以文本显示，保留换行、可滚动和可选择复制。具体支持的后缀、文件/文本预算以及拒绝行为应在实现决策中固定，并由验收覆盖。

`shellExecute` 的可用方案应在文档已被宿主接受并真实呈现后返回，且不要求用户关闭文档才让调用脚本继续。异步跨 Worker 确认属于呈现过程，不意味着等待用户阅读结束。帮助视图需要自己的可追踪请求和会话身份，关闭及 Stop 时释放状态；旧请求不能影响新会话，重复调用的替换或并存策略也必须明确。

现有 System dialog 是模态调用，复用它并等待“确定”会改变上述返回时机。不能因为已有对话框易于接入，就静默将它认作原 shell 行为。具体宿主视图可复用现有文本渲染、焦点及生命周期代码，但本计划不引入第二套事件泵或假同步轮询。

本切片不涵盖 OS shell、Windows 驱动器/UNC 路径、任意程序执行、插件加载、外部网络浏览或 HTML 脚本执行。非空执行参数、不支持的目标类型、缺失资源及呈现失败必须有明确结果或错误；不能靠无条件成功绕过 KAG 调用。

## 后续整批 Actions 验收要求

所有测试、构建、类型检查、Playwright 和 native/VM/browser 探针只能在 GitHub-hosted Actions 运行。按较大批次执行，不实时监控；下次批次前取回上次结果。取消、失败及未报告保持原身份，以下是待定义/待运行清单，不是通过数量。

- 真实 VM 源码和编译字节码：native 身份与 static/receiver 规则、缺参数、额外参数求值、`getLocalName` 丢弃结果时不转换、`shellExecute` 丢弃结果仍执行、两个参数转换顺序以及转换失败。
- Session/VFS：根前缀拼接、Unicode 和分隔符、大小写唯一匹配与歧义、overlay 实际内容、归档地址策略、非法媒体/越根、缺文件、不支持目标/参数及文本预算。
- 实际 Worker/DOM：正文来自真实文件，换行和特殊字符按文本呈现；文档仍打开时脚本已继续；关闭、重复调用、暂停及 Stop、呈现失败和新会话隔离。不以宿主收到请求替代正文可见断言，也不通过预先改写返回值制造成功。
- 原始 KAG：导入固定 XP3 及独立帮助文件，启用原有隐藏 Help Index 菜单，通过真实菜单点击执行原 `onHelpIndexMenuItemClick`；观察正确正文和继续执行状态，随后关闭/Stop 并检查新会话。保留未修改 XP3、帮助输入、构建 manifest、逐阶段截图/报告和失败材料，覆盖当前兼容矩阵的三浏览器、Asyncify/JSPI 两后端。

真实 KAG 帮助验收是现有兼容矩阵的新增覆盖，不能从旧版 84 场景或同构建存读档结果推断通过。本计划本身没有改变能力版本、协议、测试库存或验证结论。

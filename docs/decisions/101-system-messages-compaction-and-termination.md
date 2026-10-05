# 101 System 消息、内存整理与退出语义

状态：开发候选，尚待 GitHub-hosted Actions 执行。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，未完成。本轮从干净的 `585ddbd` 继续。会话协议 **40**、`nativeSystem:4`，TJS ABI **5**、字体 ABI **2**。

本地仅源码检查、编辑、Git 操作和历史原件的下载、解包、哈希核对与解析。所有构建、测试、浏览器及可执行参考探针仅在 GitHub-hosted runners 执行。整批推送后，下轮取回固定结果，不实时监控。

## 本轮固定证据

098／`37335381893`、099／`37340665748`、100／`37344510171` 的 run、jobs、artifacts 各查询一次并冻结。**44 份原 ZIP、611,968,120 字节**全部匹配 API SHA-256 和大小；其中 25 份旧包重新核对、19 份新包。总表为 `out/verification/github-actions/101-archive-summary.json`，旧快照、原日志和失败保持原样。

098 终态 **completed／failure**，29 jobs 为 19 success、7 failure、3 cancelled。完整 Node 为 **3,293 = 3,287 pass + 6 failure**；六项修订已在 100 提交，但本次还没有 100 的验证结果。主浏览器计划 **2,487 = 2,210 pass + 191 failure + 86 未报告**，后者包括 Firefox shard 2 的 74 项与 WebKit shard 2 的 12 项。Chromium library 被取消且只有元数据，没有可核对的测试库存，单独保留未报告，不并入主浏览器分母。直接 runtime **6/6**、原 KAG **96/96**、可信 Chromium 生命周期 **11/11** 已报告通过。

099 终态 **completed／failure**，16 jobs 为 6 success、4 failure、6 skipped。构建在 `src/player/drop-files.ts:171–172` 出现两处 TS18046：异步结果推导为 unknown。本批显式指定 `wait<HandleOutcome>`；此源码修订不是构建通过。Node、浏览器、runtime、兼容性等下游未执行。两个独立 Windows 光标参考仍是 183 样本，strict 各 **536/596 matched、60 failure、3,178 uncompared**；mask 各 **3,770/3,770**。

100 固定快照仍 **in_progress**，9 jobs 为 6 success、3 running。构建未发布日志／结果，Node 和浏览器尚无报告；两个光标作业仍运行，Windows 2022 的 strict 步骤已记录失败，但 **323 样本原 ZIP 尚未发布**。不能从该步骤状态推导具体像素差异。下轮补取，不刷新本轮快照。

## 原生消息替换

固定 2.32stable `SystemIntf.cpp:257–272` 要求至少两参数，按 ID、消息的顺序执行 native `ttstr` 转换，并在调用方丢弃返回值时仍执行 `TJSAssignMessage`。候选直接注册 native 方法，保留原生转换、已注册 holder 的区分大小写查找、未知 ID 返回 0，以及整数布尔返回值。

测试修改真实的缺失成员异常、编译警告与语法错误模板，覆盖 source／bytecode、Unicode、精确大整数、void、复制持有、无效 octet、额外参数求值和借用接收者。缺失成员夹具使用普通 Object；Dictionary 的缺失属性按 TJS 合同返回 void，不能用来证明异常消息替换。另覆盖并存 Session 和 Stop 后新 Session，避免静态消息表跨游戏泄漏。

这里只接受当前内核实际注册的 holder。Web TypeScript 引擎错误尚未全部接入原版 TVP 消息库存，不能为缺失 ID 人造成功返回值。证据和范围在 `out/verification/system-messages/101-audit.md` 及 `101-source/manifest.json`。

## 显式内存整理

`System.doCompact` 的缺省／void 等级为 100，使用原生有符号 `tjs_int` 转换。等级至少 5 时在当前 TJS 调用栈调用内核垃圾整理，避免从挂起的 host import 再进入外部 collect 导出。至少 10 时清理合成缓存和 AutoPath 搜索缓存；至少 15 时释放源图像缓存、可回收的文件字体 face 和文本临时画布。

原生 `DoGarbageCollection` 的字符串池整理有效，但当前 vendored 内核的 `TJSVariantArrayStackCompactNow` 原有实现为空；本批未补变量寄存器栈池的即时回收。不能把调用了 GC 入口写成全部原生内存整理都已完成，这项仍在后续范围。

尚在解码的图像保留队列容量和共享读者，旧 epoch 的结果可供当前读者完成，但不能重新填满刚清理的缓存。字体栅格化期间使用的 face 保持存活，当前操作结束后再释放；尚在载入的旧 epoch face 也不保留为缓存。显式预渲染映射、命名字体目录、活动 Layer 像素、媒体和其他活动对象不被销毁。

普通整理监听器异常记录后继续，包括 native GC 失败和延后释放 face 的失败；后者不能覆盖原栅格操作的成功结果。取消和执行预算异常继续传播。源码合同、原件哈希与这些边界在 `out/verification/system-compact/101-audit.md`。

固定原版归档索引 LRU 的清理属于退出路径，未注册 compact hook；候选保留它。当前实现没有独立 XP3 解压段缓存或共享 KAG 场景缓存，不增加虚假清理动作。自动 idle／deactivate／minimize 整理还需单独对齐宿主生命周期，未纳入本批显式 API。

## 异步终止与同步退出

固定 `SystemIntf.cpp:104–120` 的两方法均不读取参数。`terminate` 调用异步 Application.Terminate 并返回；`exit` 进入同步退出且不返回。候选独立保存 terminate 请求，让当前脚本及同轮事件尾部继续，在当前序列化操作结束后停止并完成持久化；正常资源 I/O 的挂起不被当作应用消息循环边界。固定 EventIntf 的当前事件轮及窗口更新仍会执行，因此保留必要清理与同轮 onPaint，不把 terminate 错当成即时取消。

模态等待对 pending terminate 使用普通取消结果，按当前模态层次展开，让脚本有机会继续；exit 仍直接取消 VM。此处旧 VCL／Win32 的具体退出顺序需要原版二进制观察，不能仅凭源码推断称为已验证。因此增加独立托管参考工作流，以固定 SDK 的八个有界独立进程场景记录普通脚本、Timer、窗口模态、对话框和菜单退出，分别在 Windows 2022／2025 执行。超时、非零退出或脚本错误保持失败，原始顺序不按候选预期改写。

即时 exit 的 Stop 负责唯一一次持久化提交，执行尾部不再先尝试相同写入，避免失败后自动重试掩盖错误。terminate 后发生的脚本／保存错误清除 pending 请求并保留失败，待用户显式 Stop 重试；待写字节仍可导出。完整源合同与 Web 会话边界在 `out/verification/system-termination/101-audit.md`。

## 历史夹具与剩余范围

本批新增 **34 个 Node、每浏览器 12 个定义**：消息 8／4，显式整理 12／4，退出 14／4；旧能力门禁增加 nativeSystem 3 拒绝场景，恢复时使用版本 4。原版退出参考另有八场景 × 两个 Windows 环境，共 16 次独立进程观察。这些数字是计划执行库存，不是通过数量。

098 Firefox 的两个 System 菜单用例在真实点击 80×1 画布时被外层 section 拦截。本批给夹具加入真实主图层，并为实际菜单留下可点击视口；保留全部快捷键、事件禁用、可见性和 popup 断言。它不是通过记录，也不放宽输入行为。

100 及本批候选均仍待托管结果。完整目标还包括 `exitOnNoWindowStartup` 的原版 MainForm 条件与 Web 映射、自动内存整理、完整 TVP 消息库存、视频流选择／更多媒体格式、严格光标与图形差分、字体兼容、历史堆故障、Firefox 媒体截图阻塞、真实 OS 拖放及更多真实游戏兼容。完成本批不等于完成模拟器。

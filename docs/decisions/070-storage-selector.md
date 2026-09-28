# 070 — 游戏虚拟文件选择器

状态：实现候选，尚未运行本切片的 GitHub Actions。本文不把静态审查、用例定义或之前其他构建的结果称为本切片通过。TJS ABI 保持 **5**，`nativeStorages` 升为 **2**，会话协议为 **21**。其他原生能力沿用 069。

## 原生包装合同

以 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [FileSelector.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/FileSelector.cpp) 和 [StorageImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/StorageImpl.cpp) 为固定来源。原始 CP932 字节、官方手册、Microsoft OPENFILENAMEA 文档、当前原始 KAG fixture 和逐文件 SHA-256 保存在工作区忽略产物 `out/verification/select-file/reference/manifest.json`；详细来源审计为 `out/verification/select-file/contract.md`。本次没有原版 Windows 文件对话框的执行观测。

`Storages.selectFile(params)` 是真实 native static method。调用方丢弃返回值时仍然执行；至少需要一个 object 参数，不限定 Dictionary，额外参数只由 TJS 求值而不读取。使用 object closure 的 Object 本身作为 options/filter getter 和 setter 的 `objthis`。

读取顺序固定为 `filter → filterIndex → name → initialDir → title → save → defaultExt`。每项在读取成功后立即由原 VM 转换，不能先读完所有 getter 再处理：尤其非空 name/initialDir 分别立即规范化路径，路径异常发生在后续 getter 之前。filter object 先读一次 count 并转 32 位整数，再顺序 `PropGetByNum`；负 count 不访问元素。负 HRESULT 使用缺省或跳过该元素，真正 getter/转换异常传播。只读取这七项，不探测未知选项或 setter。

filterIndex 使用 TJS 32 位整数再转 uint32，save 使用 TJS bool 转换。过滤字符串按第一个 `|` 分为标签和模式，没有分隔符时两者相同。选项对象和 getter 保持在正常可挂起 native 栈中；宿主收到的仅是复制后的字符串、整数和 void。成功选择的 continuation 返回后，先 `PropSet(MEMBERENSURE,"filterIndex")`，再写 `name`，最后返回整数 1。两个 setter 的失败 HRESULT 均忽略；真正异常传播，第二项异常不回滚第一项。取消返回整数 0，不回写任何字段。

Web 安全边界：拒绝 null options/filter object，最多 256 个 filter 元素、256 Ki UTF-16 输入总量，path/title/defaultExt 单项最多 4096 UTF-16 单元。超限抛错，不重现原版空指针或未限额分配风险。Unicode 文本保持完整，不伪装原版 ACP/MAX_PATH 字节截断。

## 虚拟目录与真实文件

选择器浏览当前游戏挂载资源与浏览器存档 overlay，返回所有现有读取 API 已接受的 `game://./...` 公共名字。列表通过 `StorageResolver.list()` 与新增 `SaveOverlay.list()` 取名称和大小，不导出或复制存档内容。overlay 与同名挂载资源重叠时显示 overlay 元数据。目录与文件合计最多 2 Mi UTF-16 名称数据，文件和目录各最多 10000 项；超限明确拒绝打开，不把截断目录伪装成完整清单。

虚拟目录由根、现有资源/存档的父目录以及当前配置的 `System.dataPath` 及其父目录组成。空存档库的默认 `savedata/` 或自定义 dataPath 可以首次保存；任意其他不存在目录不会因为 initialDir 输入而创建。初始位置采用 name 的已存在父目录、initialDir 的已存在目录、游戏根的确定顺序。没有 OS 最近目录状态。

打开必须选择当前存在的文件。可浏览真实已挂载的 archive 成员，并明确标记只读，返回 `game://./archive.xp3>member`；这是 Web 扩展，原 Win32 对话框不能浏览 XP3 内部。保存不提供 archive 目录，也拒绝直接提交 archive 名字。保存选择只返回可写 overlay 名字，不创建空文件、不下载、不写 OS 文件；后续游戏脚本负责执行真正保存。

确认时 Worker 再次检查路径、目录、实际存在性及 resolver 的 exact/case-folded 歧义规则，不用自动搜索路径偷偷选另一个目录。保存到既有 overlay **或会被 overlay 遮盖的挂载资源** 都必须显式确认覆盖。若 Timer 在打开选择器后新建同名文件，第一次提交保留原对话框并显示覆盖确认，用户再次点击才提交。确认不锁定随后脚本写入之间的命名空间；保存是否真正成功由后续写入 API 决定。

## Web 文件名与过滤规则

文件列表支持分号分隔的 `*`/`?` 模式、大小写不敏感匹配；`*.*` 显示所有文件，包括无扩展名。过滤模式内分号两侧空白被去除，这是明确的 Web UI 策略。过滤只决定列表显示，手工输入的其他扩展名不因此被拒绝。

每次列表过滤共享 200 万操作预算，模式只编译一次。超限保留目录并明确提示缩短模式或直接输入名字，不把未完成的部分匹配显示为完整结果。

有 filter 时 index 为 1 起算，缺省 0 或越界输入选择第一项；无 filter 和显式空 filter 列表统一显示全部文件、返回 index 0。这些 OS 校正细节尚未做固定 Windows 二进制校准。defaultExt 缺省为空；文件名无扩展时附加完整 defaultExt，末尾点被去掉并抑制附加。与 Microsoft 文档描述的 Win32 三字符附加规则及各版 OS 联动行为不声称等价。拒绝含路径分隔符、archive 分隔符或 NUL 的扩展名。

文件名输入、目录、过滤、覆盖确认、取消、IME、错误反馈和停止游戏均使用真实 DOM 控件。界面显示的是打开时的元数据快照，最终存在性以确认时 Worker 重验为准。

## 同一模态栈与终止

文件选择器扩展现有 `SystemDialogs` 请求 union，复用原 `selectSystemDialog` RPC、同一个 ModalLoop、原 TJS continuation 和窗口输入阻塞，没有另一套事件泵或假同步轮询。嵌套 System dialog、Window modal、Pad host scope 继续遵守同一栈顺序；非顶层、重复、旧请求、暂停状态的响应不能恢复脚本。原始对象由 native 栈拥有，宿主记录只保留普通数据；Stop 通过已有 ExecutionControl 和 VM silent exception 展开栈，在 VM disposal 前 drain，旧 DOM/RPC 不能回写新会话。

静态审查进一步发现：宿主开 scope 后，native continuation 的 frame-depth 检查仍可能在 `__krkrModalPump` 函数体之前抛错，不能依赖 pump 内的 `Modal.end` 清理。现由 VM 在七项 getter 全部结束后分配单调调用身份，native 保护完整 `dispatch_host → resolveReply` 区间，并用该身份对该请求执行一次精确 abort；正常结果同样幂等清理后才解析结果和写回。不根据当前 top 猜测目标，不清空其他请求。尚有子 scope 时先标记 abandoned，子 scope 依正常 LIFO 顺序结束后，只回收已标记的父请求。

abort 回复只允许普通 void，不可再执行 TJS continuation 或申请函数/delegation frame。native 使用既有 primary exception / CleanupErrors 策略保持原异常，同步 abort 的清理错误另经宿主 error 日志记录，不留到后续无关脚本才重抛。若清理因活跃 TJS 子 scope 延后，其发布错误属于该子 scope 后续 `Modal.end` 的当前错误；资源仍先移除。Stop 不以清理错误替换 silent cancellation。

Runtime 仅对固定 `Storages.selectFileAbort` 且恰好一个正安全整数原语的调用提供窄清理入口，先执行纯宿主撤销，再等待既有 pause/control 返回约束。它不 pin 对象、不触发 TJS 转换、不检查并消耗 ownerFailure，也不 flush 文件，避免已有写失败或 owner 清理错误在真正撤销之前再次阻挡 abort。其他 opcode 的执行顺序不变；既有 pending 写入和 ownerFailure 留给同一次执行原有收尾边界处理，失败写入仍保留以供显式重试，不丢弃或假称提交成功。

保留一个既有通用 runtime 边界：`run()` 消费 native reply 后在 `finally` 中 flush；如果 native ScriptError 未被 TJS 捕获，同时尾部写入失败，JS 调用可见的异常会被后者替换。070 只修 selector 撤销入口，不改变全局 `run()` 双错误语义。新增夹具由 TJS 普通变量记录 selector 原异常，再断言同一次 execute 收尾报告真实 write/owner 错误，不能据此声称未捕获的两个异常已经聚合。后续 writer/队列错误统一处理还需保持 `System.exceptionHandler` 对 ScriptError 类型的约定，不能简单换成 AggregateError。该已知问题另存于工作区 `out/verification/text-writer-modes/070-runtime-cleanup-boundary.md`，不计作本切片已修。

原 FileSelector.cpp 在 getter 前获取全屏窗口/Application 的 Win32 owner；Web 在实际打开 DOM 对话框时记录当前焦点，使用页面 top layer。这是宿主适配，不宣称 OS owner 时机一致。文件选择器不继承 Window.showModal 的全屏拒绝，也不清空 Window 事件队列、不设置 System.eventDisabled；现有捕获释放和 DOM 阻塞仍用于防止背景输入。Timer、重绘、暂停及 eventDisabled 使用已有调度策略，其节拍不是本次原版实机校准结果。

## 待 Actions 的验收

新增定义的静态库存如下，实际发现和通过数量只能由后续 Actions 报告确定：

| 范围                |                                             静态库存 | 覆盖                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| native conformance  |                           13 模板 × 源码/字节码 = 26 | 原生入口、转换/访问顺序、getter/负 HRESULT、receiver、continuation、取消、部分写回、预算、精确身份及 cleanup/primary 错误                                            |
| Session integration |                           19 模板 × 源码/字节码 = 38 | 实际资源/overlay/归档读取、空库自定义 dataPath 首存、目录/大小写/覆盖、嵌套 getter/setter、Timer、Window 输入、暂停、eventDisabled、Stop、128 函数帧入口拒绝与所有权 |
| 共享模态清理        |                                                    4 | 精确 abort、保留外层、TJS/host 子帧 LIFO、失败清理、发布重入                                                                                                         |
| 窄 Runtime 清理入口 |                            5 模板 × 源码/字节码 = 10 | 真实 VM 与共享模态 scope、8 字节排队写故障、真实 owner 观察错误、非法 ID、不 pin 对象、暂停恢复和 Stop                                                               |
| 浏览器 Worker/DOM   | 4 模板 × Asyncify/JSPI × 源码/字节码 × 3 浏览器 = 48 | Dictionary 实际存读、筛选与覆盖、默认扩展和尾点、取消不回写、Timer、归档、Stop 与旧控件隔离                                                                          |
| 原始 KAG XP3        |                                2 后端 × 3 浏览器 = 6 | 首次自选存档、同会话读取、停止/文档 reload 后真实持久读取                                                                                                            |

普通 Node 总库存新增 78，普通三浏览器新增 48；原兼容矩阵 78 加原始 KAG 六场景，预期 84。没有为旧失败重写历史通过数量，也没有把以上未运行定义计为通过。

非法 object 身份不经过 `readValue`/pin 的结论来自该窄分支源码审查；回归中的成员读取次数和最终 handles 数分别验证未读成员、没有遗留句柄，不冒充瞬时 pin 计数观测。

128 帧回归只读取现有 VM 计数，递归上限为 128，必须联合观察已发布的请求、真实 invoke token、该 token 从未进入 `Modal.wait`、明确函数深度错误、立即清空 scope 和随后新请求成功。它不使用历史分配故障、巨大递归或原 SDK 危险探针。源码和字节码分别定义，尚未执行。

原始 KAG 验收直接调用固定 XP3 中的 `saveBookMarkToFileWithAsk` / `loadBookMarkFromFileWithAsk`，首次 SaveAs 前不预建目标存档，通过真实文件选择确认后保存、同会话打开、停止和重新载入后再次打开并恢复场景变量。保留原始备份字节、阶段截图、Worker/RPC 观察、构建 manifest 和失败记录；确认选中路径不替代持久内容及恢复状态的断言。

这不实现 `searchCD`、`getLocalName`、OS shell、任意硬盘浏览或插件加载，不把本切片完成当作非插件全目标完成。

静态审查曾发现并修正两项路径问题：文件目标恰为现有隐式目录时必须拒绝（包括尾点与大小写）；完整文件名唯一匹配时，不能因两个不同目录的大小写前缀相同而提前误拒。两者保留专门 Session 断言，待远端执行确认。

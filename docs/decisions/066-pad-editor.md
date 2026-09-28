# 066：原生 Pad 与独立 Web 文本编辑窗口

状态：实现与托管测试定义已编写，尚未取得本批 Web 验证结果。所有测试、构建、类型检查、浏览器与原版程序仅在 GitHub-hosted Actions 执行；本文不把定义数或静态审查计为 PASS。

## 固定参考与实际观察

源码参考为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable `PadIntf.cpp`、`PadImpl.cpp`、`PadFormUnit.cpp/.dfm`。本地完整研究合同及固定原文位于主工作树 `out/verification/pad/contract.md`。

[原版 SDK Actions 36443214234](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443214234) 在提交 `b4ed428bbb45dc2bbfe55818ab7a65eb8cf7e69b`、Windows 2022/2025 各记录 122 个小用例：各 120 returned、2 error，共 244 条。两个错误是刻意抛出的 finalize 与成功失效后的读取；保留 error 身份，不改记通过。参考可执行文件版本 2.32.2.426，SHA-256 `b1e9b84905f29489d2a9caba0c45e125c971b19f71156b0cf3f506835c18e19d`。这不证明发行包恰由上述源码/VCL revision 构建，也不是 Web 测试证据。完整 raw/manifest/hash/UTF-16 记录在 `out/verification/github-actions/36443214234/`。

本次采用以下已观察语义：

- 默认背景与 `fontColor` getter 都为 128，独立实际字色由 DFM 指定白色；字体 getter 错误读取背景，字体 setter 仍改变真正前景色。
- 文本仅给非 CR 后的 LF 补 CR。CRLF、孤立 CR、尾 CR 原样保留，不自动追加末尾换行。SDK 中 NUL 标签用例的实际输入已是 `ab`，没有测到 Pad 接受 NUL；不得把它列为嵌入 NUL 的观测证据。
- `fontHeight=12/-12/13/14/0` 对应 `(12,9)/(12,9)/(13,10)/(14,11)/(0,0)`；`fontSize=9/-9/10/11/0` 对应 `(12,9)/(12,9)/(13,10)/(15,11)/(0,0)`。采用固定 96 CSS dpi 的整数舍入耦合；这些有限样本不证明所有整数。
- `opacity=-1/0/128/255/256` 均读回 255，默认恒 255、写入无视觉效果。源码另有 AlphaBlend 分支，不将其行为冒充固定发行包观察。
- 脚本设置 60×90，getter 实际返回 60×90；不根据 DFM 最小值强行改成 70×100。用户拖动缩放使用 DFM 的 70×100 交互约束，普通移动与最大化还原不扩大脚本小尺寸。
- bool 非零小数为真；四个字体 style 先 I32 截断，小数 ±0.5 为假。`fileName` 不读取正文、不改变标题；直接 finalize 不删除编辑器；finalizer 抛出后仍有效，可替换回调后重试。

## 实现边界

`native/tjs2/bridge.cpp` 注册真正 `tTJSNativeClass`、原生构造器和 24 个 `tTJSNativeClassProperty`。接收者的 native slot/VM 身份校验与 `ttstr`、有符号 I32、TJS bool 转换发生在原生侧；不能凭借 `__padId` 字段冒充 Pad。类闭包按原版采用未绑定形式，支持普通派生构造器的 `super.Pad()`。构造余参忽略；一实例重复构造明确拒绝，避免复制旧 Form 泄漏路径。

`engine/scene/pads.ts` 持有纯值状态与非拥有型 weak token，native 实例仅存数字 id。HostLifetime 在用户 finalize 成功后退休资源；弱观察在真实终端析构时兜底；显式 invalidate 的用户 finalize 抛出不会提前删除状态。Stop 独立撤销全部 UI、保存和 font/clipboard 晚结果。Pad 不加入游戏 Window roster，不占 mainWindow、不创建 Layer/Canvas、不触发 `exitOnWindowClose`。

`protocol/pad.ts` 的 generation/id/epoch/seq/baseTextEpoch 控制宿主消息资格；脚本正文替换提升 textEpoch。DOM 同 epoch 未确认编辑不会被旧 snapshot 覆盖，跨通道旧 ACK 不改变最新 presentation 的 blocked 资格。隐藏、失效、Stop 撤销旧编辑/合成/保存；selection 使用 textarea LF/UTF-16 偏移，不反写状态栏 `statusText`。协议版本 18，内核能力 `nativePad:1`，ABI 仍为 5；生产 manifest 与直接 native factory 都拒绝缺少能力的内核。

`app/game-pads.ts` 实现独立 textarea、完整字体/颜色/状态/窗口属性、拖动/缩放/最大化、隐藏保留、只读、Tab、选择、IME 代际、撤销/重做、真实 Clipboard 菜单和下载。事件监听归属控件，不增第二套全局 keydown 捕获。Pad 键盘走既有宿主目标与 host-key tail 隔离，不能进入游戏 trapKey 或共享游戏按键状态。空选区 Copy/Cut 不调用系统剪贴板；异步 Cut/Paste 结果只有原编辑器仍拥有焦点且选区未变时才修改文本，不能夺回后来选择的焦点。

公开 `PlayerOptions.pads?: PadHost` 实际接入 SessionClient 的消息、字体、事件与 Stop；`createGamePads(stage)` 是应用使用的适配器，也可供嵌入方选用。`PadHost.flush()` 等待已观察编辑的 ACK。匹配游戏字体时复用同一 FontCatalog，按 face/style 选资源，最多 16 MiB，经代际核验送到页面真实 FontFace。页面会话字体输入总预算 64 MiB，RPC 先预留 16 MiB，返回后改按实际字节记账；剩余不足预留量时可能保守拒绝较小文件。目录发现是纯宿主工作，用户暂停不阻塞 Pad 字体加载，原 TJS 字体调用者仍在继续前等待 control。换字/隐藏/Stop 取消迟到加载并撤销注册。不存在已安装 Windows 字体的虚假承诺。

## 保存、暂停与共享模态所有权

原研究建议为保存创建私有 TJS trampoline。实现时发现它会要求被暂停的 VM 恢复才能保存，也会受 `System.eventDisabled` 影响。Pad 保存由宿主发起，没有等待返回值的 TJS 调用者，因此最终采用共享 ModalLoop 的窄 host-owned scope，删除该 trampoline 和试验性的 auxiliary 事件轮；不增加第二事件泵，不更改普通 SystemEvents 分派行为。

保存按钮或 Pad 内 Ctrl/Meta+S 先 flush 编辑，纯值 RPC 固定正文/revision/文件名快照，再 `openHost(kind='pad-save')`。共享 scope 同样发布游戏/Pad 阻塞与输入 generation；用户暂停和 eventDisabled 时宿主编辑/保存仍可执行，不进入用户 TJS、exceptionHandler、continuous 或游戏绘制回调。长脚本在可处理 Worker 消息的异步 host wait 时也不阻挡保存。

集成静态审查还发现：原 Layer 自更新计时器用 `modalLoop.depth` 判断是否将到期绘制交给 TJS 模态 continuation，纯宿主保存也会满足这个条件，却没有相应等待者；这可能让自驱动画停在已到期队列。修订区分实际 TJS continuation 与宿主作用域，纯宿主保存期间仍使用已有串行绘制调度，不为保存新增事件泵。主窗口关闭后的完成回执与提前退出判断也使用实际 TJS continuation 身份，宿主保存不提前取消普通回调的剩余语句。启用状态下的自更新、Timer 关闭主窗后正常返回与清理、暂停／eventDisabled 边界均列入同批验证；静态修订不代表运行通过。

确认只分配一次性 receipt；浏览器核对 generation/request/Pad epoch 后发起一次 Blob download，再返回 outcome ACK，host scope 此时才 finish/release。取消不下载，错误保留重试 UI。已发起下载的 outcome/cancel 回执在页面转后台或新子界面覆盖时仍按 request/receipt 接纳一次；父保存记录等待子界面真正结束，不要求浏览器重复下载或恢复游戏。host parent 若结束时存在 TJS child frame，必须等 child 真正 LIFO release；自动回收只作用于已结束 host scope，不能提前释放 TJS scope。临时被 System/Font/Clipboard 子界面覆盖的保存控件保留文件名、receipt 去重、选区与焦点；`pendingSaveId` 与当前可见 save 分离。

下载为 UTF-8、无 BOM，保留固定逻辑文本（通常 CRLF，同时保留脚本孤立 CR）；不是旧 ACP 保存字节的逐字兼容。安全 basename、默认 `.tjs`、只在用户操作后下载，不读写 KRKR VFS，不宣称浏览器发起下载等于用户磁盘写入成功。没有新增原版不存在的公开 `open/save/showModal/onChange/execute` API，执行按钮禁用。

## 明确 Web 策略

- Unicode 正文、标题、状态、文件名与字体名称保留；参考 ACP1252 会损失中文/emoji。默认 fontFace 采用 DFM CP932 字面 `ＭＳ 明朝`，与实际 ACP1252 getter 的 `‚l‚r –¾’©` 不同，浏览器缺字时 fallback serif。
- NUL 截断按固定源码的窄字符串终止边界实现，尚未获得真正嵌入 NUL 的原版 Pad 观测。textarea 自身 LF 归一会在真实用户编辑后把孤立 CR 表示成换行；未编辑正文与保存快照保留脚本逻辑文本。
- 初始 538×352、辅助桌面内级联坐标，不假装 OS 的 78/78 或 130/130。边框是 Web 装饰，置顶只在编辑器区域生效。
- 非法 scrollbar/border 枚举明确拒绝，未猜旧 VCL 的异常枚举行为。逻辑字号保留，0 或超过 512 px 的字体用 12 px 渲染 fallback；负尺寸逻辑保留、CSS 用 0，不触发无界分配。
- 默认最多 32 Pad、每 Pad 10,000,000 UTF-16 单元、会话总 16,777,216；正文超预算原子报错。撤销使用有界差分历史，最多 50 条/1 Mi UTF-16，脚本全量替换清空历史；不声称 RichEdit undo 栈深度相同。
- 行列提示基于 DOM 逻辑行与 UTF-16；隐藏状态栏保留底栏空间，`statusText` 与光标位置分开。

## 验证范围

新增 95 个 Node 测试定义（native factory 10、Pad 44、save 24、host modal 14、下载宿主 3）和 13 个浏览器场景模板（四种 VM 模式、三个项目，共 156 个预期实例）。覆盖真实原生 source/bytecode 工厂、属性/转换/寿命、消息排序与小预算、host modal LIFO/暂停/取消、真实 Worker 三浏览器 Asyncify/JSPI source/bytecode 编辑/输入/模态/下载。以上是静态库存，不是执行结果。浏览器保存测试读取实际 download 字节，字体测试使用实际游戏文件，合成事件测试仅证明生命周期，不能代称系统 IME 的端到端观察。

当前只有上文原版 SDK 托管结果；本实现的 Web 构建和测试等待整批 freeze 后交给 root 的 GitHub-hosted Actions。失败、取消、未执行、原始日志与 artifact 将各自保留，不以重跑绿灯覆盖历史。

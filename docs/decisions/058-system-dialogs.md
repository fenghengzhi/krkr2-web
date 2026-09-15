# 058：System 消息与文字输入对话框

本阶段把 `System.inform` 的日志占位改为真实消息对话框，并实现 `System.inputString`。脚本在调用处等待结果，同一 TJS 栈上的模态事件循环继续处理计时器和事件。代码与测试正在实现，尚无本阶段 Actions 通过结果；没有运行本地构建、测试、类型检查或浏览器探针。

## 原版合同

参考固定官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable。原始文件和 SDK 文档保存在 `out/verification/system-dialog/reference/`，哈希见其中 `source-manifest.json`。

- [SystemImpl.cpp:611](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L611)：`inform` 至少一个参数，标题省略或为 `void` 时默认 `Information`，显式空字符串保留，返回 `void`。SDK 手册写标题默认空字符串，与实际绑定有差异；这里采用实际绑定。
- [SystemIntf.cpp:123](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/SystemIntf.cpp#L123)：`inputString` 至少三个参数，分别为标题、提示与初值。确认返回字符串，空字符串也属于确认；取消返回 `void`。显式传入 `void` 满足参数数量要求，经 TJS 字符串转换得到空字符串。
- [SystemImpl.cpp:43](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L43)：两条平台路径分别调用 Win32 MessageBox 和 VCL InputQuery，没有事件禁用包装。[EventIntf.cpp:561](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.cpp#L561) 的事件投递没有总递归锁，MainForm 的 SystemWatchTimer 仍可投递事件。因此不能把对话框等待实现为全局暂停脚本事件。

参数转换在 TJS 中执行，保留 `ttstr` 的格式与转换错误，不使用 JavaScript `String` 替代。原版平台 UI 经过 ANSI 编码；Web 对话框保留 Unicode，不复刻代码页丢失。源码支持事件重入，但不证明两个原版模态泵具有相同的计时器频率、全部输入消息或焦点细节；原版托管 Windows 观测另行保存，不能用 Web 测试代替。

## 模态与宿主分工

`SystemDialogs` 只保留基本值、调用身份和单调请求 ID。请求里的临时 TJS 对象由挂起的调用者持有；宿主不额外保留脚本对象。UI 回应只能选择当前顶层请求的首次结果，结果在它自己的模态等待边界结束。子 Window 或子对话框必须先完成，父调用才恢复。打开期间发布失败、原生释放失败和 Stop 都有独立清理路径。

会话协议升级为 **12**。`system-dialog` 事件包含当前可交互请求及全部仍存活的请求 ID；UI 可区分暂时被子窗口遮挡与真正退休，保留父输入框的编辑内容与选择范围。`selectSystemDialog` 直接接收宿主结果，不排到已经被模态调用占用的 VM 队列之后。旧请求、重复结果、旧会话、暂停、页面不可见及字体选择期间的结果不会完成当前请求。

Window 输入阻塞按模态栈从顶向下决定：System 对话框阻塞游戏 Window，较新的模态 Window 可以接收自身输入，菜单不覆盖这一关系。进入 System 对话框会取消旧窗口输入、释放捕获并结束旧弹出菜单；计时器、脚本事件与媒体不因此全局暂停。已有事件禁用和页面生命周期规则继续生效。

浏览器使用原生 HTML dialog、真实表单控件和文字节点，支持确认、取消、键盘和输入法，并提供对话框内的停止游戏入口。焦点只恢复到仍存在、可见且可交互的目标。应用按会话 generation 隔离对话框，停止或重启会清除旧 DOM 和编辑记录。

## 验证边界

新增纯状态机、真实 TJS 源码／字节码及三浏览器 Asyncify／JSPI 用例，分别检查请求与 LIFO 生命周期、参数和返回值、Timer 重入、嵌套 Window／对话框、实际文字编辑与停止。所有可执行验证只在 GitHub-hosted Actions 进行；结果完成后按精确提交与构建记录。

本阶段不实现 Clipboard、Pad、整个 System 原生类身份、任意操作系统命令或插件。原生对话框 owner、ANSI、VCL 焦点及全部消息细节有平台差异。完整非插件目标仍在推进，不能凭这两项 API 宣称完成。

## 初次提交后的焦点顺序复审

初次提交 `62514dd04026458781cb66fa2a48bfe29b1cfe3a` 已进入 [Actions 35001901909](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001901909)，尚未完成。静态复审发现另一处独立边界：若先给 Window 应用 inert，再打开原生 dialog，浏览器可能已把原焦点移走，组件无法保存真实来源。后续修订明确区分 ModalLoop 的打开和退出发布：打开时先呈现 System 对话框，再发布 Window 阻塞；退出时先恢复 Window 可交互性，再让对话框按身份及焦点版本有条件地恢复。真实 Worker 的 inform 用例在手动 focus 或控制台操作之前检查焦点是否已回到游戏窗口。

这项修订尚待后续完整 Actions，不能把首轮未完成或任何后续通过追记为初次提交已通过。预期新增 28 项纯状态机、22 项真实 TJS、42 项浏览器组件与 48 项真实 Worker 检查；实际数量和结果以完整产物为准。

## 原版托管观测

[35002019683](https://github.com/fenghengzhi/krkr2-web/actions/runs/35002019683) 使用参考提交 `c579227940d1f17638747f333ec152a2c9c932f6`，在 GitHub-hosted Windows 2022／2025 的 8 个案例全部得到真实观测。消息、输入确认、空确认、取消各两例；对话框已出现且尚未点击的约 800 ms 内，每例均记录到 8 或 9 次 TJS Timer 回调。`inform` 返回 `void`，空确认返回长度为零的 String，取消返回 `void`。驱动只操作独立 SDK 进程中已核对的对话框及真实按钮／编辑控件。

参考驱动 SHA-256 为 `37b3eac8ee2f65cbbc17475093784f780e3de59f232f7dd4dbb9bb94c770e03c`。56 份原始产物及每例脚本、驱动哈希和事件记录均已保存。Unicode 目标 `Hello 雪 Ω 😀` 经原版 ACP 1252 编辑控件后，控件读回与 TJS 结果均为 `Hello ? O ??`；这属于原版 ANSI 平台损失，Web 保留完整 Unicode。该运行只使用显式随机 ASCII 标题，默认、void 和空标题仍依据固定源码，未混称二进制验证。

首轮 [35001453121](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001453121) 为 2 项消息观测成功、6 项输入未能执行：构造中的控件读取超时及 ANSI 损失后的按钮标题使驱动无法确认输入条件。56 份原始证据继续保留；修订等待控件稳定并以真正的返回结果确认按钮语义，没有改写首轮状态，也没有扩展为未经观测的递归对话框或全部焦点行为。

## 首轮已报告结果与后续修订

首轮 `35001901909@62514dd` 的 Node 作业失败：**1,797 项普通用例通过、1 项普通断言失败、另有 1 个文件级 SIGABRT 占位，8 项普通用例未报告**。新增 50 项对话框 Node 用例全部实际通过。未报告的是 `layer-neutral-color.test.ts` 最后一项源码及七项字节码用例；文件占位不能当成一个真实案例或代替这八项。原始 TAP、日志、core 哈希和回溯分别保存。

唯一命名断言失败是旧的 bytecode 隐藏模态检查点用例：receipt 完成后再等一次 setImmediate，观察到 modalScopes=1、操作仍 pending，但 modalWaits=0。receipt 在检查点提交时完成，TJS 尚须返回事件泵才能进入下一次 Modal.wait。后续夹具改为观测真实 Modal.wait 已同步安装等待、且没有模态工作时发出停泊信号；不使用 evaluate、idle 或额外 sleep，保留原来的完成、所有权和无忙转要求。

异常终止前的可靠原日志是 `corrupted size vs. prev_size` 与 SIGABRT。首次回溯有五个库 build-id 不匹配、线程库不匹配和 corrupt stack：工作流在崩溃后安装 gdb，把 libc6 从 `2.39-0ubuntu8.8` 升级到 `8.9`，随后才读取 core。这些符号链不能据以确定根因。后续把 gdb 安装移到测试之前，并保存 gdb、libc 版本及 Node 链接库；这仅修正采集顺序，不是已证明修复异常，也没有新增或重建历史安全拒绝的分配复现。

首轮 Chromium 常规浏览器实际 **369／371**；两个失败均为 Asyncify 源码／字节码 inform 返回后的真实焦点恢复断言，已到对话框关闭之后，后续控制台断言未执行。其余 Chromium 新用例与 JSPI inform 实际通过。`d01caed` 的发布顺序修订对应此边界。记录本节时 Firefox／WebKit 尚未结束，不能据局部结果声明首轮完整通过。

只含焦点修订的 `d01caed` 曾排队为 `35002247123`；后续合并上述夹具与诊断修订时，任何被 GitHub 替换而未执行的排队运行都应单独记录，不计作通过。

首轮 Firefox 常规实际 **363／371**：四项 inform 均在恢复游戏焦点处失败；另四项 inputString 在第一次 Enter 后已经返回完整 Unicode 字符串并打开下一输入框，因而不满足“还在组合中”的夹具预期。trace 没有单独记录 DOM compositionend，但固定 [Playwright 1.63 ffInput.ts](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/firefox/ffInput.ts#L106) 与 [Firefox PageAgent.js](https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/firefox/juggler/content/PageAgent.js#L541) 显示 keyboard.insertText 通过 commitCompositionWith 插入文字，结束其组合生命周期。因此后续夹具先执行并检查真实 Unicode 插入，再独立发出组合开始信号，检查真实 Enter 不提交，最后组合结束后再次 Enter 提交。没有放宽结果、增加超时或改动产品防护；专门的 OS 输入法驱动仍不在此测试的证明范围。

`35002247123@d01caed` 最终在排队时被 GitHub 替换，状态 cancelled，零作业、零已执行测试；前后快照均保留。合并旧检查点夹具与诊断修订的 `35003369151@4c664bc` 也曾排队，后续若因上述 Firefox 夹具修订被替换，必须同样单独保存，不视为通过。

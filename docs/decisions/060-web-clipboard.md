# 060：core Clipboard 与真实浏览器剪贴板

状态：实现及验证用例已编写，**尚未由本阶段 GitHub-hosted Actions 执行验证**。本机未运行测试、build/check、浏览器或系统剪贴板探针。不能把下文待验收项目写成通过结果；所有首次失败、中断与原始 artifacts 必须保留。

## 原版合同与本阶段接口

固定依据是官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/`。Clipboard 在原版 core 注册；仅提供全局 `cbfText=1`、静态方法 `Clipboard.hasFormat(format)` 和静态可读写属性 `Clipboard.asText`。没有增加图片剪贴板脚本 API、事件或插件入口。[ClipboardIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/ClipboardIntf.cpp#L48)、[原版注册](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/ScriptMgnIntf.cpp#L474)。

hasFormat 至少要求一个参数，在原生 TJS/C++ 侧先转换为 tjs_int，保留 64 位整数的低 32 位；不支持的格式直接返回 false，不请求浏览器权限。getter 将“没有文本格式”映射为 void，将存在但为空的文本映射为 `""`。setter 在原生侧做 ttstr 转换，等待实际写入完成后才恢复后续脚本。

丢弃 hasFormat 返回值也仍执行查询：固定 ClipboardIntf.cpp 先调用 `TVPClipboardHasFormat(format)`，随后才用 `if(result)` 判断是否写回结果。这里没有仅在需要返回值时才读取的优化；`Clipboard.hasFormat(cbfText);` 仍会请求用户执行真实读取。已写 source/bytecode 用例核对此行为，依据是固定源码（文件 SHA-256 `c5079ca7424581b64624ab7358e4dbe98e89fa09b4798a47bb7db3908f44d477`），不是未进行的 SDK 运行观察。

类沿用现有 HostClass 和 krkr_value_set_class，专门为 Clipboard 注册真正的静态 Function/Property；没有新增 WASM 导出或改变 ABI 5。构造器与 finalize 仍是普通成员，静态业务成员不复制到实例。虽然手册写“不能构造”，固定原版源码的 CreateNativeInstance 返回 NULL，基类仍成功创建空壳；本阶段按此源码实现，尚未将这个结论标作 SDK 可执行观察。[ClipboardImpl.cpp:114](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/win32/ClipboardImpl.cpp#L114)、[TJS 构造与静态复制](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/tjs2/tjsNative.cpp#L301)、[手册](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Clipboard.html)。

WASM manifest 新增 `capabilities.nativeClipboard=1`，生产加载器明确拒绝缺少该能力的旧 kernel，避免旧通用工厂默默生成没有业务成员的类。编译源/hash与manifest仍由现有 build-wasm 流程统一产生；本阶段没有本地更新生成文件。

## 实现边界与所有权

`engine/ports/clipboard.ts` 描述异步 ClipboardPort 与独立的文本存在性。EngineSession 注入真实 host；没有 host 时返回明确 NotSupportedError，不创建内存剪贴板。脚本只通过普通 cancelable host Promise 等待，不新增 ModalLoop scope，不泵入 Timer，也不修改 Window.visible/focusable 或 System.eventDisabled。

生产使用独立 MessageChannel：Worker 的 PortClipboardBackend → 主线程 ClipboardChannel → GameClipboard 可见操作入口 → BrowserClipboard。请求及回复含 session generation、递增 request id 与 operation；一个 host 同时只有一个等待请求。消息不依赖当前仍被 Clipboard 挂起的脚本 RPC，避免排队死锁。Worker 只接收同身份、同操作的完整结果，当前请求的畸形回复会明确失败；旧身份与重复回复不能消费新请求。

UI 每次显示明确的“复制文本”“读取剪贴板”或“检查文本格式”，并提供取消与停止。写入前可查看游戏提供的文本；读权限提示说明内容会交给当前游戏。实际 Clipboard API 在按钮 click handler 内直接调用，之前不 await Worker、权限查询或定时器；没有自动读写或最近写入值缓存。

文本上限统一为 **1,048,576 个 UTF-16 code units**，恰好达到上限允许；超限返回明确 QuotaExceededError，不静默截断。Session、Worker 发送前、主线程协议边界与 BrowserClipboard 都使用同一常量。读取 text/plain Blob 先检查不超过 **4 MiB**，才调用 text()，解码后的文本再检查 UTF-16 长度。hasFormat 仅查看类型，不把 Blob 大小当作格式不存在。传输中的错误 name/message 也分别受同一文本限额约束，超限改为短的额度错误。

可识别 id/generation 的畸形或超限新请求收到明确失败回复，不显示无效操作；当前请求的畸形或超限回复同样结算为失败。不能通过只忽略这些消息让 Worker 永久等待。错误 generation、旧 id 或已知的另一 operation 仍不能代替当前请求；发送失败会退休通道并尽力通知关闭。UI 写预览只展示前 **2,000 个 UTF-16 code units**，明确总长度和预览范围；用户确认写入的仍是完整、已通过上限检查的文本。

面板自身是非模态 section。已有实际 `dialog:modal` 时，它挂在当前可交互对话框内，避免被浏览器 inert 阻挡；挂载关系变化时迁移同一面板。等待 Clipboard 期间父 System/Font 对话框的答复与编辑暂时禁用，Stop 保留，脚本的模态状态不变。键盘事件由面板接收，游戏菜单捕获处理器跳过面板目标；不因此全局禁用脚本事件。

Stop 先退休 UI、请求身份和端口等待；BrowserClipboard 继续消费已发 Promise 的迟到结果/拒绝，但不回传到新 Session。Clipboard API 没有 AbortSignal，**已发出的系统写入可能仍完成，无法承诺撤回或回滚**；实现不会为了恢复旧内容再写一次系统剪贴板。

主线程停止时先移除可操作 UI，再等待 Session 在 Worker 内取消控制，最后独立关闭主线程端口。不能先从 Clipboard 端口发 close、再假定另一 RPC 端口的 Stop 一定先执行；那会把原本的停止误变成可捕获 AbortError 并恢复 TJS catch。既有四种 VM 的启动期 Stop 用例包含返回/catch/tail 均不得运行的断言，并在新会话开始前保存旧日志。

会话协议在本分支从 12 增为 13；并行 059 也使用 13，根分支合入时必须统一协议版本与最终字段，不能把两份互不兼容的旧部署混用。

## 真实 API 与错误映射

BrowserClipboard 只在安全 Window 上调用 navigator.clipboard。hasFormat 使用真实 `read()` 返回的 ClipboardItem.types 查找 text/plain；getter 在同一次 read 的首个 text/plain item 上调用 getType/Blob.text。不存在该类型才返回 void，空 Blob 仍是空字符串；getType 失败独立传播。不能用 readText 的空字符串猜测格式，也不能用 ClipboardItem.supports 判断当前内容。[MDN Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)、[types](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/types)。

| 情况                                 | 本阶段 Web 结果                                                |
| ------------------------------------ | -------------------------------------------------------------- |
| 无安全 Window / 无所需 Clipboard API | 可捕获的 NotSupportedError                                     |
| 实际浏览器操作失败                   | 保留实际异常 name/message；TJS host message 为 `name: message` |
| 用户取消                             | 可捕获的 AbortError，不能当作不存在文本                        |
| Session Stop                         | 现有 ExecutionCancelled 路径，解除等待                         |
| 成功读取且无 text/plain              | hasFormat false / asText void                                  |
| 成功读取 text/plain 且内容为空       | hasFormat true / asText 空字符串                               |

这与原版部分 Win32 读取故障直接返回 void 有明确差异；浏览器拒绝读取不证明不存在文本。原版 setter 经 VCL/分配也可能抛错，并非总是静默成功。[ClipboardImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/win32/ClipboardImpl.cpp#L21)、[TVPCopyToClipboard](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/win32/TLogViewer.cpp#L22)。

这里只映射浏览器 text/plain，不保证复刻 Win32 ANSI/Unicode 双格式、NUL 截断或各 OS 换行归一化。当前 MDN 与 2026-06-24 W3C 草案对 readText 无匹配格式时返回空串/NotFoundError 有差异；实现不依赖该歧义，实际浏览器异常仍需保留。[MDN readText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText)、[固定草案](https://www.w3.org/TR/2026/WD-clipboard-apis-20260624/#dom-clipboard-readtext)。

## 验证要求与不能外推的结论

所有新增用例只在 GitHub-hosted Actions 执行。Node 合同测试覆盖真实 source/bytecode 的原生身份、静态复制、参数转换、void/空串、先后顺序、错误与停止，并用注入 Port 验证协议；这类用例不算真实浏览器剪贴板证据。MessageChannel 用例覆盖单等待、代际与操作匹配、迟到回复、同步发送/呈现异常及双向关闭。

补充用例验证精确 UTF-16 上限、超限写入不进入 API/端口、Blob 解码前的字节上限、解码后的文本上限、可识别超限协议请求/回复不挂起，以及预览限制不改变复制内容。原生能力用例检查实际 manifest 标记并通过真实 WASM 工厂访问 Clipboard；生产 loader 用例通过真实页面启动路径，仅删除真实 manifest 的 nativeClipboard 标记，验证明确拒绝、Worker 清理与恢复原 manifest 后的新会话。字体宿主用例使用实际 Font/Clipboard DOM 组件验证等待期间父答复禁用、Stop 保留及完成后恢复；该组件用例注入假 Port，不充作系统剪贴板实证。

浏览器用例使用真实点击与真实 navigator API；仅观察包装转发原函数，记录调用时激活/聚焦/安全上下文、实际返回类型和异常。合成 Unicode、空文本与 PNG-only 内容用来检验文本格式区别；PNG 是测试输入，不是新增游戏接口。额外覆盖用户取消、Stop/旧按钮、新 Session 和已有 SystemDialog 的 Timer 发起请求。

固定 Playwright 1.63.0 的 Chromium 驱动支持 clipboard-read/write grant，WebKit 只支持 clipboard-read，Firefox 不支持两者，不能吞掉 Unsupported grant 后声称已授权。成功矩阵必须明确使用的 grant；Chromium headless-shell 的无 grant 拒绝另作实际错误路径，不预设所有引擎无 grant 都能成功。外部内容触发的原生 Paste 提示没有自动化证据时保持未覆盖，不能用页面 DOM 假装完成浏览器授权。[各引擎官方权限测试](https://github.com/microsoft/playwright/blob/v1.63.0/tests/library/permissions.spec.ts)、[WebKit grant](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/webkit/wkPage.ts)、[Firefox grant](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/firefox/ffBrowser.ts)。

`page.evaluate()` 在固定驱动里会模拟用户激活，所以不能用它启动请求来证明无激活规则。正向操作来自页面真实 click；无激活用例由全新页面自己的初始脚本记录状态与结果，完成前不通过 evaluate 污染激活。[Chromium](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/crExecutionContext.ts)、[WebKit](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/webkit/wkExecutionContext.ts)、[Firefox](https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/firefox/juggler/content/Runtime.js)。

官方测试明确现代 headless 使用每 browser 实例私有的剪贴板；通过这些用例只能证明真实浏览器 API/后端行为，不能证明与桌面应用的 OS 剪贴板互通，也不能推导同一 browser 各 context 隔离。当前 hosted Firefox 的 headed 配置须按实际 OS 显示后端记录，不能混称 headless 私有。用例不得互相并行覆盖同一剪贴板；报告保留实际 browser revision、headless 配置与 grant。任何结果都不承诺任意部署、权限策略或系统剪贴板总可用。[固定 browser inventory](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/browsers.json)、[headless 隔离证据](https://github.com/microsoft/playwright/blob/v1.63.0/tests/library/permissions.spec.ts)。

# 060：core Clipboard 与真实浏览器剪贴板

状态：实现及验证用例已编写，**尚未通过本阶段 GitHub-hosted Actions 验证**。首轮 [35009240317](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009240317) 在 `12af5df0a1c18702d7f89ac1a04fd0cb5847a48b` 构建失败：`game-clipboard.ts:247` 的条件表达式未能把联合类型收窄至写入请求（TS2339）。已改为明确的 operation 分支，仍在真实点击内直接调用 API。该轮实际测试执行数为 **0**，两个作业失败、四个作业跳过；不能记作剪贴板行为通过。本机未运行测试、build/check、浏览器或系统剪贴板探针，首次失败与原始 artifacts 继续保留。

第二轮 [35009742804](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009742804) 在 `53a37dc593a8e081b51d7f499f7f390b1473c6a1` 仍于构建阶段失败，实际测试执行数为 **0**。应用和 Worker 类型检查已通过，工具检查报 `clipboard.test.ts:468` TS2339：`assert.equal(stopped.ok, false)` 已收窄至拒绝结果，紧随的成功分支成为 `never`。该失败独立保存，不替代首轮记录。

第三轮 [35009913509](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009913509) 的提交 `fe3a6bede8238d6b7e522b0d869d69d64044eb55` 实际只更新了文档，源码补丁没有落入提交，因此再次因同一行 TS2339 构建失败，实际测试执行数仍为 **0**。真正的一行修正位于 `e85e41fae181596b70ef58c72507dd81fa3bc08a`：删除不可达成功分支，保留“必须拒绝”、错误类型/消息、日志和句柄清理断言。第三轮不是修正后的测试通过记录。

第四轮 [35009940671](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009940671) 在 `e85e41fae181596b70ef58c72507dd81fa3bc08a` 的 **Chromium regular 作业**实际 413/418 通过、5 项首次失败；这里不提前填写整轮结论。四种 VM 组合都在成功写入空字符串后读取到 `types=[[]]`，TJS 已输出 `empty-format:0` 并等待下一次读操作；失败是测试仍等待 `empty-format:1`。第五项在无 grant 的真实按钮写入时返回 `NotAllowedError: ... Write permission denied.`，且调用时 active/focused/secure 均为 true；后续读取没有执行。061 的 [35009948147](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009948147) Chromium 作业保留了同五项、相同原始 Clipboard 观测。两份失败证据独立保留，不以修订后的测试覆盖。

同轮 **WebKit regular 作业**实际 407/418 通过、11 项首次失败；WebKit 26.6/revision 2359、macOS headless，均无 grant。每项都有实际写入成功，随后 `read()` 在 active/focused/secure 为 true 时拒绝为 NotAllowedError。四个往返用例在首次非空 hasFormat 已被拒绝，尚未触及空文本。四个 Stop 用例的首轮停止日志只有 `startup-before`，旧请求取消和禁止继续的断言已经通过；trace 随后到新会话的 `fresh-written`，首次失败是其 `fresh-read:1`，finally 的待机检查又被新会话“运行失败”状态阻挡。不能把最后的清理报错归为 Stop 本体故障。其余三个失败是 PNG-only 格式查询、无 grant 读取、父输入框 Timer 内读取。同轮 Firefox regular 实际 418/418 通过，空文本 read 保留 text/plain，无 grant 的写和读均成功；三种浏览器证据分别保存。061 第一轮 WebKit 同样有这 11 个 Clipboard 失败，不由省份图读写新增功能引入。

本次只校准测试和文档：固定 Chromium 153.0.8010.12 headless 分支要求空写入后 API 不暴露文本格式，继续实际点击 getter 并要求 void，再真实写入非空文本并读取恢复。成功路径对 Chromium 授予 read/write、对 WebKit **只授予 clipboard-read**，Firefox 不授予该权限；WebKit 授权后的空文本行为尚待实际运行，仍严格检验存在文本时返回空字符串。无 grant 案例固定为 Chromium 写/读均拒绝、WebKit 写成功/读拒绝、Firefox 写/读均成功；拒绝分支检查具体 NotAllowedError 与原始消息，然后显式授予对应浏览器支持的权限并真实写读恢复。**Chromium 首轮只观察到写入拒绝；新补的 Chromium 读取拒绝及两种浏览器授权后的恢复仍待后续 Actions 实测**。所有调用顺序、原始异常、激活/聚焦、授权变更发生的调用序号分别记录；原 12 秒断言期限不变，生产实现没有增加缓存或修改返回合同。

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

会话协议在本阶段与 059 视频混合图层合并后统一为 **14**；两个独立开发分支曾各自使用 13，不能把两份互不兼容的旧部署混用。Worker 编译排除两个浏览器 DOM 后端，Clipboard／Video 的 Port 后端继续受 Worker 类型约束。

## 真实 API 与错误映射

BrowserClipboard 只在安全 Window 上调用 navigator.clipboard。hasFormat 使用真实 `read()` 返回的 ClipboardItem.types 查找 text/plain；getter 在同一次 read 的首个 text/plain item 上调用 getType/Blob.text。不存在该类型才返回 void，空 Blob 仍是空字符串；getType 失败独立传播。不能用 readText 的空字符串猜测格式，也不能用 ClipboardItem.supports 判断当前内容。[MDN Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)、[types](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/types)。

“存在的空文本表示”与“写入空字符串后浏览器未暴露文本表示”不是同一状态。上述固定 Chromium headless 实测属于后者，不能用最近写入的空字符串伪造 text/plain 存在，也不据 `read()` 的类型列表断言桌面 OS 剪贴板必然被清空。固定 Chromium 源码在公共写入分派中跳过空 TextData，而新后端数据仍会提交；读取结果可以包含一个没有类型的 ClipboardItem。这解释了该配置的 `types=[[]]`，不改变当宿主确实提供空 text/plain Blob 时应返回 `""` 的 engine/adapter 合同。[空文本分派](https://github.com/chromium/chromium/blob/153.0.8010.12/ui/base/clipboard/clipboard.cc#L267-L306)、[后端提交](https://github.com/chromium/chromium/blob/153.0.8010.12/ui/base/clipboard/clipboard_non_backed.cc#L878-L899)、[返回 ClipboardItem](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/modules/clipboard/clipboard_promise.cc#L310-L343)。

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

WebKit 的这次拒绝也有自动化专属依据：固定 Playwright WebKit 原生补丁在 `isControlledByAutomation()` 下默认拒绝 DOM paste access，只有 origin 已获 `clipboard-read` grant 才放行。即便写入来自同源、当前有用户激活，也不能把普通 Safari 的同源读取说明直接用作该驱动的成功预期。补充 read-only grant 只调整明确记录的测试环境，不给产品添加权限绕过，也不尝试 WebKit 不支持的 clipboard-write grant。[WebKit 自动化权限分支](https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/webkit/patches/bootstrap.diff#L14532-L14547)、[驱动支持表](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/webkit/wkPage.ts#L1240-L1256)。

固定配置未指定 channel，Playwright 因 headless 选择 Chromium Headless Shell；其权限管理器对请求返回 ASK，模拟关闭提示，Blink 写入分支只把 GRANTED 视作成功。因此用户激活存在也可能得到本轮精确的 Write permission denied，不能据此归因于按钮丢失激活，也不能外推为所有 Chrome 部署都拒绝写入。[Playwright 选择规则](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/chromium.ts#L418-L424)、[Shell 权限结果](https://github.com/chromium/chromium/blob/153.0.8010.12/headless/lib/browser/headless_permission_manager.cc#L22-L38)、[Blink 写入判断](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/modules/clipboard/clipboard_promise.cc#L589-L604)。

`page.evaluate()` 在固定驱动里会模拟用户激活，所以不能用它启动请求来证明无激活规则。正向操作来自页面真实 click；无激活用例由全新页面自己的初始脚本记录状态与结果，完成前不通过 evaluate 污染激活。[Chromium](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/crExecutionContext.ts)、[WebKit](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/webkit/wkExecutionContext.ts)、[Firefox](https://github.com/microsoft/playwright/blob/v1.63.0/browser_patches/firefox/juggler/content/Runtime.js)。

官方测试明确现代 headless 使用每 browser 实例私有的剪贴板；通过这些用例只能证明真实浏览器 API/后端行为，不能证明与桌面应用的 OS 剪贴板互通，也不能推导同一 browser 各 context 隔离。当前 hosted Firefox 的 headed 配置须按实际 OS 显示后端记录，不能混称 headless 私有。用例不得互相并行覆盖同一剪贴板；报告保留实际 browser revision、headless 配置与 grant。任何结果都不承诺任意部署、权限策略或系统剪贴板总可用。[固定 browser inventory](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/browsers.json)、[headless 隔离证据](https://github.com/microsoft/playwright/blob/v1.63.0/tests/library/permissions.spec.ts)。

# 069 — System 显示几何与每个 Player 的虚拟显示区域

状态：实现与验收定义待统一 GitHub-hosted Actions 验证；未在本地运行测试、构建、类型检查或浏览器探针。

## 已观测缺口与原版合同

真实 KAG 兼容运行 `36448778629`、源提交 `eca4086` 在 `MainWindow.tjs:436` 读取 `System.desktopLeft` 时报告 member missing。三浏览器的 flow、panels、diagnostics 路径因此被阻断。历史失败保留在主工作区 `out/verification/github-actions/36448778629`；添加属性不是该运行已经通过的证据。KAG 验收复用下一批同一构建的完整兼容流程。

固定参考是官方 krkrz/krkr2 的 `dec49af97e174d31059c3ccd7efc700ba3c6b788`，`kirikiri2/branches/2.32stable`。原文、副本来源、SHA-256、KAG fixture 来源与只读审计位于主工作区 `out/verification/system-display/reference/source-manifest.json` 和 `contract.md`。这是源码证据，没有新增原版运行观测。

`SystemImpl.cpp:863–947` 定义六个 static native Property，返回整数，普通赋值返回 `TJS_E_ACCESSDENYED`：

| 属性                         | 原版实现                           |
| ---------------------------- | ---------------------------------- |
| screenWidth / screenHeight   | `Screen->Width` / `Screen->Height` |
| desktopLeft / desktopTop     | `TVPGetDesktopRect` 的 left / top  |
| desktopWidth / desktopHeight | 同一矩形的 right-left / bottom-top |

`TVPGetDesktopRect` 每次调用 `SystemParametersInfo(SPI_GETWORKAREA)`，即主显示器排除任务栏等保留空间后的工作区；不是多显示器联合矩形。VCL 的内部实现不在固定源文件中，`Screen` 为主屏尺寸的解释保留为官方文档支持的推断，不伪称已观测历史 VCL 内部 Win32 调用。相邻 `stayOnTop` 是可写属性，不纳入本切片。

## Web 坐标选择

本项目 Window 的 left/top 是页面内虚拟窗口坐标，普通浮动窗口相对所属 stage 定位，现有全屏窗口及覆盖全屏模态父窗口的对话框采用 viewport fixed 定位。因此默认将每个 Player 视为一台虚拟显示器：

| 当前呈现           | screenWidth/Height                             | desktopLeft/Top | desktopWidth/Height                     |
| ------------------ | ---------------------------------------------- | --------------- | --------------------------------------- |
| 普通窗口           | 自己 stage 的 clientWidth/clientHeight         | 0 / 0           | 同一 stage 的 clientWidth/clientHeight  |
| 自己有可见全屏窗口 | 所属 document 的 window.innerWidth/innerHeight | 0 / 0           | 同一 viewport 的 innerWidth/innerHeight |

单位均为整数 CSS 像素；不乘 DPR、不加页面偏移或滚动位置、不读取 OS `screen.width/availWidth`，也不请求 Window Management 权限。零原点是既有窗口定位模型的原点，尺寸来自实际 DOM，不是 800×600 或其他兼容性占位。普通 stage 使用 client 大小，不使用会被越界浮动窗口放大的 scrollWidth/scrollHeight。Web 默认没有 OS 任务栏保留区，因此两组大小相同；这项适配不宣称还原宿主 OS 工作区。

这样 KAG 的 `MainWindow` 桌面居中和 `YesNoDialog` 屏幕边界检查指向相同区域；仅把 screen 设为更大的物理屏幕或页面视口会使普通 stage 内的弹窗仍然越界。KAG 自己对过大对话框可能产生负坐标的行为保持原样。独立全屏控制来自该 Player 已应用给窗口 host 的 WindowPresentation roster，且只看已经 attach 的有效 surface。`PlayerWindowHost.isFullscreen(windowId, surfaceEpoch)` 查询实际应用的放置状态：GameWindows 会抑制被另一个全屏窗口替代的旧窗口，因此不能只看脚本请求的 fullScreen 位。该查询不依赖 app 的 CSS 类名，也不读取其他 Player 的 DOM 全屏标记；自定义 host 未实现查询时，按其遵守请求 fullScreen 状态的既有合同解释。

`PlayerOptions.desktopElement` 可指定稳定的窗口容器；默认在创建 Player 时捕获 canvas.parentElement，缺失时使用所属 documentElement。app 明确传自己的 stage。容器必须是 canvas 所属 document realm 的实际 HTMLElement，且 ownerDocument 相同；伪 ownerDocument 对象、SVG 节点或其他 document 节点在通道分配前拒绝。调用者的自定义 Window host 应使用同一容器作为浮动窗口定位空间，并遵守既有 fullScreen 呈现合同。单个 embedded 主窗口仍由既有样式锚定在页面，不因此改变其定位实现。

监测同时使用 content-box 和 border-box ResizeObserver，分别捕捉滚动条与 padding 等变化；同值样本不发消息。窗口 resize、visualViewport resize、document fullscreenchange 只重新测量既定来源，不把 pinch-zoom 的 visual viewport 当作 layout viewport。尺寸改变仅更新几何快照，不写 DOM、不自动移动或缩放游戏窗口，不形成由该监测器自身引起的布局反馈。自动撑高的 stage 会如实报告其布局大小；固定空间的嵌入可设置容器的 CSS 大小。

## 注入、整数与生命周期

`PlayerOptions.systemDisplay` 可注入完整的六字段固定快照。每个值仅读取一次后复制，调用者之后修改对象不影响 Player；注入模式不注册尺寸观察器，也不因页面 resize 或该 Player 全屏而被默认采样覆盖。宽高必须是 0..2147483647 整数，left/top 必须是 signed int32；缺项、浮点、NaN、字符串及越界输入在 host 资源分配前拒绝，不静默截断。需要自定义动态来源的 host 可以通过 `player.session.setSystemDisplay({ revision, metrics })` 提交严格递增的快照，但不应同时与默认 DOM 监测器竞争 revision。

纯 EngineSession 接受相同 `systemDisplay` 依赖；未注入时六字段明确为 0，表示无显示设备的 headless 环境，不冒充真实屏幕。每次更新原子替换一份复制的六字段快照，六个 native getter 将 number 转成 BigInt 传回 TJS 整数，不变成 TJS Real。原子替换不意味着多次异步 getter 调用组成数据库式读取事务。

原生 static Property 使用已有 `krkr_class_property` / HostProperty，不增加 C++ export 或改变布局。借用属性引用、普通写入拒绝、强制引用替换等行为继续由原生 TJS 属性机制提供。`nativeSystem` 保持 2、TJS ABI 保持 5；这不是新增 WASM 内核能力。本切片独立分支暂用协议 19，初始化几何及后续 RPC 与 068 音频滤镜在集成分支合并后，页面与 Worker 统一使用协议 20。

初始默认样本在创建 Player 时产生；初始化传当时最新快照，SessionClient 在初始化后重放最新 revision，覆盖 prepare/initialize 期间布局变化。后续 RPC 携带该 client generation；Worker 拒绝旧 generation，Engine 拒绝旧/相同 revision，暂停状态允许几何更新而不恢复脚本执行。Stop 在等待 Worker 退出前断开观察器与事件监听；已排队的 ResizeObserver 回调检查 closed，已取消/停止/失败 Session 拒绝更新。观察器半构造失败也会逐一断开已经创建的观察器和监听，随后借用现有 Player 清理路径释放其余资源，不为清理新建 Worker；host 全屏查询异常沿现有 updateParts/onError 路径报告。新 Player 拥有独立 Worker、generation、revision 与源容器。

## 验收边界

新增定义使用真实 hosted WASM source / compileStorage 字节码，检查六个原生属性身份、TJS Integer、readonly 与借用引用、复制输入、signed-int32 边界、更新/暂停/旧 revision/Stop/新 Session。浏览器使用真实 public createPlayer、createGameWindows、Worker 与独立 DOM 读数，覆盖默认尺寸、实际 stage resize、全屏进退、两个 Player 隔离、固定注入、无效输入及 Stop 后清理。KAG 的真实 flow、panels、diagnostics 由根任务下一次同构建兼容运行验证。

此切片新增 7 个 Node 用例及 9 个浏览器模板（后者包含 source/bytecode 与 Asyncify/JSPI 的定义展开；三浏览器为 27 个调度用例，JSPI 支持状况仍由既有门控如实记录）。这些均为待执行的验收定义。此前失败或未执行记录不因此改记为通过。

## 首轮集成 Actions 的局部结果与表达式夹具修复

`36455312915`、源提交 `56769cf` 的原始 `artifacts/node-results/node.tap` 在条目 1037–1043 记录本切片七个 Node 用例全部 `ok`，包含 source 与 compileStorage 字节码。Chromium regular 的原始 `results.json` 记录本切片 9 个用例为 5 passed / 4 failed：四个固定注入与 revision/generation 用例及一个无效配置/观察器失败恢复用例通过；四个默认 DOM 几何变体均在创建第二个全屏 Window 的同一夹具调用失败。这不是该完整 workflow 或另外浏览器的通过结论。

四个失败 attachment 均记录初始两个 Player 的原生属性检查 `6|6|6|6|6`，以及真实 stage resize、padding-only resize、进入全屏和 viewport resize 的先行读数。它们的清理记录都为两个 Player disposed、零 liveWindow、空 errors。后续全屏替换、暂停后更新、Stop 后 resize 与重建分支尚未到达，不能据此宣称通过。

失败 trace 的实际 `page.evaluate` 发送 `var sdSecondWindow=new Window();...`，随后收到原生 TJS `Syntax error`。`EngineSession.evaluate` 明确传 `expression=true`，经 `TjsWasmRuntime.execute` 的 mode 1 到 `krkr_execute` 的 `EvalExpression`；该 console 入口不接受顶层 var 语句。独立源码复核还确认 `tjsLex.cpp` 为表达式模式补入 `return`：创建串相当于 `return var ...` 而语法失败；尚未到达的清理串则会在 `sdWindow.fullScreen=false` 后返回，后面的 `invalidate sdSecondWindow` 不会执行。后者是源码推导，不是本次失败运行中已到达的观测。

修复将创建过程放入立即调用的函数表达式，使用 `global.sdSecondWindow` 保留后续操作所需的 Window，并把同一用例尚未到达的多语句清理也放入函数表达式。生产代码、全部原有几何期望、真实 DOM 测量、后端与字节码覆盖、用例数量均不变。

原始报告、TAP、trace 和失败状态保留；局部数据审计位于主工作区 `out/verification/system-display/ci-36455312915-chromium-diagnosis.json`。这个修复仅完成静态审查，没有本地执行或单独 Actions 重跑，等待根任务下一批统一验证。

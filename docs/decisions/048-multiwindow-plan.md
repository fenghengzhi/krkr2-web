# 048 — 多窗口架构草稿：尚未实现

本决策仅归档源码审计与实施顺序，不代表功能或验证通过。当前仍拒绝同时创建第二个活动 Window；阶段 047 的 mainWindow 查询不解除此限制。完整目标是多个窗口同时呈现、交互和独立关闭，不能以隐藏窗口或仅登记多个对象作为完成条件。

建议保留一个 Worker、Session 和 TJS VM，在页面内为每个 Window 建立独立 DOM 窗口、OffscreenCanvas 和 WebGLRenderer。LayerTree、脚本队列、存储、字体、音频与页面活动状态继续共享。浏览器独立 popup 不是首个呈现后端；它需要另处理跨 document 的节点、活动状态和媒体所有权。

## 原生关闭与模态证据

官方来源固定为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/`。本地对照是 `/Users/fenghengzhi/Developer/kirikiroid2-web` 的 `13dda190f8370d02b6cf59286a088529b355658c`；下列相关文件没有工作区改动。这是源码比较，没有运行原生程序，也没有将该移植源码当作参考二进制的行为证明。

| 入口                             | 已读到的控制流与边界                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 登记与注销                       | 官方 [WindowIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L33-L70)：列表为空且主窗口为空才登记新主窗口；新建窗口向全部窗口排 capture-release。主窗口注销不提升现存副窗口；Invalidate 先注销，再清理事件、视频和托管对象。                                                                                               |
| 用户关闭／脚本 close／invalidate | 官方 [WindowFormUnit.cpp 的关闭处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L393-L550)：用户关闭先排输入事件，等待 onCloseQuery；允许后非模态副窗只隐藏，主窗失效。脚本 close 设置 ProgramClosing，立即调用查询，允许后失效对象；显式 invalidate 不再询问。模态关闭另通过 ModalResult 处理，不能与普通关闭合并。 |
| 主窗口退出政策                   | 官方 [SysInitImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SysInitImpl.cpp#L1273-L1302)：默认 TVPTerminateOnWindowClose=true；TVPMainWindowClosed 还要求 TVPMainForm 存在且不可见才异步退出。这里的 MainForm 是宿主表单，不能等同于脚本 Window.visible。                                                                           |
| showModal 包装                   | 官方 [WindowImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp#L1618-L1655)：close 转交 Form；showModal 拒绝全屏，清空全部窗口待处理输入，再调用 ShowWindowAsModal。                                                                                                                                                   |
| 模态范围                         | 官方 [ShowWindowAsModal](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1499-L1516) 设置 ModalResult／InMode，登记模态窗口，调用 TForm::ShowModal，正常或异常返回均撤销登记。这段源码没有展开 VCL 内部循环，不能单凭它声称所有嵌套回调顺序已确定。                                                                      |

本地移植的编译路径有所不同：[environ/CMakeLists.txt:31、67、69](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/cpp/core/environ/CMakeLists.txt#L28-L69) 编译 cocos2d/MainScene.cpp，排除了 win32/TVPWindow.cpp 和 WindowFormUnit.cpp；WindowImpl.cpp:1127 实际调用 TVPCreateAndAddWindow，后者在 MainScene.cpp:2882 构造 TVPWindowLayer。因此不能把该仓库保留的 Win32 文件写成 Web 移植正在使用的后端。

本地活跃 [MainScene.cpp:1575–1717](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/cpp/core/environ/cocos2d/MainScene.cpp#L1575-L1717) 同样区分用户关闭与程序关闭；程序关闭非模态窗口通过查询后失效对象，模态分支直接设置 mrCancel。[ShowWindowAsModal:912–939](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/cpp/core/environ/cocos2d/MainScene.cpp#L912-L939) 则显示并置前，在本窗口仍是 current 且结果为零时循环绘制、处理输入，应用终止时取消。这是该适配层的具体循环，不等同于已经核对 VCL 的全部模态行为。

本地 [SysInitImpl.cpp:381–415](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/cpp/core/base/impl/SysInitImpl.cpp#L381-L415) 省去了宿主 MainForm 可见性条件；[System.exitOnWindowClose](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/cpp/core/base/SystemIntf.cpp#L392-L404) 可修改退出开关。建议本项目正常播放采用这个可配置政策：默认主窗口注销退出；设为 false 后其他窗口继续，主窗口查询为 null，直到注册列表清空后新建窗口才成为主窗口。此为待实现的 Web 宿主选择，不把它描述成全部原生平台一致的行为。

## 组件边界与实施顺序

下表省略路径的重复前缀：所有文件均位于本项目 `src/`，其中 `scene/`、`tvp/`、`input/`、`ports/` 均指 `src/engine/` 下的目录，单独的 `session.ts` 指 `src/engine/session.ts`。

| 次序与责任        | 具体文件                                                                                                                                                                                                     | 必须完成的改动                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 引擎登记与状态 | `src/engine/scene/windows.ts`、`scene/window.ts`、`tvp/window.ts`、`tvp/system.ts`、`session.ts`                                                                                                             | 分开注册窗口、mainWindow、输入活动窗和 surface；按窗口保存 dirty、view revision、resizePending、指针与图形状态。保留弱 owner、早期注销与可重试清理。实现 exitOnWindowClose 及用户关闭／脚本 close 的区别，移除当前 close 无条件 System.exit 的处理。                 |
| 2. surface 与呈现 | `src/protocol/session.ts`、`player/session-client.ts`、`player/create-session.ts`、`workers/session.worker.ts`、`engine/ports/graphics.ts`、`backends/render/webgl2/renderer.ts`、`engine/scene/composer.ts` | 增加 request／attach／detach 协议和 RendererRegistry；每个窗口独立 Renderer。Session 遍历所有窗口待绘制根；复用 composer.frame 的 windowId 过滤；转场时钟每帧只推进一次，保留阶段 045 每层 redraw 期限与公平性。                                                     |
| 3. 输入与所有权   | `src/engine/input/controller.ts`、`input/service.ts`、`scene/layer-objects.ts`、`scene/transitions.ts`、`backends/input/browser.ts`                                                                          | 每个 LayerManager 保存 focus/modal/capture/hover/touch 状态；操作 token 固定携带源 Window/manager。一个 BrowserInputCoordinator 排序跨窗激活和物理按键，每窗保存坐标转换、textarea 与 IME 定位。Layer 按实际 manager 所属窗路由，不能使用 action-owner Window 代替。 |
| 4. 窗口宿主       | `src/player/create-player.ts`、`app/app.ts`、`app/styles.css`，新增 `app/game-window.ts`                                                                                                                     | 每窗 DOM 组件拥有标题、边框、菜单、canvas、视频层和输入节点。应用 left/top、尺寸约束、borderStyle、stayOnTop、focusable；脚本几何与用户拖动/resize 双向同步，CSS 自适应缩放不反馈成逻辑 resize。                                                                     |
| 5. 菜单与模态     | `src/engine/scene/menus.ts`、`scene/menu-items.ts`、`app/game-menus.ts`、`app/game-fonts.ts`、`engine/tvp/window.ts`                                                                                         | 菜单根和快照按窗索引；快捷键只进活动窗，popup 带来源和请求身份，组件销毁移除全局监听。字体选择记录来源并正确恢复焦点。showModal 另建可处理输入的合作式模态操作与栈，保留正常/异常/停止的退出路径。                                                                   |
| 6. 视频与全屏     | `src/engine/media/videos.ts`、`ports/video.ts`、`backends/video/browser/host.ts`、`player/create-player.ts`、`app/game-window.ts`                                                                            | 一个视频端口分发器管理每窗 plane/view/observer，open/set/回包携带目标身份。页面内全屏由唯一协调器选择窗口，菜单、视频和 IME 随窗进入/退出；关闭只清理本窗媒体。音频与 PageActivityMonitor 继续会话共享。                                                             |

协议身份至少包含会话 generation、windowId 和 surfaceEpoch；快照返回窗口列表与活动窗口。TJS 可在同一脚本中创建后立即销毁 Window：连接 surface 前保留最新状态和脏帧，晚到 attach 或媒体回复必须丢弃。surface 连接使用独立传输入口，不排在等待它的 VM 操作之后。DOM 和 Renderer 不增加 TJS 强引用。

现有单 Renderer 的纹理清理会删除本帧未出现的纹理，不能轮流提交两个窗口帧。每窗复用 WebGLRenderer 的代价是多个 context，需设置资源预算。首轮可保留既有图形故障导致会话暂停的策略，但状态必须按窗聚合，其他窗口的 ready 不得解除尚未恢复的故障；后续只暂停坏窗呈现属于另一项政策变更。

输入不能只复制 BrowserInput：独立发送队列会反转跨窗 deactivate/activate，旧窗发送空 keyState 也会清空新窗按键。InputService 当前在恢复回调时把 target=0 解析到全局 active，必须改为操作自身的窗口。窗口创建只安排 capture release，不应清空其他窗口的 focus/modal；阶段 044 的 manager/role 强引用继续按角色释放。

showModal 不能实现为占住串行 VM 队列的普通 await，再把关闭输入排在队尾。需要在调用者尚未返回时，通过现有 VM 可调用边界合作地推进允许的事件；不得从 JS 宿主导入重入正在执行的 VM。嵌套模态、计时器/转场是否可继续、异常和 System.exit 的展开顺序必须单独检查并测试，首个多窗口交付不宣称此部分完成。

当前 fullScreen 仅是 CSS fixed 呈现，没有调用 Fullscreen API。首轮沿用页面内模式并明确唯一所属窗；真正浏览器全屏是后续适配，必须处理请求结果和退出通知。菜单、视频、IME 与指针坐标均使用所属窗口的变换。

## 首个完整交付与验收

首个交付合并上述 1–4 的必要路径：同一 VM 创建 A/B，两窗同时可见并独立绘制、接受鼠标/键盘、改变尺寸、隐藏/再显示；用户关闭副窗可重开，脚本 close 只销毁该副窗。待这一流程具备真实浏览器验收后才解除第二活动窗口的构造保护。菜单、完整模态、视频与全屏仍按 5–6 继续，未完成前不得宣布完整多窗口或非插件目标完成。

全部构建、类型检查、测试与可执行探针只在 GitHub-hosted Actions 执行，计划新增 `tests/integration/multiwindow.test.ts`、`tests/browser/multiwindow.spec.ts` 与 surface 生命周期用例，复用已有 Window/Input/Video lifetime helpers。验收须覆盖源码/字节码、Asyncify/JSPI 和现有三浏览器矩阵：

- A/B 使用不同尺寸、颜色、caption、zoom、visible，持续 onPaint/转场互不覆盖；A 高频更新不饿死 B，B 纹理不会被 A 的 present 清除。
- 延迟 attach、创建后立即 invalidate、清理失败重试、关闭后替代窗口、晚到输入/视频回复均无幽灵 DOM 或串窗；stop 后 canvas/input/planes/renderer 全部释放。
- A 捕获后拖进 B 再释放仍投 A；切换活动窗后键盘/IME 投 B；A 异步回调期间切换 B 保持激活顺序，关闭 A 不清 B 按键；每窗 focus/modal 强引用独立回收。
- 两窗 resize 独立合并通知，非活动窗口也能调整；移动/缩放后菜单和 IME 位置正确；用户关闭副窗只隐藏，脚本 close 失效，否决查询与显式 invalidate 的路径分开。
- mainWindow 不随焦点变化；exitOnWindowClose=false 时注销主窗不提升仍存在的副窗；退出开关为 true 时执行正常会话终止和全部资源清理。
- 完整交付再验证：同快捷键只触发活动窗；模态等待期间能处理关闭且正常/异常展开；两窗 overlay 视频独立布局，关闭 A 不停 B 视频和音频；全屏切换/退出恢复布局与焦点；页面隐藏/冻结统一暂停并清理瞬态输入。
- 回归阶段 044–047 的弱登记、角色所有权、失效重试、redraw 公平性和像素；新增图形丢失/恢复的窗口身份检查，协议版本变更覆盖旧页面/新 Worker 拒绝及离线升级。

本文件没有新增通过结果；阶段 046/047 的独立 CI 状态继续以各自记录为准。

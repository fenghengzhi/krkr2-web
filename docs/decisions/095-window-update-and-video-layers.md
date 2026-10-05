# 095 同步窗口更新与视频图层路由

状态：开发候选，尚未取得本批托管执行结果。上一轮 094 已完成 56 个文件的实现、提交与推送，是实际进展；本轮从干净的 `e34fd19` 继续完整非插件目标。会话协议 **35**、TJS ABI **5**、字体 ABI **2** 不变。

所有测试、构建、类型检查、浏览器及原生可执行探针只在 GitHub-hosted Actions 运行。本地仅源码检查、编辑及历史原始产物下载、解包、哈希核对与解析。运行结果按每轮固定快照回收，不实时轮询；未执行、跳过、崩溃和未报告都不计为通过。

## 固定证据与构建修订

本轮各查询一次 092／37292345654、093／37296239220、094／37312988058 的 run、jobs、artifacts，随后只处理冻结清单的原件。092 与 093 终态均为 failure；094 快照仍 in_progress，build 已失败，后续 Node／浏览器／runtime／compatibility 与堆诊断没有执行。

共保存 **59/59 原 ZIP、629,278,564 字节**：24 旧包重新哈希、35 新包下载，全部 API SHA-256／大小匹配。总表为 `out/verification/github-actions/095-archive-summary.json`，每次运行的 `095-final-summary.*`／`095-snapshot-summary.*` 保存完整清单、子项与未报告范围。

| 范围 | 092 | 093 | 094 固定快照 |
| --- | --- | --- | --- |
| jobs | 16 success、9 failure | 18 success、9 failure | 6 success、1 failure、6 skipped、2 running |
| 原 ZIP | 25／308,296,529 字节 | 27／317,633,851 字节 | 7／3,348,184 字节 |
| Node 子项 | 3,105 pass、4 failure | 3,042 pass、2 failure、74 未报告；另 3 整文件崩溃 | 构建失败后未执行 |
| 浏览器 | 2,305/2,366 expected、61 unexpected | 2,341/2,393 expected、52 unexpected | 构建失败后未执行 |
| 兼容 | 95/96 | 96/96 | 未执行 |

093 共享 GPU 的旧多窗口 **36/36**、八窗 fallback **12/12**、CSS 光标 **12/12**、普通 popup **24/24**、原生活动 **11/11** 有通过报告。八窗退休组 12 项仍在旧夹具 `0,1` 对 `0,0` 处失败，后面的恢复断言不能算通过；094 已加入显式 root 登记，但尚未执行。原 region 主图层透明度 Node 夹具修订在 093 通过。

双 Windows 的 183 光标样本 strict 仍各 **536/596 matched、60 failure、3,178 uncompared**，mask 各 **3,770/3,770**。093／094 四份 User32 几何包均完整记录 24 配置／960 测量且清理成功，仅证明自有 User32 窗口的矩形观测，不证明 VCL 属性保留、约束或滚动语义。094 两个光标作业仍 running 且无 ZIP，下轮补取。

094 的六条 TypeScript 错误全部来自新测试：`browser-input-coordinator.test.ts` 的两处 move 坐标缺少判别收窄，`window-geometry-browser.ts` 的四处浏览器观察器类型转换需要经过 unknown。本批修正这些错误；这只是构建候选修订，不证明 094 的窗口、时钟、VFR 或堆诊断已经通过。原 build.log 和 ZIP 保留。

093 Node 计划 3,118 个子项，其中 3,042 通过、2 个 fullscreen 子项失败、74 未报告；另有 3 个整文件崩溃。两个 SIGTRAP 在 `WasmImportWrapperCache::Free`／`UnregisterAllocation`，一个 SIGABRT 的分配栈已在 Liftoff 编译器。该证据不证明产品写坏了宿主堆，也不证明 Liftoff-only 能规避问题。094 的有界双模式诊断继续保留，等待实际执行；旧 core 哈希／backtrace 不冒充缺失的 core 原件。

## 窗口同步更新

固定 KRKR2 `WindowFormUnit::UpdateWindow` 先登记曝光，再同步交付全局窗口更新队列。`EventIntf` 对普通入队去重，交付期间同一窗口最多出现两条，并禁止队列递归交付。`Layer::BeforeCompletion` 消耗已有的 callOnPaint；单纯曝光不会凭空制造 onPaint。

候选实现把 `Window.update()` 接入真实绘图完成路径，在后续 TJS 语句前处理待绘制回调与提交，保留窗口队列顺序、重入边界、失效及异常清理。图层写入、视频帧和转场按实际所属窗口登记更新；不会借更新一个窗口执行无关窗口的任意绘图回调。`onResize` 的默认实现也补上原版 action 转发。

普通绘图与显式 update 共用队列和递归保护，均允许同一轮的第二条窗口更新；超过两条的持续请求沿有界 16 ms 调度进入下一轮。先前 Layer redraw 夹具将每轮固定一次写成期望，与新确认的固定原版队列不符，本批修正次数并延长连续请求库存，保留暂停、后台、挂起、旧唤醒和取消断言。旧通过记录不被覆盖，也不据它继续保留已经确认不同的生产行为。

原版绑定实际检查第二个参数存在且非 void 才转换第一个 update 参数，而 Form 本身未使用转换后的类型。本批按固定源码保留此边界，不凭文档猜测 utEntire 的额外效果。普通调度与显式更新的队列行为、连续请求和暂停／停止仍需本批托管验收。

直接 host present 只展示当前快照，不消费尚未交付的窗口队列；闲置会话的外部曝光通过现有检查点唤醒。隐藏／脱离／收缩到零前的可见区域也登记旧窗口，尺寸无变化不会凭空排队。转场 phase 的计算只更新当前帧，不给自己制造第二次 tick；真正 begin／remove／exchange 曝光仍入队。固定五份原源的路径、SHA-256、URL 和相关行号保存在 `out/verification/window-update/095-source-manifest.json`。

## 视频 layer 模式的真实对象语义

原 `VideoOvlImpl.cpp:510–596` 区分两套状态：layer 模式的 `setPos`／left／top 直接改变绑定 Layer；width／height／setSize／setBounds 不修改图层，setBounds 连位置也不改变。公开 left／top／width／height getter 始终读独立 overlay Rect，这一点由固定 `VideoOvlImpl.h:94–105` 确认。其他模式的组合方法现在一次提交整个矩形，避免通过连续单属性 setter 产生中间状态。

visible 使用原版布尔转换，包括非零实数与非空对象。未打开或关闭媒体图时只保存 Video 的 Visible 成员；打开本身不把旧值重放给图层。图已打开时依次更新 Layer1 与 Layer2。第一槽引发同步 blur 后，第二槽重新读取绑定和当前 Visible 成员，因此回调可以重绑定第二槽、改变 visible 或失效 Video；后续操作不能使用提前复制的旧绑定或旧可见性。位置方法的数值参数则保持调用时的值。

`VideoOvlIntf.cpp:791–878` 的绑定检查使用真实 Layer native instance，没有同窗限制。本批改用原生身份校验，允许把视频图像和几何路由到另一窗口的图层，并拒绝只伪造 `__id` 的对象。输入重查、焦点和绘图失效仍归实际图层所属窗口。绑定为弱观察；Layer／Video 退休不会被额外持有。关闭媒体图不清除仍存活图层的最后像素，窗口退休后外部存活图层的位置仍可修改。

原件固定在 KRKR2 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable 分支。新增头文件原件及 SHA-256 在 `out/verification/video-tracks/reference/095-layer-geometry-manifest.json`；既有 cpp 原件与哈希不覆盖。此次不宣称全部视频 prepare／无绑定回调／旧编码语义已闭合。

## 播放中的 seek 完成条件

093 的真实媒体事件确认：请求跳转到 2 秒后，WebKit 多项、Chromium 两项在 seeked 时已到 2.002–2.011 秒，readyState=4、seeking=false，却因代码要求与目标相差不到 1 微秒一直等待，甚至播放到 EOF。其时只有原视频，还没有创建换轨候选，不能归因候选图像比较。

本批在播放中的 seek 等待解码就绪、seeking=false 且时钟已到达目标；暂停状态仍要求精确时钟。既有真实音轨、数值、像素和资源释放断言保留。

另有 9 项已创建两个暂停图的换轨等待。源码确认：旧 graph 的 rVFC 字段可能早于最新 seek，而换轨把这个历史时间与当前 drawImage 像素配对，误当成同一帧身份。5 个 Chromium 案例的原 pause 事件仍带 0.333–0.583 秒历史时间、时钟已约 2 秒，直接支持这一时序风险；旧附件没有记录生产字段，不能把 9 项全部归为同因。分层原证据与 SHA 在 `095-video-two-graph-audit.json`。

候选移除这个非原子历史 ordinal 前置门槛：实际 seek 后仍必须取得候选自身的新 rVFC 和 seek 完成，再重读完整 RGBA 逐字节比较，同时维持暂停时钟 1 微秒限制。无距离替换利用候选自身已完成的首帧，仍比较完整图像，不等待不会发生的 seek。旧历史时间仅进入失败诊断；有界记录保留候选 request／presented／seeked 顺序与实际状态。已有末像素单字节破坏验收保留，不能用首像素或条码阈值代替完整图像相等。

新增每浏览器 8 个编号视频换轨定义，覆盖普通与 interleaved MP4、源码／字节码、Asyncify／JSPI，在零位置和 frame 10 往返换轨，分别比较全部解码 RGBA 与实际画布截图解码后的全部字节，核对暂停时钟、真实媒体资源和最终清理。原 36 项音轨／音量／循环场景不改数值阈值。新增验证仍未执行，不把候选修订写成 9 项失败已经修复。

## KAG 手柄夹具

092 Firefox Asyncify 的旧失败原样保留。真实 production getGamepads 记录证明，第一笔右键被保持 11 次采样、跨度 530 ms；原版默认重复延迟 500 ms、间隔 30 ms，此时正好产生第一次重复。Playwright 在观察原 KAG 日志后继续跨进程查询才释放设备，延长了按住时间；末尾三个按键状态实际已正确归零，并非 stuck key。

候选夹具在页面观察到指定原始日志后立即把注入设备置为 neutral，随后仍要求真实 production sampler 读到同一释放 epoch。游戏脚本、原 KAG 方法、生产采样与默认重复策略不变，所有原严格链接索引／按下／释放／像素断言保留。证据在 `out/verification/gamepad/095-kag-repeat-evidence.json` 与审计文档，原 KAG 文件 SHA 继续核对。

## 验收与剩余工作

本批新增 **40 个 Node 定义**：窗口更新 2 个队列定义与 24 个真实源码／字节码定义，视频图层路由 14 个真实源码／字节码定义。新增**每浏览器 12 个定义**：视频几何 4 个、完整图像换轨 8 个。旧跨窗拒绝夹具按固定原版源码修正为跨窗图像路由验收；既有 redraw／fairness 的 32 个定义保留，更新原版两次交付后的计数与持续请求库存。所有本批定义待托管执行，静态审查不能代替执行结果。

完整非插件目标保持 active。下一轮取回本批结果并补取 094 未完作业；窗口几何／公开媒体时钟尚未经过 094 应用门禁，原生光标差异、宿主崩溃、部分换轨等待、旧编码以及更多真实游戏兼容仍未闭合。

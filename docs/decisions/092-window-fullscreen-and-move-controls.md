# 092 全屏 Window 写入限制与拖动期间的宿主控制

状态：开发候选，尚未取得本批执行结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器。协议 **34**、TJS ABI **5**、字体 ABI **2** 保持。上一目标轮完成 091 的 24 文件实现、提交、推送及运行身份保存，属于实际进展；本批先重新核对干净工作树，再回收固定证据并继续实现。

已整批推送 **15 个文件**，精确提交 `6ca5bcd5dfc5025ba778f5ccc86ec6ab66680e96`，对应 [Full test suite 37292345654](https://github.com/fenghengzhi/krkr2-web/actions/runs/37292345654)。首次唯一查询只确认运行与提交身份，当时 **pending／conclusion=null**，没有查询实时 jobs／artifacts。原响应保存为 `out/verification/github-actions/37292345654/initial-run-discovery.json`；本段以 `[skip ci]` 文档提交保存。下次先补取 091 终态和新增产物，再回收本批固定快照，尚无本批通过结论。

所有测试、构建、浏览器和原生探针仅在 GitHub-hosted Actions 运行。本地只读写源码、处理历史原始证据和进行 Git 操作。每批推送后，下次取回结果，不实时监控；历史失败、取消和未报告范围保留。

## 已回收的固定证据

对 090 和 091 的 run、jobs、artifacts 端点各仅请求一次，按当时清单归档 **32/32 原 ZIP、285,535,435 字节**，全部核对 API SHA-256 和大小。7 个旧包重新核对、25 个新包下载；没有刷新运行中的作业。

| 范围 | 090／37285720064 | 091／37289840732 |
| --- | --- | --- |
| 精确提交 | `9859a266ad69f8d77cc2aef0439b07d9859e6384` | `e054e6b48ca12c47e1c18b31373d16f3a02ec1bf` |
| 运行快照 | completed／failure，16 jobs 成功、9 失败 | in_progress／null，5 jobs 成功、19 运行 |
| 原 ZIP | 25／262,122,952 字节 | 7／23,412,483 字节 |
| 构建 | 成功，零 TypeScript 诊断 | 成功，零 TypeScript 诊断 |
| Node | 3,075 通过／3,081，6 失败 | 未报告 |
| 浏览器 | 2,252 expected／2,291，39 unexpected | 全部未报告，包括新视频校准 |
| 兼容库存 | 95／96 | 未报告 |
| 直接运行时 | 六组均通过 | 未报告 |

090 的六个 Node 失败全部是 region 夹具的范围错误／故障 Session 复用，091 已投修订尚待结果。090 的十个 beginMove Session 定义和六个内嵌 XP3 Session 定义通过；新增四个内嵌 XP3 浏览器定义在三浏览器共 **12/12** 通过。窗口移动浏览器已由上一轮 36 个失败降至 12，剩余均停在最后的 Stop 步骤。

39 个浏览器失败分别为音轨／视频 25、窗口移动 12、WebKit CSS 光标 1、WebKit piledCopy 启动前 Page crashed 1。后者保存了一份 WebContent 原生 IPS（EXC_BAD_INSTRUCTION／SIGILL，faultingThread 14）；四个 crash manifest 合计一份报告，未符号化帧不能证明产品根因。Firefox kag-help／asyncify 在截图阶段超过 5 秒，使兼容库存为 95/96；原失败保留。

摘要、完整步骤状态及错误位于各 run 目录的 `092-final-summary.*`／`092-snapshot-summary.*`、`092-review-archive-inventory.json`。091 清单只含构建、JSPI allocator、可信生命周期、双 Windows beginMove 和 Windows 2025 光标；Asyncify allocator、Windows 2022 光标及全部应用验收都未报告。

## 全屏公开写入边界

固定 KRKR2 2.32stable 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 WindowImpl 定义：全屏时，visible、外框宽高／位置、min/max 宽高、innerSunken、客户区宽高及 borderStyle 的公开 setter 抛错；setSize、setInnerSize、setPos、setMinSize、setMaxSize 具有同样限制。同值赋值也先检查全屏。根 MenuItem.visible 转发到 Window 菜单栏并受限，普通子菜单和未挂接菜单不受此限制。

本批在公开脚本入口加入检查，保留内部 WindowState.set／resize 供宿主退出、布局和回滚使用。caption、stayOnTop、showScrollBars、focusable、useMouseKey、trapKey、图层位置、zoom 等仍保留各自原有写入。五个成对方法直接进入对应宿主操作，并在取参数／执行之前检查参数数量，避免经可被脚本覆盖的其他方法或属性间接调用。

原生用户关闭非主窗口直接隐藏 Form。TJS 默认 onCloseQuery 现在走内部 userHide，复用已有输入、菜单、光标和窗口激活副作用，避免经过新加的公开 visible 限制。脚本 close 仍失效对象；主窗口关闭遵守既有退出策略。

新增 **12 个真实 Session 定义**，源码／字节码验收覆盖 33 次受限写入、同值写入、允许属性、根与普通菜单区别、内部宿主路径、关闭拒绝／接受／重开、受管理对象生命周期和五个方法的参数优先级。受限操作的实际函数体进入字节码夹具。八个浏览器定义通过实际菜单进入全屏，确认错误不改变几何或菜单，实际退出后恢复可写，并用真实窗口关闭按钮验证非主窗口保留对象、主窗口失效。本批定义尚未执行。固定原版来源及合同见 `out/verification/window-fullscreen/research.md` 与 `source/manifest.json`。

## beginMove 期间的 Stop

090 剩余 12 个窗口移动失败均已完成真实拖动、Escape 回滚、响应式画布大小和提交位置断言，然后在仍按住指针时用 HTMLElement.click 激活真实 App Stop 按钮。12 秒内状态一直为“运行中”；最后清理释放指针后普通 Stop 可以完成。全部原始错误与 test.trace 中的调用保存在 `092-begin-move-stop-evidence.json`，源码解释见 `092-begin-move-stop-analysis.md`。

原因是 beginMove 在 window 捕获阶段无条件拦截兼容 click，外部 App 控件也无法收到事件。本批将鼠标兼容事件消费限定到游戏 stage 中的目标，以及挂在 body 上、归属于当前活窗口的游戏菜单 overlay，继续阻止游戏 Window／canvas／菜单收到这些事件，同时允许外部宿主控制通过正常停止路径取消挂起脚本。实际 pointer 捕获、拖动、结束与 keyup 的拦截保持原语义，没有制造额外 commit。

新增独立宿主浏览器场景：真实按住鼠标进入移动后，游戏窗口关闭和真实 createGameMenus 生成的 body 菜单点击仍被拦截，外部控制可以终止移动且不伪造结束回报。原 12 个完整应用断言保持，必须由下一次 Actions 结果证明修订有效。本批合计新增 **12 个 Node 定义、每浏览器 9 个定义**。

## 光标与剩余窗口几何

090 双 Windows 以及 091 已发布的 Windows 2025 原生结果一致：155 个样本全部观察到，严格加载 **485/512 matched、27 failures、2,758 uncompared**，mask **3,770/3,770**；portable 仍为 partial 173/173。旧 125 个样本的严格比较已无失败，27 个差异全在新增的 80×80 五个色场、127×255 四个色场的三个背景。

这些是固定 Windows 2022／2025 runner 配置下的 User32 文件加载与完整像素比较，不扩大为所有 DPI、系统配置或原版 KRKR2 二进制已经等价。

十个相关完整颜色平面中，已在托管端执行的中心映射／顶向下／绝对 f64／最近点候选全部零差异，Q16 平滑路径在九个色场有大量差异，表明大幅缩小时存在分支选择。两运行三份产物的 source／color 哈希和指标一致。当前证据尚不能确定单轴、双轴、2 倍边界或 alpha 的条件，本批保留生产缩放规则，追加托管临界尺寸矩阵；原失败与全部候选保留。分析见 `092-cursor-holdout-analysis.json`。

新增 **28 个原生样本，总计 183**：63／64／65 双轴笛卡尔组合在零 alpha／独立 alpha 各一次（18），80×48、48×80、80×13、13×80 各两种 alpha（8），原 80×80 与 127×255 不对称色场另补 alpha 对照（2）。原 155 样本的身份、顺序和字节不变，288 个候选及 3,770 个 mask 比较保留。新增 CUR 共 549,044 字节，尚未在托管端执行；库存与分析见 `092-cursor-analysis.md`。

外框与客户区的完整模型仍未实现。固定源码确认 inner=Form.Client−(sunken?4:0)，zoom 改变 PaintBox 而不是外框，showScrollBars 作用于内部 ScrollBox，最后一次 inner 请求还有独立保存值。标题、边框、菜单高度需要宿主实际测量，不能把某个 DFM 的设计尺寸当通用 Win32 常量。五种矩形、测量往返与独立原生证据需求已记录于 `out/verification/window-geometry/092-outer-client-audit.md`，本批全屏限制不冒充完整几何实现。

091 媒体校准尚未发布，本批未放宽视频等待谓词或追认换轨通过。公开视频时钟／帧号、复杂窗口几何、剩余光标差异、旧编码、其他非插件 API 及实际游戏流程仍在完整目标内。

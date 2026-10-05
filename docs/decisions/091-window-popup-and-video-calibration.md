# 091 窗口弹出通知与视频呈现校准

状态：开发候选，尚未取得本批执行结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器。会话协议升至 **34**，TJS ABI **5**、字体 ABI **2** 不变。所有可执行验证只在 GitHub-hosted Actions 进行；较大批次推送后，下次工作时回收固定快照，不实时监控。

上一实现批次 090 完成源码、测试、提交与运行身份保存，属于实际进展。随后回答整体目标的对话没有改变实现状态；本次重新检查工作树后继续完成 091 的窗口功能、历史失败修订和独立媒体取证。

## 固定快照与历史结果

每个运行的 run、jobs、artifacts 端点各只取一次。冻结清单合计 **32/32 原 ZIP、312,807,994 字节**，全部核对 API SHA-256 和大小；11 个旧包重新核对、21 个新包下载。原快照、失败与未报告范围保留，没有刷新运行中的作业。

- [089／37282816379](https://github.com/fenghengzhi/krkr2-web/actions/runs/37282816379)，提交 `34c91a0093706c3e4bb0cbf417d41db45abfe434`：**completed／failure**，25 jobs 中 17 成功、8 失败；25 ZIP、302,244,846 字节。Node 完整 TAP **3,056 通过、8 失败／3,064**，无取消或跳过；11 份浏览器报告合计 **61 unexpected**。兼容库存 **96/96**，其中原 KAG 的 Firefox 光标确认／释放步骤也已通过；这个专项结果不覆盖失败的应用测试。
- [090／37285720064](https://github.com/fenghengzhi/krkr2-web/actions/runs/37285720064)，提交 `9859a266ad69f8d77cc2aef0439b07d9859e6384`：**in_progress／conclusion=null**，24 jobs 中 6 成功、18 运行；7 ZIP、10,563,148 字节。构建成功且无 TypeScript 诊断，双 allocator 各 60/60、可信生命周期 7/7、双 Windows beginMove 各 7/7。固定清单没有 Node、光标、浏览器、runtime 或 KAG 结果，内嵌 XP3 与 155 样本 Q16 修订均仍未报告。

完整原始清单与摘要保存在各运行目录的 `091-review-archive-inventory.json`、`091-final-summary.*`／`091-snapshot-summary.*`。089 的 61 个浏览器失败为视频音轨 24、窗口移动 36、WebKit CSS 光标 1。090 已投的窗口捕获／坐标／单行表达式修订尚无本次结果，不将历史失败追认为通过。

## Window.onPopupHide

依据固定 KRKR2 2.32stable 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [WindowFormUnit.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp) 与 [WindowIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp)：

- 入队按 Window 注册顺序逆序，选择可见、不可聚焦且置顶的窗口；在这种弹出窗口内部点击不广播。
- 普通窗口的客户区鼠标按下、左右非客户区按下、系统按键以及应用失活触发通知。系统键通知先于 trapKey 路由；useMouseKey 生成的鼠标按下经过相同路径，脚本 postInputEvent 则绕过 Form 转换。
- 每次通知独立排队，不合并。真正交付时重新检查窗口有效、可见和模态可用；入队后改变 focusable／stayOnTop 不撤销已投事件。
- 默认事件把 type／target 交给 action，是否隐藏由脚本决定。System.eventDisabled 已开启时新排入的非丢弃事件会保留；若前一个回调在已经开始的派发轮中开启禁用，原生 input 队列仍继续取出事件，但其即时脚本通知被丢弃。这两个边界分别覆盖。暂停或冻结不重入 VM，Stop 结算并清理待处理事件。

本批接通 TJS 默认事件、Session 事件收据、Worker RPC、页面窗口外框与应用焦点观察。application 消息用状态转换去重 blur／hidden，并由重新可见、获得焦点或真实窗口输入恢复。系统键前置通知使用原 KeyboardEvent 的身份标记；菜单快捷键先等待该通知的入队确认，再发送点击，以免被菜单消费的 F10 越过通知。队列淘汰、窗口退休和停止都会结算这个确认。

本节固定源码、URL 和 SHA-256 保存在 `out/verification/window-popup/source/manifest.json`，完整逐行合同与 Web 适配边界保存在同目录上级的 `research.md`。页面外控件视为嵌入应用失活是明确的 Web 适配，不扩大为所有 Win32 系统键或任务切换行为已经等价。

新增 **16 个 Node 定义**：真实 Session 的七个场景各覆盖源码／字节码，另两个 Coordinator 定义检查菜单消费、入队确认延迟和窗口退休。新增**每浏览器 8 个窗口定义**，覆盖两后端／两入口的真实鼠标、外框、useMouseKey、Alt trap、F10 菜单、页面控件和另一个页面引发的失焦，保留被动事件与画面附件。这些新定义尚未执行。

## Window region 测试修订

089 的 Node 八个失败中，两个 beginMove 用例的 Session 故障复用已在 090 修订；本批修订另外六个 region 失败。

两个图像场景原先把 2×2 显示矩形移到 4×3 图像之外，违反既有有效范围。现在使用 `imageLeft=-2,imageTop=-1`，并直接断言这个非零位置，继续检验区域只来自原图像像素，保留原矩形和像素断言。其余四个失败是在预期未捕获脚本异常后继续复用已经故障的 Session；现在在 TJS 内捕获原错误，再继续验证原区域和生命周期。复杂度预算、无主图错误与停止取消断言均保留。

## 视频时钟与实际画面

089 的媒体附件显示三个不同问题：Chromium 普通 MP4 的第 10 帧换轨时，旧／新元素均为 0.833333 秒，公开时钟向下取帧得到 9，而呈现 PTS 判断得到 10；fragmented／interleaved 的 currentTime 约 2 秒时，回调为 2.166667 秒；Firefox 定位后会返回 1.322687 秒一类请求位置，不一定落在精确样本 PTS 上。完整解码附件保存为 `091-video-track-evidence.json`，不能把这些现象合并成一个浮点容差问题。

固定原版 `DSMovie` 的 MEDIA_TIME 路径也区分公开时钟与样本身份：设平均帧时长 A（秒）、当前位置 T／总时长 D（100 ns），公开 frame 为 `trunc((T/10^7)/A+0.5)`，SetFrame 请求 `trunc(A*10^7*f)`，position 为非负的 `(T+5000)/10000` 整数结果，totalTime 为 `trunc(D/10000)`，fps 为 `1/A`，帧数为 `trunc((D/10^7)/A+0.5)`。Layer／Mixer 继承这些方法，平均帧时长来自视频头；呈现事件另使用 sample media time，偏离公开时钟帧至少两帧时还会回退。

原始源码保存在 `out/verification/video-tracks/reference/win32/krmovie/`。当前生产的 CTS-floor 帧号、毫秒取整及以含偏移总时长计算 fps 尚未完整对齐，属于明确后续范围。首个 rVFC 不能证明所有后续回调都有固定偏移；readyState／seeked 也不能独立证明画面已更新，035 的历史 WebKit 证据仍有效。本批保持既有严格产品断言及首帧等待，新增托管呈现校准来记录可区分的真实画面，不凭时间戳放宽等待谓词。

托管生成器保留原四种容器，另生成 72 帧／12 fps 的独立编号 RGB 影片，每帧带七位黑白条码和两位数字，再封装普通、fragmented、interleaved、separate-fragments 四种版本。八个文件各由 FFmpeg 解码为 72 张完整 RGBA PNG，同时保存 ffprobe 逐帧时间、命令、原视频／原始 RGB／PNG 的 SHA-256，共 **576 张参考图**，随同次构建共享。

新增**每浏览器 8 个媒体校准定义**。各文件同时观察顺序定位和从新元素开始定位，涵盖初始帧、零点、样本间中点、历史失败请求 1.322687 秒、2 秒及尾部中点。记录事件、currentTime、rVFC 元数据、完整 RGBA 及其对全部 72 张参考图的距离和所有并列项；距离只供诊断，不据此声明产品帧正确。每次等待有界，无新回调仍保留实际像素并标记缺失；初始帧或画面不可用则保留失败。新元素读取同一个原容器，不等于音轨替换后生成的生产 MP4 variant；已有真实换轨严格测试继续负责那个范围。

本批合计新增 **16 个 Node 定义、每浏览器 16 个定义**，另修订已有 region／光标定义。没有本地测试、构建、类型检查或浏览器执行结果，本批通过状态仍未取得。

## CSS 光标与剩余范围

089 的 WebKit auto／1.5 仍有 15 个通道差异，集中在最后一行；12 个 padding／quality 组合都保留相同差异。独立解码四份原 PNG 与附件 RGBA 完全相同，排除了该 PNG 解码路径造成误差。2.25 倍两种 image-rendering 均为零差异；pixelated／1.5 的某些 padding 反而增加差异。

本批追加更大截图范围后按字节裁剪、整视口截图及设备像素观察，以判断截图边缘与 DPR 阶段的影响。原截图 oracle、严格零差异断言和生产采样方式均保留。原始分析见 `091-webkit-cursor-css-analysis.md` 和 `091-webkit-cursor-css-original-readings.json`。

窗口外框尺寸与客户区尺寸仍未区分完整；原版 innerSunken 的 4 像素客户区调整、边框重建和全屏公开 setter 限制已审计，但本批没有把任意 Win32 外框尺寸写入 Web 布局。后续还需区分脚本 setter 与内部用户关闭／恢复路径，避免全屏限制破坏内部操作。媒体公开时钟校准、旧编码、剩余原生光标差异、更多非插件 API 及实际游戏流程继续属于完整目标，当前不能宣称模拟器完成。

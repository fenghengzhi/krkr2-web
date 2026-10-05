# 插件以外的实现进度

整体目标：完成 KRKR2 Web 模拟器，先实现插件以外的功能，让游戏从资源加载、TJS／KAG 执行、画面与输入、音视频到存档和退出贯通运行。补齐接口之外，还要核对原版行为、处理失败与资源生命周期，并通过 GitHub-hosted Actions 的批量验证和真实游戏验收。当前目标未完成；各批次是这个目标的子任务，未报告、失败或取消的验证不能计为通过。

2026-10-06 准备 [102 原生栈池、系统生命周期与光标缩放边界](decisions/102-native-pool-and-system-lifecycle.md)：回收真实空闲寄存器块，补空闲／应用失活自动整理和完整无窗口启动条件；按双 Windows 的 323 样本原件修正固定 32px 光标的 66 像素分支。原版 Timer 退出夹具与 beginMove 前置同步也已修订，历史失败保留。协议 **40**、`nativeSystem:5`，TJS ABI **5**、字体 ABI **2**；候选仍待托管执行，完整目标保持 active。

102 固定回收 **15 原 ZIP、54,247,847 字节**全部匹配。100 终态 failure：旧两处类型错误导致应用验证跳过，光标 strict 各 **539/1016 matched、477 failure、5278 uncompared**。101 快照仍 in_progress，build 未报告；双系统原版退出各 **3/8 observed、5 failure**，五项均未到待观察终止调用；Win2025 beginMove 六 observed、一前置失败，未调用 SC_MOVE。下轮补取，不实时监控。以下保留历史批次当时状态。

最新待核验批次：[Full test suite 37348226922](https://github.com/fenghengzhi/krkr2-web/actions/runs/37348226922)，精确提交 `b592f70f576d8c110c03244be848aa24f4460ddb`。101 的 31 个文件已整批推送，新增 **34 个 Node、每浏览器 12 个定义，以及八场景 × 双 Windows 的原版退出观察**。首次唯一查询为 **in_progress／conclusion=null**，只确认运行身份。下轮补取 100 缺失结果并回收本批固定快照，不实时监控；没有本地执行验证，完整目标保持 active。

2026-10-06 准备 [101 System 消息、内存整理与退出语义](decisions/101-system-messages-compaction-and-termination.md)：直接更新原生 TJS 消息 holder；按等级释放可回收缓存并保留活动读者；区分异步 `terminate` 和即时 `exit`，另以固定原版 SDK 记录模态退出顺序。修订 099 构建中的两处拖放结果类型错误及 098 菜单输入夹具。协议 **40**、`nativeSystem:4`，TJS ABI **5**、字体 ABI **2**。本批仍待 GitHub-hosted 执行，完整非插件目标保持 active。

101 固定回收 **44 个原 ZIP、611,968,120 字节**，全部匹配 API SHA-256／大小。098 终态 failure：Node **3,287/3,293 pass、6 failure**，主浏览器 **2,210 pass、191 failure、86 未报告／2,487**；Chromium library 取消且没有测试库存，另记未报告。099 终态 failure：两处 TS18046 导致应用验证跳过。100 仍 in_progress，构建及 323 光标原件未报告；下轮补取，不实时监控。历史失败、取消和未比较保留。以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37344510171](https://github.com/fenghengzhi/krkr2-web/actions/runs/37344510171)，精确提交 `2a513d4eec3b1174d7da86ec8a1625bc1b8b9592`。100 的 42 个文件已整批推送，新增 **27 个 Node、每浏览器 20 个、可信 Chromium 4 个定义及 140 个原生光标样本**。首次唯一查询为 **queued／conclusion=null**，仅确认提交与运行身份；下轮补取 098／099 缺失结果并回收本批固定快照，不实时监控，没有本地执行验证，完整目标保持 active。

2026-10-06 准备 [100 应用激活事件、Layer 整组边界与回归修复](decisions/100-application-events-and-layer-bounds.md)：补齐真实应用失活／恢复的 System 回调；修正 Layer.setPos 的精确四参数和整组提交；播放中换音轨按冻结时钟及新呈现确认，暂停换轨仍比较完整像素；修正无 alpha 光标的 64→32 平均并追加 140 个原生临界样本。协议 **40**、`nativeSystem:3`，TJS ABI **5**、字体 ABI **2**。本批尚待 GitHub-hosted 执行，完整非插件目标保持 active。

100 固定回收 **25 个原 ZIP、338,511,765 字节**全部匹配。098 仍 in_progress：Node **3,287/3,293 pass、6 failure**，直接 runtime **6/6**、原 KAG **96/96**。仅已报告的 Chromium／Firefox shard 1 为 **1,176 pass、81 failure／1,257**，三份主分片和 Chromium library 未报告；缺失不能计为通过。099 为 pending、0 jobs／artifacts，尚无构建或功能通过结论。历史失败、取消和未比较保留，下轮补取，不实时监控。以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37340665748](https://github.com/fenghengzhi/krkr2-web/actions/runs/37340665748)，精确提交 `7351c9f2b0b311fef66c8edb229a356386c9a953`。099 的 43 个文件已整批推送，新增 **29 个 Node、每浏览器 16 个定义**。首次唯一查询为 **pending／conclusion=null**，仅确认提交和运行身份；下轮补取 098 后续原件并回收本批固定结果，不实时监控，没有本地执行验证，整体目标保持 active。

2026-10-06 准备 [099 Window 文件拖放与窗口回归](decisions/099-window-file-drop.md)：真实文件／目录能力经过 DOM FIFO、Worker 和 Session，投递逆序真实 TJS Array；新增会话只读资源树、空目录、按需归档、取消及容量预留。修复 popup 期间旧 mouseleave 覆盖新脚本光标，并校准历史窗口／像素夹具。协议 **39**，TJS ABI **5**、字体 ABI **2**。本批尚待 GitHub-hosted Actions 执行，整体非插件目标保持 active。

099 冻结回收 **37 个原 ZIP、858,611,351 字节**，全部 API SHA-256／大小匹配。097 终态 failure：Node **3,225/3,257 pass，32 failure**；主浏览器 **1,938 pass、379 failure、155 未报告**；原 KAG **96/96**、直接运行时 **6/6 failure**。098 的 run 返回 queued，分别取得的 jobs 包含 7 success、18 running、3 queued；build 已成功，主应用报告尚缺，保留非原子快照差异。下轮补取，不实时刷新；以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37335381893](https://github.com/fenghengzhi/krkr2-web/actions/runs/37335381893)，精确提交 `a9e3f97802392a374a9d07e5f5c6887fc30521a1`。098 的 63 个文件已整批推送，新增 **36 个 Node、每浏览器 5 个定义**。首次唯一查询为 **pending／conclusion=null**，仅确认提交和运行身份；下轮补取 097 后续原件并回收本批固定结果，不实时监控，没有本地执行验证，整体目标保持 active。

2026-10-05 准备 [098 按访问打开归档与回归修复](decisions/098-lazy-archives-and-regressions.md)：归档索引改为按访问打开、64 容器成功 LRU、完整 AutoPath 重建和异步目录选择；修复窗口清理读取已退休几何，以及同步更新／宿主 Pad 的重复画面提交。协议 **38**。所有新改动尚待 GitHub-hosted Actions 验证，整体非插件目标保持 active。

098 固定归档 **42 个原 ZIP、889,829,711 字节**全部核对。096 终态 failure：Node **3,194/3,226 pass，32 failure**；主浏览器 **1,962 pass、383 failure、76 未报告**；原 KAG **96/96**，直接运行时 **6/6 failure**。097 冻结快照 build success，主 Node／浏览器／兼容／runtime 未报告，不刷新实时结果。原光标严格差异、取消和历史崩溃证据全部保留。以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37329111623](https://github.com/fenghengzhi/krkr2-web/actions/runs/37329111623)，精确提交 `cd05a9dd73336a6467b993b96b29f529fd8e4313`。097 的 43 个文件已整批推送，新增 **31 个 Node、每浏览器 17 个定义**。首次唯一查询为 **in_progress／conclusion=null**，只确认提交与运行身份，未实时查看 jobs／artifacts。下一轮补取 096 主应用／光标等未报告范围，再回收本批固定结果。没有本地执行验证，完整非插件目标保持 active。

2026-10-05 准备 [097 项目目录、菜单光标与视频音频控制](decisions/097-project-menu-and-video-audio.md)：新增冻结项目目录与程序目录、绝对公开路径、项目独立存档身份和库恢复；菜单的默认光标覆盖与轮询门禁保持独立于脚本逻辑；视频接通原版衰减表、32 位写入转换以及固定版本 getter 行为。会话协议 **37**，TJS ABI **5**、字体 ABI **2** 不变，候选尚待托管执行，整体目标保持 active。

097 固定回收 **20 个原 ZIP、46,049,353 字节**，全部 API SHA-256／大小匹配。095 终态 failure，双 Windows 光标 strict 各 60 失败、3,178 未比较。096 快照仍 in_progress，构建成功；可信生命周期 **11/11**，Node 24.19 的 default／Liftoff-only 有界 Layer 诊断共 **120 次观察正常**，不代表完整 Node 套件或历史宿主堆故障已解决。096 主应用／原 KAG／直接运行时与光标原 ZIP 尚未报告，下轮补取，不实时刷新。以下保留历史记录。

最新待核验批次：[Full test suite 37322347188](https://github.com/fenghengzhi/krkr2-web/actions/runs/37322347188)，精确提交 `e5b393bc56ae023df1c26ca94ee90f80136ae0eb`。096 的 26 个文件已整批推送，新增 **33 个 Node、每浏览器 16 个定义**。首次唯一查询为 **in_progress／conclusion=null**，只确认运行身份，没有实时查询 jobs／artifacts。下一轮补取 095 缺失光标原 ZIP 和终态，再回收本批固定结果。没有本地执行验证，完整非插件目标保持 active。

2026-10-05 准备 [096 归档补丁、临时隐藏光标与视频状态生命周期](decisions/096-archive-cursor-and-video-state.md)：归档裸别名退出真实文件命名空间，原 KAG 的补丁自动路径、规范资源身份和存档覆盖接通；临时隐藏光标用真实屏幕位置及客户区移动恢复；视频图控制在关闭／重开时重置，对象矩形、可见性和循环保留。修复 095 两处 Layer 记录窗口字段类型错误。协议 **36**，TJS ABI **5**、字体 ABI **2** 不变。所有本批候选尚待托管执行，整体目标仍 active。

096 固定回收 **16 原 ZIP、36,296,641 字节**，全部 API SHA-256／大小匹配。094 终态 failure（6 success、4 failure、6 skipped），双 Windows 光标 strict 各 **536/596 matched、60 failure、3,178 uncompared**。095 快照仍 in_progress（6 success、1 build failure、2 cursor running、6 skipped），光标原 ZIP 尚缺。094／095 Node、浏览器、原 KAG 与堆诊断均因构建失败未执行；修复类型错误不等于功能已通过。下轮补取缺失结果，不实时监控。以下保留历史批次当时的记录。

最新待核验批次：[Full test suite 37318168828](https://github.com/fenghengzhi/krkr2-web/actions/runs/37318168828)，精确提交 `d287d06e9c6abdc6224a55a8f03b5b62710bfbe2`。095 的 22 个文件已整批推送，新增 **40 个 Node、每浏览器 12 个定义**。首次唯一查询为 **in_progress／conclusion=null**，只确认运行身份，没有实时查询 jobs／artifacts。下一轮补取 094 终态及光标原 ZIP，再回收本批固定结果；未本地执行验证，整体非插件目标保持 active。

2026-10-05 准备 [095 同步窗口更新与视频图层路由](decisions/095-window-update-and-video-layers.md)：普通／显式更新共用有序窗口队列，补 onResize 默认 action；视频 layer 几何直接作用真实图层，支持原版跨窗绑定与可见性回调重入；修正播放中 seek 等待时钟过度严格及 KAG 手柄夹具持键过久。修复 094 六条测试类型错误。本批尚待 GitHub-hosted 执行，协议 **35**、TJS ABI **5**、字体 ABI **2** 不变，整体目标仍 active。

095 固定回收 **59/59 ZIP、629,278,564 字节**，全部 API SHA-256／大小匹配。092 终态 failure，Node **3,105/3,109**、浏览器 **2,305/2,366**；093 终态 failure，Node **3,042 pass、2 failure、74 未报告**及 3 整文件崩溃，浏览器 **2,341/2,393**、兼容 **96/96**。093 多窗口 GPU 36/36、CSS 光标 12/12、普通 popup 24/24、原生活动 11/11 已报告通过；退休组和音轨切换仍失败。094 构建失败，应用验收与堆诊断被跳过；两光标作业无终态，下次补取。历史崩溃和未报告保留。

最新待核验批次：[Full test suite 37312988058](https://github.com/fenghengzhi/krkr2-web/actions/runs/37312988058)，精确提交 `0846cd31a04c72b5a370b2dfb3de2e6dcca47a8a`。094 的 56 个文件已整批推送，新增 35 个 Node、每浏览器 20 个定义；宿主堆对照另运行既有 20 定义 × 3 次 × 2 模式。首次唯一查询为 **in_progress／conclusion=null**，只确认身份，没有实时查询 jobs／artifacts。下次补取 092 缺失结果并回收 093／094 固定快照。未本地执行验证，整体非插件目标保持 active。

2026-10-05 准备 [094 窗口五矩形与媒体公开时钟](decisions/094-window-geometry-and-media-clock.md)：区分 outer／client／inner／viewport／PaintBox，独立 MessagePort 测量真实页面 chrome 和滚动条，接通输入／光标／IME／全屏实际缩放；公开媒体属性改用平均帧时钟，回调帧独立，新增真实 VFR 与宿主堆诊断。协议 **35**、TJS ABI **5**、字体 ABI **2**。本批尚待托管执行，完整非插件目标仍 active。

094 固定回收 **49/49 原 ZIP、575,013,476 字节**，全部 API SHA-256／大小一致。091 终态 failure，浏览器 **2,278/2,339**，历史 Node 崩溃和 11 未报告子项保留；092 仍 in_progress，Node **3,105/3,109**、浏览器已报 **1,977/2,024**，缺 WebKit shard 2，兼容 **95/96**；093 pending、0 jobs／artifacts。092 已报 Chromium／Firefox beginMove **24/24** 通过，双 Windows 183 光标 strict **536/596 matched、60 failure、3,178 uncompared**。未刷新运行结果，下次补取缺失部分；以下保留历史状态。

最新待核验批次：[Full test suite 37296239220](https://github.com/fenghengzhi/krkr2-web/actions/runs/37296239220)，精确提交 `68abdf4716d3116e8d2834280dbc9d6c5b1f3118`。093 的 25 个文件已整批推送，首次唯一查询为 **pending／conclusion=null**；只确认身份，没有实时查询 jobs／artifacts。下次补取 091 缺失结果并回收 092／093 固定快照。未本地执行验证，整体非插件目标保持 active。

2026-10-05 准备 [093 共享窗口 GPU、视频画面保留与独立几何证据](decisions/093-shared-window-gpu-and-video-handoff.md)：一个 Session 共用 GPU、各 Window 独立提交；换轨比较暂停时钟与完整 RGBA；CSS 光标增加一像素周边，以整视口字节裁剪核对。popup 真实失活迁入既有原生浏览器连接，新增双 Windows User32 几何观察。新增 9 个 Node、每浏览器 9 个定义及 4 个原生生命周期定义，几何每系统 24 配置／960 行，均尚待托管执行。协议 **34**、TJS ABI **5**、字体 ABI **2** 不变，整体非插件目标继续 active。

093 固定回收：091 仍 in_progress，24 jobs 为 16 success、6 failure、2 running；092 pending，0 jobs／artifacts。**24/24 原 ZIP、266,038,696 字节**全部核对 API SHA-256／大小。091 Node 计划 **3,097 = 3,084 pass + 2 failure + 11 unreported**，另有整文件 SIGABRT／堆损坏失败；浏览器十份报告 **1,957/2,005 expected、48 unexpected**，WebKit shard 2 缺失；兼容 **95/96**、runtime **6/6**。光标 155 样本 strict **485/512**，27 失败、2,758 未比；092 的 183 样本未报告。历史失败与原始证据保留，不实时轮询。以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37292345654](https://github.com/fenghengzhi/krkr2-web/actions/runs/37292345654)，精确提交 `6ca5bcd5dfc5025ba778f5ccc86ec6ab66680e96`。092 的 15 个文件已整批推送，新增 12 个 Node、每浏览器 9 个定义及 28 个原生样本尚待托管结果。首次唯一查询为 **pending／conclusion=null**，只确认身份，没有实时查询 jobs／artifacts。下次补取 091 终态和新增产物，再回收本批固定快照；未本地执行验证，整体非插件目标保持 active。

2026-10-05 准备 [092 全屏 Window 写入限制与拖动期间的宿主控制](decisions/092-window-fullscreen-and-move-controls.md)：接入原版 33 项全屏受限写入矩阵、内部关闭／退出边界，修正 beginMove 吞掉外部 App Stop 的事件范围，并将原生光标临界库存由 155 增至 183。新增 12 个 Node、每浏览器 9 个定义尚待托管执行，协议 **34**、TJS ABI **5**、字体 ABI **2** 不变，整体非插件目标继续 active。

092 固定回收 090 终态 **failure**：Node **3,075/3,081**、6 失败；浏览器 **2,252/2,291**、39 unexpected；兼容 **95/96**。新 XP3 六个 Session、三浏览器共十二个场景通过，beginMove 剩余 12 个失败均为最后 Stop，原光标 125 样本全部严格匹配，新增样本仍 27 差异。091 固定快照仍 in_progress，构建成功但全部应用验收未报告。两运行 **32/32 ZIP、285,535,435 字节**全部核对 API SHA-256／大小；历史失败与一份 WebKit 原生 crash 保留，下次补取 091 终态和新增产物，不实时轮询。以下保留历史批次当时的状态。

最新待核验批次：[Full test suite 37289840732](https://github.com/fenghengzhi/krkr2-web/actions/runs/37289840732)，精确提交 `e054e6b48ca12c47e1c18b31373d16f3a02ec1bf`。091 的 24 个文件已整批推送，新增 16 个 Node、每浏览器 16 个定义尚待托管结果。首次唯一查询为 **queued／conclusion=null**，只确认身份，没有实时检查 jobs／artifacts。下次补取 090 终态和新增产物，再回收本批固定快照；未本地执行验证，整体非插件目标继续 active。

2026-10-05 准备 [091 窗口弹出通知与视频呈现校准](decisions/091-window-popup-and-video-calibration.md)：接通 `Window.onPopupHide` 的逆注册顺序、投递时有效性、真实页面输入和应用失活通知；修订 region 测试的有效图像位置与预期异常处理，追加独立媒体画面及 CSS 光标取证。协议 **34**、TJS ABI **5**、字体 ABI **2**；本批尚待托管执行，完整非插件目标保持 active。

091 固定回收 089 终态 **failure**：Node **3,056/3,064**、8 失败；浏览器 **61 unexpected**，兼容专项 **96/96**。090 快照仍 **in_progress**，6 jobs 成功、18 运行；构建无 TypeScript 诊断，但 Node／光标／浏览器／runtime／KAG 未发布。两运行 **32/32 原 ZIP、312,807,994 字节**均核对 API SHA-256／大小，历史失败保留。下次补取 090 终态和后续产物，再取本批固定快照，不实时轮询。以下各段保留对应历史批次当时的状态。

最新待核验批次：[Full test suite 37285720064](https://github.com/fenghengzhi/krkr2-web/actions/runs/37285720064)，精确提交 `9859a266ad69f8d77cc2aef0439b07d9859e6384`。090 的 21 个文件已整批推送，新增 17 个 Node、每浏览器 5 个定义仍待托管执行。首次唯一查询为 **in_progress／conclusion=null**，没有实时查询 jobs／artifacts。下次补取 089 终态和新增产物，再回收本批固定快照；未本地执行验证，未合入旧 main，整体非插件目标继续 active。

2026-10-05 准备 [090 EXE 内嵌 XP3、原生光标与窗口捕获](decisions/090-embedded-xp3-native-cursor.md)：按原版 MZ／16 字节对齐扫描接入内嵌 XP3 的实际游戏加载、范围源和存档流程；依据两 Windows 的 41 个完整平面修订通用 Q16 步长；修正子画布捕获丢失误取消窗口移动。新增 17 个 Node、每浏览器 5 个定义尚待托管执行，协议 **33**、TJS ABI **5**、字体 ABI **2** 不变，完整非插件目标保持 active。

090 固定回收 088 终态 **failure**：Node **3,023/3,056**、33 失败；浏览器 66 unexpected，兼容 **94/96**。089 快照仍 **in_progress**，8 jobs 成功、2 光标失败、14 运行；build 成功，应用范围未报告。两运行 **36/36 原 ZIP、344,446,513 字节**均核对 API SHA-256／大小，原失败与快照保留，未实时轮询。下次补取 089 终态和后续产物。

最新待核验批次：[Full test suite 37282816379](https://github.com/fenghengzhi/krkr2-web/actions/runs/37282816379)，精确提交 `34c91a0093706c3e4bb0cbf417d41db45abfe434`。089 的 32 个文件已整批推送，新增 8 个 Node、每浏览器 4 个定义仍待托管结果。首次唯一查询为 **in_progress／conclusion=null**，只确认提交绑定，没有实时监控 jobs／artifacts。下次补取 088 终态和新增产物，再回收本批固定快照；整体非插件目标继续 active，未本地执行验证，未合入旧 main。

2026-10-05 准备 [089 托管回归修订与原生边界校准](decisions/089-hosted-regression-repairs.md)：修订分片 MP4 的 FFmpeg 首样本索引兼容、测试多语句入口、流式 PCM 交付观测、无左键窗口移动、光标 Y 比例精度与真实输入夹具。协议 **33**、TJS ABI **5**、字体 ABI **2** 不变；本批候选尚待托管执行，整体目标仍是完成插件以外的 KRKR2 Web 模拟器。

089 已补取 087 **completed／failure**：Node **3,007 通过、29 失败／3,036**，浏览器共 43 unexpected，兼容 **94/96**。23 份 ZIP 全部核对。088 本次固定快照仍 **in_progress**，8 jobs 成功、2 光标失败、14 运行中；11 份 ZIP 全部核对，Node／主浏览器／KAG 等未报告。两运行合计 **34/34 ZIP、290,355,537 字节**，历史失败与旧快照均保留。088 两 Windows 的 beginMove 各七项观察完整，但不代表应用实现通过；下一批补取未报告结果，不实时轮询。

最新待核验批次：[Full test suite 37279350828](https://github.com/fenghengzhi/krkr2-web/actions/runs/37279350828)，精确提交 `7ebb8f65a9ecfffee8826b14a65dd3c739e14759`。088 同步移动、输入接线、光标 X 步长和新增原生观察已整批推送；20 个 Node、每浏览器 8 个新增定义尚待托管结果。首次唯一查询为 **in_progress／conclusion=null**，未检查实时作业。下次补取 087 终态和新增产物，再取回本批固定快照；历史失败与未报告范围保留，未运行本地验证，整体非插件目标保持 active。

2026-10-05 准备 [088 同步窗口拖动与光标横向精度](decisions/088-window-begin-move.md)：接通 `Window.beginMove` 的 TJS 模态泵、真实页面拖动和生命周期回报；依据完整原生 plane 修订光标 X 比例精度，保留 13×9 差异，并追加独立色场与 User32 移动观察。协议 **33**，新增 20 个 Node、每浏览器 8 个定义尚待托管执行，整体非插件目标保持 active。

088 对 087 只取一次固定快照：仍 **in_progress／conclusion=null**，22 jobs 为 6 success／2 failed／14 running；**9/9 ZIP、30,742,219 字节**全部核对大小与 SHA-256。构建成功；双 allocator 各 60/60，Chromium library／PWA／trusted 分别 19/19、20/20、7/7。主应用验收仍未报告，Windows strict 仍各 39 差异、1,858 未比较；mask 各 3,770/3,770 匹配仅覆盖对应 plane。下次补取终态和后续产物，历史记录不改写。

最新待核验批次：[Full test suite 37275964642](https://github.com/fenghengzhi/krkr2-web/actions/runs/37275964642)，精确提交 `c87bc28347dda8d9aa1d2a8e3871129408aedf97`。087 的窗口区域、构建修订和新增诊断已整批推送；新增 17 个 Node、每浏览器 7 个定义待托管执行。首次唯一查询为 **in_progress／conclusion=null**，只确认创建及提交身份，未查询实时作业或产物。下次取回本批固定快照，保留历史失败、skipped、unreported、uncompared；未本地执行验证，未合入旧 main，整体非插件目标继续 active。

2026-10-05 准备 [087 窗口形状遮罩与构建修订](decisions/087-window-mask-regions.md)：补齐 `Window.setMaskRegion/removeMaskRegion` 的主图像 alpha 快照、预算、生命周期和全窗口 clip-path 呈现；修复 086 的 5 条 TypeScript 诊断；颜色诊断保留原 158 项并增加 18 个独立混合精度候选。协议 **32**，TJS ABI **5**、字体 ABI **2**。本批尚待 GitHub-hosted 执行，整体非插件目标保持 active。

087 已回收 085／086 的 **completed／failure**，各 11 jobs 为 2 success／4 failure／5 skipped，全部 **10/10 ZIP、40,544,098 字节**核对大小与 SHA-256。086 两 Windows mask 各 **3,770/3,770 matched**，仅限已采样的 AND／单色 XOR plane；主 strict 仍各 39 mismatch、1,858 uncompared，颜色候选仍无全域零差异。Node、浏览器、原 KAG 等均因 build 跳过；不能把手柄、流式音频、音轨及新增窗口功能计为已通过。固定摘要保存在对应运行目录 `087-final-summary.md`，原快照与失败历史保留。

最新待核验批次：[Full test suite 37273929294](https://github.com/fenghengzhi/krkr2-web/actions/runs/37273929294)，精确提交 `a3272586a93a5b7f13c1812396cc5b35f313db31`。086 的键盘模拟鼠标、AND／单色双高掩码、多 trun 校验及 085 构建类型修订已整批推送；新增 30 个 Node、每浏览器 12 个定义及全部 3,770 行严格 mask 比较尚待执行。首次唯一查询为 **in_progress／conclusion=null**，只确认创建和提交身份，不监控实时作业。下一轮补取 085 终态及后续产物，再回收本批固定快照；未本地执行验证、未合入旧 main，整体非插件目标保持 active。

2026-10-05 准备 [086 键盘模拟鼠标、掩码缩放与交错视频](decisions/086-mouse-keys-and-mask-scaling.md)：接通原来仅存储属性的 `Window.useMouseKey`，在陷阱接收与输入生命周期检查之后转换键盘／PAD；按完整原生轴线和边界采样修订 AND／单色双高 mask，并为其他比例新增 2,670 行原生观察；独立计算 MP4 多 trun 地址以支持真实交错容器。协议 **31**、TJS ABI **5**、字体 ABI **2**。本批代码与定义尚未取得执行结果，完整非插件目标仍 active。

086 只取一次 085 固定快照：run 仍 **in_progress／conclusion=null**，10 jobs 为 3 failed／1 success／1 running／5 skipped；已归档固定清单 **4/4 原 ZIP** 并核对大小与 SHA-256。Build 3 条测试类型错误在本批修订，应用验收未执行。两 Windows 各 1,100 条 mask 原始观察已完成且一致，支持单色两平面共同缩放的边界解释；95 份严格加载比较仍各 62 draw 差异，颜色量化未闭合。JSPI allocator 和最终 gate 尚未报告，下轮补取；历史失败与原快照保留，未本地执行验证或持续轮询。

最新待核验批次：[Full test suite 37270916669](https://github.com/fenghengzhi/krkr2-web/actions/runs/37270916669)，精确提交 `b88247d737706177ef923edf74839dee9c798c86`。085 的真实 MP4 音轨选择、生命周期与预算、新 Windows 光标采样及 084 构建修订已整批推送；新增 20 个 Node、每浏览器 17 个视频定义尚待执行。首次唯一查询为 **queued／conclusion=null**，只确认创建与提交身份，不实时监控。下一轮取回本批结果，保留历史失败、skipped、unreported、uncompared；未本地执行验证、未合入旧 main，整体非插件目标仍 active。

2026-10-05 准备 [085 视频音轨选择与原生光标采样](decisions/085-video-audio-tracks.md)：MP4 保留媒体字节和时间轴，使用真实单元素音视频时钟切换音轨；补齐原版方法／属性 setter 的 uint32 转换和越界空操作。增加真实频谱、播放／暂停位置、取消和编码资源预算验收。协议 **30**、TJS ABI **5**、字体 ABI **2**。另增 1,100 行 Windows mask footprint 观察和 158 个颜色缩放候选；当前生产光标差异仍未解决。所有新增实现尚待 GitHub-hosted 执行，整体非插件目标仍 active。

085 已回收 083／084 的 **completed／failure** 终态，固定清单共 **10/10 原 ZIP** 大小和 SHA-256 核对一致。084 build 有 9 条测试类型错误，本批修订；Node／浏览器／原 KAG 等后续作业全部 skipped，流式音频和手柄改动不能记为通过。两 Windows strict 各 270/332 匹配、62 draw 差异、1,858 未比较，原失败保留。每次运行 allocator 均每后端 60/60，仅代表独立诊断。未实时轮询，未本地执行验证；详细终态见对应运行目录的 `085-final-summary.md`。

最新待核验批次：[Full test suite 37267857946](https://github.com/fenghengzhi/krkr2-web/actions/runs/37267857946)，精确提交 `29be5f1d12e33696ef33601754c9bb139eb402b8`。084 的范围音频源、流式 WAV／Vorbis、Worklet 分页、缺页事务、Session 取消和 083 构建修订已整批推送；新增 87 个 Node 定义、每浏览器 2 个定义均待托管执行。首次唯一查询为 **in_progress／conclusion=null**，只确认提交身份，不实时查看作业结果。下一轮补取 083 终态并回收 084 固定快照／产物；既有失败、skipped、unreported、uncompared 记录保留。没有本地执行验证，未合入旧 main，整体非插件目标仍 active。

2026-10-05 准备 [084 有界音频源与流式播放](decisions/084-streaming-audio.md)：长 WAV／Vorbis 从 Resource 范围读取，经 Worker decoder 和 AudioWorklet 有界分页输出；加入部分滤镜 hop 的缺页恢复、取消、预算与真实 Session／浏览器验收。协议 **29**，TJS ABI **5**、字体 ABI **2**。本批尚未执行，不记为通过；全量验证仍整批交 GitHub-hosted Actions，下次取回结果。整体目标是完成插件以外的 KRKR2 Web 模拟器，仍有后续任务。

084 固定快照已回收 082／083 共 **28/28 原 ZIP** 并核对 hash／大小。082 终态 **failure**：Node 2829 pass／1 fail（光标缩放一个蓝通道量化差异）、常规浏览器 13 个光标失败、WebKit compatibility 20 pass／12 unreported。083 run 快照仍 in_progress，但 jobs 均终态，build TS2339 使 Node／浏览器／KAG 等 skipped；本批修订类型收窄，手柄新增定义仍未验证。两 Windows 95 份严格比较各 270/332 匹配、62 差异，未比较部分继续保留。旧快照、崩溃和未报告证据不改写，详见 084 决策及运行目录的固定摘要。

最新待核验批次：[Full test suite 37263528041](https://github.com/fenghengzhi/krkr2-web/actions/runs/37263528041)，精确提交 `03f87925ddc707976b2ff84f3aa685183ce1db34`。083 的真实手柄链路、按键查询、原 KAG 验收、光标修订及 95 份 Windows 参考已整批推送。首次唯一查询只确认创建与提交身份，当时 **in_progress／conclusion=null**，未检查实时作业。下一轮补取 082 终态及后续产物，再回收本批固定快照；原失败、未报告与未比较范围不改写。本地未执行验证，未合入旧 main，整体非插件目标保持 active。

2026-10-05 准备 [083 Gamepad 与按键查询](decisions/083-gamepad-key-state.md)：接入真实 navigator 设备采样、原版逐键 neutral／分组重复、Window 队列和物理状态；补齐 `System.getKeyState` 第二参数与按下记录消费，首次 joypad 配置和动态重复参数使用 TJS 转换。协议升 **28**，TJS ABI **5**、字体 ABI **2** 不变。新增纯状态机 25、采样驱动 4、协调器 4、真实 TJS 查询 12、参数 6 个定义，以及每浏览器 4 个手柄定义；原 KAG cursor 的 6 个 case 扩展 Pad 阶段。全部待 GitHub-hosted 执行，非硬件实测，整体非插件目标仍 active。

083 已回收 [081／37240240034](https://github.com/fenghengzhi/krkr2-web/actions/runs/37240240034) **failure**：23/23 原 ZIP 核对通过；Node 报告 2770 pass／2 进程失败，SIGTRAP／SIGABRT 后未报告部分保留；光标 format／load／storage／Session 分别 28／12／16／20 全部报告通过。常规浏览器 14 失败，其中 13 项光标及 1 项 WebKit 启动超时。对 [082／37242235256](https://github.com/fenghengzhi/krkr2-web/actions/runs/37242235256) 只取一次快照，仍 in_progress，9/9 ZIP 核对通过，Node 和常规浏览器等 14 项作业当时仍运行。两 Windows 87 份观察中 strict 各 258/308 匹配、50 draw 差异、0 接受差异，11 份 ANI 时间元数据匹配；raw 173/173 仍是 partial，未比较范围继续保留。原始证据与下一步修订边界见 083 决策及运行目录的 `083-final-summary.md`／`083-snapshot-summary.md`。

最新待核验批次：[Full test suite 37242235256](https://github.com/fenghengzhi/krkr2-web/actions/runs/37242235256)，精确提交 `0679f6725efe9b69d6747ddd8d0026d13b89384a`。082 的选择后解码、热点、单帧 ANI、解码队列和 87 份 Windows 参考已整批推送。首次唯一查询只确认创建与提交身份，当时 **in_progress／conclusion=null**，没有查询实时作业结果。下一批补取 081 完整终态与全部后续产物，再回收本批固定快照；原失败与未比较范围继续保留。未本地执行验证，未合入旧 main，完整非插件目标保持 active。

2026-10-05 准备 [082 光标选择顺序与解码预算](decisions/082-cursor-selection-decode-budget.md)：Session 改为先选目录项再解码，修订矩形选图和 signed SHORT／DWORD 热点，页面以有符号坐标放置；存储改为并发读取、单个活动解码，并补齐 Stop 早结算、共享调用者和失败 flight 重入清理。补上 ANI 每步 rate／steps／总时长的原生严格比较，并校准一帧一步 ANI 的静态加载元数据。光标加载／存储／真实 Session 分别新增 12／7／6 个定义，总计 24／23／26 个，browser host 从 3 增为 4 个／浏览器，全部待托管执行。Windows 参考扩为 87 份，另加 128 组原生 color-plane 缩放诊断；完整平滑量化及 mask 行差仍未闭合，严格加载比较继续保留失败。协议 27、TJS ABI 5、字体 ABI 2 不变，整体非插件目标仍 active。后续明确功能缺口包括长音频流式播放、真实手柄输入和视频多音轨，见本批决策末尾。

本批已补齐 [080／37238793190](https://github.com/fenghengzhi/krkr2-web/actions/runs/37238793190) 的 **completed／failure**：5/5 ZIP 大小及 SHA-256 匹配，allocator **120/120**；原 build 13 条 DOM 错误、最终 gate failure 和 Node／浏览器等 skipped 保留。对 [081／37240240034](https://github.com/fenghengzhi/krkr2-web/actions/runs/37240240034) 只取一次快照，仍 **in_progress／conclusion=null**：5/5 已发布 ZIP 核对通过，build success、trusted **7/7**，两 Windows failure，其余 18 个 job 当时仍运行且尚无用例报告。两系统各 81/81 份原生观察；每系统 raw 为 173 比较／170 匹配／3 mismatch／2 接受差异，load 为 284／236／48／2，另各有 1,729／1,618 个未比较 draw。原始失败、快照及后续待回收边界分别保存在两个运行目录的 `082-final-summary.md`／`082-snapshot-summary.md`，没有实时轮询或本地执行验证。

最新待核验批次：[Full test suite 37240240034](https://github.com/fenghengzhi/krkr2-web/actions/runs/37240240034)，精确提交 `669fe105cbe4eed1523ca899a07e1f0cbbc10b20`。081 加载策略、逐帧选择／缩放、Worker 类型图修复和 81 份 Windows 严格参考已整批推送。首次唯一查询只确认创建与提交身份，当时 **in_progress／conclusion=null**，没有检查实时作业结果。下一轮补取 080 尚缺终态与 JSPI 产物，再回收本批完整证据；已知候选边界和历史失败保持原记录，整体非插件目标仍 active，未合入旧 main，未本地执行验证。

2026-10-05 准备 [081 光标文件加载、选图与缩放](decisions/081-cursor-native-loading.md)：Session 将完整 CUR/ANI 原格式解码交给固定 32×32／32 位／96 DPI 加载策略，逐帧选图、缩放热点与像素后才缓存／发布；多图目录不再由页面直接报告未支持。协议升 **27**，TJS ABI **5**、字体 ABI **2** 不变。新 12 个加载定义、真实 Session 共 20 个定义、浏览器加载呈现与实际非整数 CSS 背景对照随完整批次执行。32 位平滑缩放仍是逐字节待校准候选，目录一般排序、先选再解码、高位热点和零 rate 墙钟等缺口继续保留；新增独立加载比较及 81 份 Windows 参考，不能缩小必比范围来取得通过。

本轮对 [080／37238793190](https://github.com/fenghengzhi/krkr2-web/actions/runs/37238793190) 只取一次固定快照：**in_progress／conclusion=null**，4 份已发布原 ZIP 全部核对 SHA-256 与大小。两套 Windows 各 **57 份完整观察、170/170 限定比较匹配**；另各 1,372 个未比较 draw 与 7 个接受差异不能算全面通过。Build 出现 13 条 cursor.ts DOM 类型缺失，静态定位为漏排 Worker include；本批补 `tsconfig.worker.json` 的 DOM 文件 exclude，不放开 Worker lib。Node／浏览器／兼容等全部 skipped，080 应用与新增回归没有执行结果。Asyncify allocator **60/60**；JSPI 当时仍运行，终态与后续产物下轮补取。原快照及产物在 `out/verification/github-actions/37238793190/081-snapshot-summary.md`，未轮询。

最新待核验批次：[Full test suite 37238793190](https://github.com/fenghengzhi/krkr2-web/actions/runs/37238793190)，精确提交 `baa6de2667fe2fb926d4656e8cecf983377e436f`。080 自定义光标接入、原生证据修正、57 份 Windows 参考矩阵及剩余 Node 夹具修订已整批推送；首次唯一查询只确认创建与提交身份，当时 **in_progress／conclusion=null**，没有查询实时作业结果。下一轮取回本批完整证据，继续选图／加载缩放、零 rate 播放和其他非插件兼容缺口；078／079 的完整历史失败已归档。整体目标保持 active，未合入旧 main，未本地执行验证。

2026-10-05 准备 [080 自定义光标资源与浏览器呈现](decisions/080-cursor-storage-presentation.md)：接入严格 String 资源路径、Session 解析路径缓存／稳定 ID／预算／Stop 清理，以及真实 canvas/video 背景上的 AND/XOR、完整非零 rate ANI 和物理／虚拟位置呈现。协议升至 **26**，TJS ABI **5**、字体 ABI **2** 不变。新增 16 个缓存、16 个真实 Session、每浏览器 6 个呈现定义；根据回收原生结果再新增 5 个格式定义（共 28），参考矩阵从 47 扩至 57。所有本批定义待托管执行，当前不是通过记录，整体非插件目标仍 active。

本批保留明确缺口：Windows 加载时的多图选择、源图缩放及 DPI，零 rate ANI 的墙钟策略，非整数 CSS pixelated 过滤，以及原生拒绝但通用解码器接受的格式加载政策。079 实测单图 13×9／256×256 都被 Windows 加载为 32×32；当前浏览器按源尺寸呈现因此不是原生尺寸兼容的完成状态。新增 alpha 全 256 阶／奇数背景和选图缩放样本用于继续补齐，不用窄范围通过代替这些要求。

已完整回收 [079／37236286963](https://github.com/fenghengzhi/krkr2-web/actions/runs/37236286963) **failure**：23/23 原 ZIP 大小与 SHA-256 匹配；Node **2744 通过、6 失败、2 超时取消／2752**，有 reporter finish／最终 plan；CUR 格式 **23/23**。Firefox **658/658**（cursor/hint **8/8**），常规三浏览器 **1972 通过、2 失败／1974**，剩余两项 WebKit 为 Target crashed 和视频 first-frame ready 超时。Windows 两系统各 **135 比较、117 匹配、18 像素差异**，另 3 项原生接受／候选拒绝；1,017 个未比较 draw／系统及 7 项相反接受差异另记。080 根据原始像素修正 16-bit 展开、alpha 预乘量化、图外热点及 ANI 边界；目的项全部舍入规则仍由新矩阵确认。终态与原失败在 `out/verification/github-actions/37236286963/080-final-summary.md`，旧快照原样保留。

也已完整回收 [078／37234602267](https://github.com/fenghengzhi/krkr2-web/actions/runs/37234602267) **failure**：20/20 ZIP 核对通过，Node **2720 通过、7 失败、2 超时取消／2729**，终于具备完整终态。selector native **26/26**、abort-entry **10/10**、integration **38/38**、browser **48/48**，原 bounded source/bytecode 均到 dispose 返回；字符串自追加 **2/2** 且原生 ASan/UBSan 日志 PASS，identity allocator **120/120**。这些成功不改写旧失败。080 修订 identity 非法操作名、invalidate 后 Scripts 全局查找和提前结束诊断；079 几何剩余的浮点差异用小于 `1e-10` 的尺寸误差界验证，整数原点和脚本光标仍精确。原证据在 `out/verification/github-actions/37234602267/080-final-summary.md`。

最新待核验批次：[Full test suite 37236286963](https://github.com/fenghengzhi/krkr2-web/actions/runs/37236286963)，精确提交 `ae42bf93fddc6c0bada0483bb3556a4629a1a855`。079 格式候选、Windows 原生对照、Firefox display 隔离和几何夹具修订已整批推送；首次唯一查询确认创建与提交身份，当时 **pending／conclusion=null**，没有检查实时作业或当作已执行。下一批先补取 078 的完整终态／后续产物，再取回本批全部证据；失败、取消及未比较范围继续保留。协议 25、TJS ABI 5、字体 ABI 2 不变，完整非插件目标仍 active，未合入旧 main。

2026-10-05 准备 [079 CUR／ANI 格式与参考证据](decisions/079-cursor-format-reference.md)：新增有界多图 CUR 和完整逐步 ANI 资产解码、热点、RGBA／AND-XOR 两种操作及整数比例动画采样；新增 23 个格式验收定义，以及 Windows 2022／2025 上 47 份独立二进制夹具的 User32 加载／离屏像素对照。所有定义尚未运行，字符串 cursor 的 Session 资源缓存和浏览器实际呈现仍未接入，自定义光标及整体非插件目标均未完成。并修正 077 的公开 transition／绘制坐标夹具；Firefox 改为每个 headed display 一个 worker、常规测试分两台 host，并新增被动输入时间线，不放宽断言或时限。

本轮已完整回收 [077／37233070087](https://github.com/fenghengzhi/krkr2-web/actions/runs/37233070087)：终态 **failure**，Node **cancelled**，18 份原 ZIP 的 SHA-256 与大小全部一致。Node execution 已报告 **2645 通过、8 失败／2653**，缺 reporter finish；TAP 仅 **1047 通过、2 失败**、无最终 plan，二者不能相加。新增明确失败为 source／bytecode 几何夹具调用不存在的脚本 exchange，以及一个旧客户区坐标；其余五项是 078 已修订的 selector／Vocoder／存储夹具，不能追认旧结果通过。selector 仍在 execute call 115 越界后进入 dispose 117 而未返回。常规浏览器 **1958 通过、4 失败／1962**，四项均在 Firefox cursor／hint；compatibility **96/96**、library **57/57**、PWA **59/59**、trusted **7/7**。完整索引和原 trace 在 `out/verification/github-actions/37233070087/final-summary.md`；额外保留的 079／080 快照没有覆盖此前证据，080 仅为归档避重前缀。

对 [078／37234602267](https://github.com/fenghengzhi/krkr2-web/actions/runs/37234602267) 本轮只回收一次快照及当时产物：仍 **in_progress／conclusion=null**，build 未结束；两个 identity allocator 作业分别 **60/60**，合计 **120/120** 已报告通过，2 份原 ZIP 的 SHA-256 与大小全部一致。这是独立分配诊断的结果，不覆盖 Node、浏览器、兼容性和最终 gate；不继续轮询。下一批仍须补取该运行完整终态和全部后续产物。

最新待核验批次：[Full test suite 37234602267](https://github.com/fenghengzhi/krkr2-web/actions/runs/37234602267)，精确提交 `05bb6552fa0d5f05a242596092ecb9efc670ad8c`。078 的对象身份、输入 capture、自追加字符串及诊断工作流已整批推送；唯一首次查询只确认运行创建和提交身份，当时 **in_progress／conclusion=null**，未查询实时作业结果。下一批补取 077 的完整终态与全部原 ZIP，再取回本批执行证据；失败、取消与未报告保持独立。整体目标仍是完成插件以外的 KRKR2 Web 模拟器，尚未完成，也未合入旧 main。

2026-10-05 准备 [078 原生对象身份](decisions/078-object-identity.md)：补齐首次 down 回调 self-invalidate 后、对象尚未真正析构时的 capture 取得路径；独立 native identity 不拥有对象、不延长回调引用，也不改变资源 WeakObject 在 invalidate 时失效的合同。输入泵在 VM 实际赋值成功后确认 capture，并在完成、异常、Window 退休和 Stop 时撤销临时 identity。会话协议仍为 **25**、TJS ABI **5**、字体 ABI **2**；新增强制能力 `objectIdentity:1`。另修复真实文件选择器边界用例暴露的字符串自追加别名错误。源码、字节码、三浏览器及独立分配失败诊断定义已接入完整托管批次，尚未执行，不是通过记录。整体非插件目标仍 active，CUR／ANI、剩余图形／系统及音视频兼容继续在范围内。

对 [077／37233070087](https://github.com/fenghengzhi/krkr2-web/actions/runs/37233070087) 本轮只取一次快照：仍为 **in_progress／conclusion=null**，Node 未结束，Firefox 常规作业已 **failure**；其余已结束作业为 success，但本次没有下载报告或换算用例数量。清单有 17 份产物且尚无 node-results，原快照保存在 `out/verification/github-actions/37233070087/`。完整终态、原 ZIP 和 Firefox 具体失败留待下一批取回，不继续轮询；此状态不能算整批通过。

本轮补取 [076／37231345437](https://github.com/fenghengzhi/krkr2-web/actions/runs/37231345437) 终态 **cancelled**，汇总 All tests **failure**；18 份原 ZIP 已全部核对 digest，此前部分证据保留。新 execution-order 记录确认 Node 独立用例 **2606 通过、7 失败／2613**，但没有 reporter finish，不能当作完整终态库存；TAP 仅送达 **1011 通过、2 失败**，两种口径不能相加。selector 的 bounded source 用例先在 `vm.execute` 报 WASM memory access out of bounds，随后 dispose 无终态；静态源码确认 `value += value` 的重叠 NUL 拷贝和扩容后旧指针风险，本批按显式长度拷贝并在搬移后恢复内部偏移，分配失败保留原字符串。原 selector 测试不绕开该算法。另修正已证实的 save 字符串布尔转换、TJS real 零格式和大小写歧义存储夹具；原失败继续保留。

076 常规浏览器 **1940 通过、10 失败／1950**；compatibility **96/96**、library **57/57**、PWA **59/59**、trusted **7/7**。Firefox 的七项 cursor／hint 失败尚未闭合，WebKit 的媒体位置、多窗口启动和 trace 启动失败也分别保留。Node 的 layer-neutral-color 原生 SIGTRAP 回溯涉及 V8 的 Wasm code allocation 回收，不能据此归因于 selector 的线性内存越界。原始归档与终态索引保存在 `out/verification/github-actions/37231345437/`；本批新增的测试及修订仍需新的 GitHub-hosted 结果。

最新待核验批次：[Full test suite 37233070087](https://github.com/fenghengzhi/krkr2-web/actions/runs/37233070087)，精确提交 `567da391e9172c38c1683b9b897899b2fd42f78d`。077 的事件顺序、共享绘制几何、捕获引用与主 manager 选择已整批推送；首次查询仅确认创建和提交身份，当时 **in_progress／conclusion=null**，未取实时作业结果。下批补取 076 尚未报告的 Node／常规浏览器和本批执行证据。完整非插件目标保持 active；原版 self-invalidate 后首次 capture 的寿命身份、CUR／ANI 等仍是后续要求。

2026-10-05 准备 [077 鼠标事件与绘制几何](decisions/077-mouse-manager-geometry.md)：按固定原版分开 Window 回调、PaintBox 整数快照、DrawDevice 投影和 manager 事件；修正 down 额外 move、up 尾部坐标、capture 释放时点及失效目标路由。画面、cursor、attention 和 touch 统一使用取整后的显示矩形，鼠标按原版整数转换，touch 保留实数。主图层交换后按稳定 manager 注册顺序选择显示对象。协议候选升 **25**；新增和调整的验收定义尚未执行，完整非插件目标仍 active。

本批补取 [075／37229833481](https://github.com/fenghengzhi/krkr2-web/actions/runs/37229833481) 终态 **failure**，18 份 ZIP 全部核对 digest。Node 已报告 **983 通过、4 失败／987**，无最终 plan：两个 Help 缺分号旧失败、两个 cursor 夹具图像偏移越界；后者未到光标断言，本批先扩图像，再按固定原版几何更新独立手算期望。selector-native 确认到作业取消仍未退出；event-lifetime 没有 exit 是 **SIGABRT 原生崩溃**，回溯为堆一致性检查失败，不能归为同一挂起。两份 integration 的 code 1 仍缺具体用例。常规浏览器 **1925 通过、1 失败／1926**；cursor 24/24、Help 24/24、Vocoder 21/21 已通过。唯一 Pad 失败与 WebKit JSPI Worker SIGILL 时间吻合，尚未确定根因。旧 Firefox Help compatibility 截图失败也保留。原始归档、backtrace、crash 和最终摘要在 `out/verification/github-actions/37229833481/`，没有覆盖此前 partial 证据。

对 [076／37231345437](https://github.com/fenghengzhi/krkr2-web/actions/runs/37231345437) 本批只回收一次，当时仍 **in_progress**。13 份已发布 ZIP 全部核对 digest；compatibility **96/96**、library 57/57、PWA 59/59、trusted 7/7，六组 direct runtime 的 failures 为空。Node 与全部常规浏览器尚无报告，因此本次无法取得新 execution-events／selector journal，仍不能确定 selector 内部卡点或补造未报告失败。下批继续补取，不实时轮询。

最新待核验批次：[Full test suite 37231345437](https://github.com/fenghengzhi/krkr2-web/actions/runs/37231345437)，精确提交 `3443f9fc6beaf1f1c79c60d7421587c482486d01`。076、帮助夹具分号和 Node 诊断采集已整批推送；首次查询只确认运行创建及提交绑定，当时 **in_progress／conclusion=null**。不实时监控，不记为通过。下一批先补取 075 剩余 Node／WebKit／终态，再取回本批结果；全部测试及可执行验证仅在 GitHub-hosted runners 运行。整体非插件目标仍 active，未合入旧 main。

2026-10-05 准备 [076 stock cursor／hint 通知语义](decisions/076-layer-cursor-hint.md)：候选补齐数值光标继承、提示继承开关、原版通知时点、共享重入保护、异常恢复及缩放后的旧主坐标重查。新增真实 VM 源码／字节码和浏览器验收定义，尚未执行。自定义 CUR／ANI、完整鼠标入口顺序等仍在范围内，整体非插件目标保持 active；协议 24、TJS ABI 5、字体 ABI 2 不变。

准备本批时已补取 [074／37227951808](https://github.com/fenghengzhi/krkr2-web/actions/runs/37227951808) 终态 **failure**，18 份原 artifact ZIP 均核对 digest 并保留。Node 超过 20 分钟被取消，已送达 **967 通过、2 失败**，没有最终 plan；进程记录确认 `storage-selector-native.test.ts` 是唯一未退出文件，具体用例仍未知。另有 `integration/phase-vocoder.test.ts` 与 `integration/storage-selector.test.ts` 以 code 1 退出，但具体用例被前序文件的 TAP 缓冲阻挡，不能补造失败数量。常规浏览器 **1894 通过、8 失败／1902**；兼容 **89 通过、1 失败／90**。最终摘要、原错误、部分快照与全部归档分别保留在 `out/verification/github-actions/37227951808/`。

074 的两个已报告 Node 帮助失败已确定为 statement 模式调用缺少分号，本批保持丢弃结果语义并补分号。六个浏览器帮助夹具失败和两个 WebKit Vocoder 时间失败继续保留，075 修订的结果单独回收。selector 的根因尚未证明；本批增加仅在 Actions 使用的被动用例／VM／host 调用阶段 JSONL，不改变原 60 秒用例预算或 20 分钟作业上限。

本批对 [075／37229833481](https://github.com/fenghengzhi/krkr2-web/actions/runs/37229833481) 仅回收一次：当时仍 **in_progress**，Node 和两份 WebKit 常规分片待结束，未再轮询。已有 15 份 ZIP 全部核对 digest；Chromium／Firefox 常规各 **642/642** 通过，兼容 **95 通过、1 失败／96**，新增原 KAG 键盘光标六项全部通过。失败仍是 Firefox Help 首次打开截图超时，本次为 JSPI；完整阶段未完成，保留失败。Node、WebKit 常规和整批终态下一批补取，不能用当前结果宣称整批通过。本批另接入 Node 第三个 execution-order reporter，以保存被前序挂起文件阻挡的实际完成事件及错误；spec/TAP、并发和超时保持。

最新待核验批次：[Full test suite 37229833481](https://github.com/fenghengzhi/krkr2-web/actions/runs/37229833481)，精确提交 `d4bfabb593a598d8999da74dfe5467f512910555`。075、音频观测顺序及帮助控制台夹具修正已推送；首次查询仅确认创建和提交身份，当时 **in_progress／conclusion=null**，未检查实时作业。后续准备批次时先补取 074 的未决终态/缺失产物，再取回本批完整结果；失败、取消和未报告继续独立保留。整体非插件目标仍 active，未合入旧 main。

2026-10-05 下一批实施 [075 Layer 光标写入](decisions/075-layer-script-cursor.md)：原 KAG 键盘链接导航确实写 `cursorX/cursorY`，候选补齐每层暂存 X、Y 提交、setCursorPos、可见虚拟光标、既有鼠标事件路径与真实输入接管；协议候选升 24，新增原 KAG 键盘探针，兼容库存预期 96 项。尚未执行该候选。

准备 075 时仅查询一次 [37227951808](https://github.com/fenghengzhi/krkr2-web/actions/runs/37227951808)：当时仍 **in_progress／conclusion=null**，Node 和两份 WebKit 常规分片尚在运行，不再连续轮询。该快照已发布的 15 份 ZIP 已全部取回、核对 GitHub digest 并归档；它们不是整个运行的完整归档。已完成 Chromium／Firefox 常规报告各 **632 通过、2 失败**，四项都在帮助测试的多行表达式填入单行输入框后、提交前失败；本批仅把同一表达式整理成单行，保留原断言。兼容 Chromium／WebKit 各 **30/30**，Firefox **29/30**，后者原 KAG Help Asyncify 在第一阶段截图超时，仍独立保留。此记录不代表整批通过，余下终态及产物需后续取回。

旧 `36455312915` 的全部 14 份原始 ZIP 和 `37162952459` 的 build-logs ZIP 已补回，均与 GitHub artifact digest 一致；完整产物分别保留在各 run 目录的 `recovered-artifacts/`，原 Markdown 摘要与失败/未报告状态保持。旧 Node 超时的静态检查尚未证明卡点；加强 selector 的已有双错断言，不宣称修复产品缺陷。WebKit Vocoder 旧 trace 显示大 PCM 回传延迟污染终点观察，候选将终点 inspect 移至 PCM 序列化前，保留 0.75 秒输入、1.5 秒上限和全部比例断言，见 [068 追加记录](decisions/068-phase-vocoder.md)。

最新待核验批次：[Full test suite 37227951808](https://github.com/fenghengzhi/krkr2-web/actions/runs/37227951808)，精确提交 `a0ec1b9d7abc11a9abf6b82a31889b5aa1ce5edc`。2026-10-05 已推送 074、上一批夹具修正及整批兼容工作流接线，首次查询仅确认 push 创建运行，当时 **in_progress／conclusion=null**；没有查询实时作业或宣称通过。下一批前取回终态、全部原始 artifacts、Node 进程记录、两份 WebKit 分片及三浏览器兼容报告；兼容库存 **90 项**仅表示预期范围。默认 SSH 22 连接被关闭后，通过校验既有 GitHub 主机密钥的 SSH 443 完成推送。

2026-10-05：整体目标仍是完成插件以外的 KRKR2 Web 模拟器。当前候选已接通 [074 Web 帮助文档链路](decisions/074-web-help-plan.md)：native 包装、VFS 实际文本、Worker 确认、非模态面板和 Stop 清理；协议 **23**、`nativeHelp:1`。还没有该候选的执行结果，完整目标没有完成。下一批完整 Tests 将同时运行原 KAG／旧 ABI 兼容矩阵并复用同次构建，结果下次取回，不实时监控。

已取回 [37163692990 @ ce6ea52](https://github.com/fenghengzhi/krkr2-web/actions/runs/37163692990) 的终态 **cancelled**，All tests **failure**。Node 仅送达 **936 通过、2 失败**，随后 20 分钟超时，剩余范围未报告；常规浏览器 **1852 通过、26 失败**，library 57、PWA 59、可信生命周期 7 均通过，直接运行时 6 个结果组无失败。15 份原 artifact ZIP 全部保留并与 GitHub digest 一致，详细摘要和原 trace 在 `out/verification/github-actions/37163692990/root-summary.md`。本批静态修正 Array 二进制读取器、已有双大小写文件夹具、全屏接管预期；Node 取消卡点、WebKit Vocoder 时间边界和 Clipboard 启动存储异常仍未闭合。增加被动 Node 进程/文件开始与退出记录，不增加超时或放宽断言。

后续仍需取回并修复整批失败、补齐当前未报告与原 KAG 覆盖、收回更早历史归档缺口，以及继续其余系统／图形 API、音视频行为差异与流式资源支持。下面保留此前记录；其中“待核验”或“下一实施项”是当时状态，以本段更新为准。

当前待核验批次：[37163692990](https://github.com/fenghengzhi/krkr2-web/actions/runs/37163692990)，精确提交 `ce6ea52ae6ad9300b7651e756126d4bcc72d4e2c`。073 及上一轮类型修正已整批推送，首次确认时为 in_progress／conclusion=null，不实时监控，不记为通过。下一实施项为 [074 Web 帮助链路](decisions/074-web-help-plan.md)；该文档只是计划，没有实现或验证声明。插件以外的整体目标仍未完成。

2026-10-04 下一批接续 [073](decisions/073-storage-write-targets.md)：显式 UPDATE 必须命中已有目标，预检返回实际名称并由 native writer 绑定；普通 WRITE 不搜索 autoPath，保留直接目标大小写；尾部合并不再重新搜索。`nativeTextStreams` 候选能力升至 **2**，ABI 5／协议 22 保持。新增源码／字节码、浏览器持久重载、旧能力拒绝定义均未执行，不能称为已验证。Web 帮助链路已确认 `getLocalName`／`shellExecute` 两个入口仍缺失；原 KAG 默认隐藏 Help 菜单，既有兼容测试不能证明它们已实现。

上一批 [37162952459](https://github.com/fenghengzhi/krkr2-web/actions/runs/37162952459) 已取回终态 **failure**：精确提交 `f976640b1b031ac8fb6fb1bd75f555178753faa7` 的类型／构建作业失败，汇总作业失败，Node、浏览器、可信生命周期、直接运行时作业均 skipped，实际产品测试未执行。官方注释为 `tests/probes/storage-selector-kag.ts` 两处 provenance 隐式 any[] 诊断，本批已补类型。run／jobs／artifacts 列表及注释已存本机 `out/verification/github-actions/37162952459/`；build-logs ZIP 仍可见但未登录 API 下载返回 401，原始日志未取回。未生成成功 test-build，不启动或宣称同构建兼容通过。下面的 in_progress 是当时首次查询记录，已由本段终态更新，历史字节保留。

当前待核验批次：[Full test suite 37162952459](https://github.com/fenghengzhi/krkr2-web/actions/runs/37162952459)，精确提交 `f976640b1b031ac8fb6fb1bd75f555178753faa7`，由候选分支 push 触发。2026-10-04 仅查询一次以确认运行创建及提交绑定，当时为 in_progress、conclusion=null；未取回终态，不是通过记录。下一批验证前取回该轮全部结果和两份独立 WebKit 分片产物；确认其 build 成功后，兼容工作流必须使用这个 build-run，并在该提交或已证明同应用源码的 ref 上启动。历史 `36455312915` 归档缺口继续保留。

2026-10-04 迁移后在 `codex/migrated-window-attention` 接续原候选，保留迁移的所有未提交修订；没有从旧 main 重新开发。已静态复查客户端 Stop/cancel watchdog 的先结算、后清理顺序，并新增 [072](decisions/072-runtime-write-settlement.md) 的脚本异常／尾部写入双错保留及八项真实 VM 定义。它们尚未验证，静态预计 Node 库存在下列 2,512 项基础上增加八项。按用户要求整批触发 GitHub-hosted Actions，不实时监控；下一次准备验证时取回上一批结果，未取回结果的运行始终记为待核验。兼容检查仍须绑定成功的精确 build-run，不能在构建结果未知时宣称完成。

本机仅恢复了 `36455312915` 的两份 Markdown 摘要；完整 ZIP、JSON 首错索引及 storage12 原始 trace 尚未迁入，历史归档收尾保持未完成。交接提到的 `next-after071-audit.md` 未包含在小迁移包中，不能声称已阅读。UPDATE 实际路径绑定、Web 帮助链路和其他媒体／图形兼容仍是后续工作。

2026-09-29 集成候选已合并 058–071 的非插件改动：System 对话框、视频混合图层、Clipboard、province、窗口输入与焦点、图像颜色键、系统颜色、Pad、公开 Storages 路径、内置 PhaseVocoder、显示几何、虚拟文件选择器及文本流写入模式。当前会话协议 **22**、TJS ABI **5**、字体 ABI **2**，保留 `nativeReleaseState:1`、`nativeClipboard:1`，并要求 `nativeSystem:2`、`nativePad:1`、`nativeStorages:2`、`nativePhaseVocoder:1`、`nativeTextStreams:1`。Pad 的 24 个属性由真实 native class 实现，保存使用共享宿主模态作用域；公开路径统一为 `game://./`，保存层继续使用原相对键。具体范围见 [063](decisions/063-window-attention.md)、[065](decisions/065-system-colors.md)、[066](decisions/066-pad-editor.md)、[067](decisions/067-storage-public-paths.md)、[068](decisions/068-phase-vocoder.md)、[069](decisions/069-system-display.md)、[070](decisions/070-storage-selector.md)、[071](decisions/071-text-writer-modes.md)。本段是候选实现状态，尚未作为已验证版本合入 main。

本批包含 CSS 半透明系统颜色的合成修复及输入路由夹具校正，并已合入 main 的历史验证文档。前次构建 [36442487130](https://github.com/fenghengzhi/krkr2-web/actions/runs/36442487130) 因负向测试的 TypeScript 类型断言失败，普通用例未运行；修订后的 [36443186745](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443186745) 被取消，Node 实际 2,172 通过、2 失败，浏览器已报告 97 通过、260 失败、1,260 无终态报告，直接运行时 6 组通过。同次构建的 [36443590538](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443590538) 兼容检查失败，24 失败、54 未运行。浏览器共享初始化错误为 Highlight 颜色包含透明度；修订及新功能需要新的完整托管结果，不能追认上述失败为通过。

下一次完整回归的静态库存预计为 2,512 项 Node、1,983 项浏览器和 6 组直接运行时，最终数量和结论以实际 Actions 报告为准。所有测试、构建、类型检查及浏览器探针只在 GitHub-hosted runners 执行；按功能批次运行，原 KAG／旧 ABI 兼容检查复用相同构建。插件仍不在本阶段范围内，PhaseVocoder 的原版数值与边界兼容、流式媒体、旧编码及其他系统／图形接口继续进行，完整非插件目标尚未完成。

此前已结束的 [36448613310](https://github.com/fenghengzhi/krkr2-web/actions/runs/36448613310) 对应 `eca4086`，实际 **Node 2,304 通过／2,308，浏览器 1,796 通过／1,833，直接运行时 6／6**；Node 4 项失败，浏览器 33 项失败、4 项超时，无遗漏、跳过或重试。36 个 Pad 浏览器失败已按原始 trace 分开诊断；另一个 WebKit image-writing 失败同时保留纯背景原截图与浏览器二次读取全零两份证据，原因仍未证明。同次构建 [36448778629](https://github.com/fenghengzhi/krkr2-web/actions/runs/36448778629) 实际 30 项旧 ABI 通过、9 项 KAG 失败、39 项未运行，9 项首错均为缺失 System.desktopLeft。后续 Node 观测边界、Pad 焦点／停止及 System 显示属性修订不改变这两次失败的身份。

068 的 DSP 使用共享 TypeScript FFT／流式处理链并接入生产 AudioWorklet，实际波形、标签和寿命验收仍待新批次。对固定源码的标签重复偏移行为采用已明示的 Web 归一化策略，不宣称全部原版数值或事件时序等价。069 的六个整数只读显示属性来自本 Player 的真实 stage／全屏 viewport；它没有请求 OS 窗口管理权限。上述新增功能与本轮修复将统一验证。

合并 068／069 后的 [36454241579](https://github.com/fenghengzhi/krkr2-web/actions/runs/36454241579) 对应 `20c0dec`，原生编译及缓存成功，但新增 PhaseVocoder 测试有 17 条 TypeScript 诊断：16 条事件联合类型访问未缩窄、1 条空数组断言将随后要修改的数组缩窄成 never[]。实际普通测试 **0 项**，未生成 test-build，未启动同构建兼容工作流；该失败及原始日志独立保留。后续测试类型修订不改变原断言，也不把构建成功阶段视为测试通过。

070 将 `Storages.selectFile` 接入真实 native 方法、当前游戏虚拟目录、已有共享模态栈和 DOM 文件选择器，覆盖原版 getter／回写顺序、只读归档成员、存档覆盖确认、暂停和 Stop。针对模态 continuation 进入前失败，增加精确请求清理与严格限定的 runtime 撤销入口，保留其他 scope 和原错误。新增 78 项 Node、48 项浏览器定义及 6 项原始 KAG 自选持久存读档，下一次兼容库存为 84；这些新增定义尚未执行。通用 runtime 的未捕获 ScriptError 与尾部写失败双错误覆盖仍属已记录的后续工作，不能算作本切片已修。

[同构建兼容 36455447465](https://github.com/fenghengzhi/krkr2-web/actions/runs/36455447465) 复用完整测试 `36455312915` 的 `56769cf` 产物，实际 **78/78 通过**（48 项原始 KAG、30 项旧 ABI，三个浏览器各 26），构建与所有来源哈希一致，无未运行或遗漏。它不验证后续音频、显示夹具、指针清理修订及 070／071，也不替代已结束但失败的完整回归。此次完整回归的 Node 实际 2,322/2,396、直接运行时 0/6，主要阻塞已定位为 Wave 实例构造方法遮蔽全局滤镜 helper；修订明确使用全局类。其余独立失败、实际结果和修复范围分别保留在 052、068、069 文档中。

071 在创建真实文本写入器时校验模式，支持原版 `c2` 压缩和 `z` 覆盖、保留显式 `o0` 的原文件尾部，统一首次 `o`、八进制及 NUL 终止规则；binary 与 text 由 native 入口区分。保留 Web UTF-8／append 扩展，尚未实现原版 UPDATE 必须命中已有实际路径的完整绑定。新增 38 项 Node、42 项浏览器定义；其实现和新增能力检查尚待整批 Actions 验证。

完整回归 [36455312915](https://github.com/fenghengzhi/krkr2-web/actions/runs/36455312915) 的 WebKit 常规作业触及 **45 分钟 job 上限**，官方 annotation 已保留。日志声明 586 项，实际连续报告 453 通过、25 未通过，另 108 项没有终态报告；没有生成该作业的 results.json，不能推断这些用例未运行或通过。合并其他完整 JSON 报告，该轮浏览器范围为 **1,691 通过、82 未通过、108 无终态报告／1,881**；WebKit 的 25 个日志失败没有最终 JSON 类型分类，不能补记成断言失败或 case 超时。其 Pad Clipboard 四项和图像写入两项已报告通过，但通过用例的相应正文附件没有落盘，不能声称 WebKit 的细节证据完整。Pad／input 的两个启动失败均定位到 CSS 系统色 1×1 Canvas 读回异常，发生在 Session Worker 建立之前；Canvas 底层失败原因尚未证明。后续恢复处理、停止清理及套件分片将作为下一批候选验证。启动恢复和客户端 watchdog 边界另新增 12 项浏览器定义，已计入上述预计库存；两分片本身不增加或删减用例。

以下保留 main 及此前阶段当时的已验证状态与历史证据。

当前已验证组合包含协作式 `MenuItem.popup`、Window 隐藏关闭查询校准、Layer.drawText／Font 参数与空操作语义，以及 crossfade／universal 的 opaque 定点像素核。菜单保留 TJS 调用栈并允许 Timer 和子模态工作，选中通知在返回后投递；原版 SDK 已确认单独 N 标志仍通知，仅 R 抑制。会话协议 **11**、TJS ABI **5**、字体 ABI **2**，内核提供 `nativeReleaseState: 1`。 实现与边界见 [052](decisions/052-modal-scopes.md)、[056](decisions/056-layer-text-semantics.md)、[057](decisions/057-opaque-transition-kernels.md)。

[完整回归 35001345784](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001345784)在精确提交 `34367abda6a4519d54fa1ff8daae3b7776b20cb8` 通过 **1,756 项 Node、1,146 项浏览器和 6 组直接运行时**，14 个作业全部成功，零失败、取消、跳过或重试。浏览器包含 1,023 项常规、57 项游戏库、59 项 PWA 和 7 项可信生命周期。

[兼容检查 34997605307](https://github.com/fenghengzhi/krkr2-web/actions/runs/34997605307)在 `6678d6e` 使用构建 `34997020864` 通过 **78 项原 KAG／旧 ABI 检查**。从该提交到 `34367ab` 只修改测试与文档，应用及内核源码相同；这是同源码的另一构建证据，不冒充最终回归的同次构建。

已测应用以 `85414d3` 合入 main；合入与文档提交使用 `[skip ci]`，不新增一次验证。System 消息／输入对话框、视频混合图层和 Clipboard 在后续分支实现，尚未合入这里的已验证版本。其他系统／图形 API、流式媒体、旧视频编码及完整非插件目标仍未完成。历次失败、取消、未报告及原生诊断全部保留；当前绿色结果不证明历史 V8、glibc 或 WebKit 故障根因已修复。所有可执行验证只在 GitHub-hosted Actions 进行。

以下保留此前阶段当时的状态与证据，当前结论以上文为准。

052 的输入接收 ACK、协作式原生检查点、视频完成票据及 Window.showModal 已通过完整回归并合入 main。模态调用保留 TJS 栈，子窗口输入、Timer／AsyncTrigger、延迟关闭查询与父子退出继续经同一事件泵推进；宿主阻塞、焦点恢复及 Stop 清理已接通。会话协议 **11**、TJS ABI **5**、字体 ABI **2**，内核新增 `nativeReleaseState: 1`。范围见[决策 052](decisions/052-modal-scopes.md)。

[完整回归 34989855109](https://github.com/fenghengzhi/krkr2-web/actions/runs/34989855109)在精确提交 `2683b304fa32e409941c84b723d80d53b5d6ac8d` 通过 **1,646 项 Node、1,095 项浏览器和 6 组直接运行时**，14 个作业全部成功；浏览器为 972 常规、57 游戏库、59 PWA、7 可信生命周期，零失败、取消、跳过或 flaky。[兼容检查 34991339560](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991339560)使用同一提交、同次构建通过 **78 项原 KAG／旧 ABI 检查**，每种浏览器 26 项。

已测应用在 `5e54ceb` 合入 main；合入提交带 `[skip ci]`，只另外包含原版 SDK 参考工作流及其夹具，不新增一次验证。Menu.popup 的新嵌套业务仍在 052 工作目录实现，未验证、未合入 main。旧 VCL 关闭时序与菜单标志的未知项仍需原版证据；其他图形／系统 API、流式媒体、旧视频编码和整体非插件目标继续进行。历史失败、取消与未报告案例全部保留，不以本次绿色回归追认其根因已修复。全部可执行验证只在 GitHub-hosted Actions 进行。

以下保留 055 阶段当时的状态与证据，当前结论以上文为准。

当前已验证组合包含053裁剪、054 copyRect／空写入与055 assignImages：赋值保留目标Font身份及映射，深复制图像，正确处理自赋值；Binder显示透传与直接复制使用各自的完成规则。阶段边界及保留的失败见[053](decisions/053-layer-clip.md)、[054](decisions/054-layer-copy-rect.md)和[055](decisions/055-layer-assign-images.md)。

[完整回归 34955337265](https://github.com/fenghengzhi/krkr2-web/actions/runs/34955337265)在 `cf564282` 通过 **1,431 项 Node、1,041 项浏览器和 6 组直接运行时**，14个作业全部成功；浏览器包含918常规、57游戏库、59 PWA、7可信生命周期，零失败、取消、跳过或flaky。[兼容检查 34954688171](https://github.com/fenghengzhi/krkr2-web/actions/runs/34954688171)在 `c35ac758` 复用构建34952630856通过 **78 项原 KAG／旧 ABI 检查**；到当前提交，应用及内核源码不变，仅文档与runner诊断改变，两个构建的来源分别保留。

052的输入ACK、原生检查点与Window.showModal仍在独立分支验收，尚未纳入这里的已验证版本。菜单嵌套、其他图形／系统API、流式媒体与旧视频编码仍未完成。此前V8、WebKit及Xvfb故障证据保留；本次全绿不证明其根因已修复。全部可执行验证只在GitHub-hosted Actions进行。

以下保留051及以前阶段当时的状态与证据。

051 已接通同一会话中的多个页面内窗口：独立画布、输入、菜单与视频，共享 Worker、TJS VM 和系统事件队列。初始画布就绪、失效恢复、主窗退出及浮动／嵌入布局已验证，详见[决策 051](decisions/051-multiwindow.md)。

[完整回归 34945014092](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945014092)在 `3ef7f09` 通过 **1,317 项 Node、1,041 项浏览器和 6 组直接运行时**；浏览器包含 918 项常规、57 项游戏库、59 项 PWA、7 项可信生命周期。[兼容检查 34945755032](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945755032)使用同一提交、同次构建通过 **78 项原 KAG／旧 ABI 检查**，三浏览器各 26 项。

各轮失败与未报告案例继续保留；本轮通过不证明历史 V8 断言或 WebGL context loss 的根因已修复。Window.showModal、菜单嵌套事件循环、其余图形／系统 API、流式媒体及旧视频编码仍在实现，完整非插件目标尚未完成。 052 模态接线与 053 裁剪修复在独立分支验证，尚未纳入这里的已验证版本。

以下保留 050 及以前阶段当时的状态和证据。

050 组合版本已验证 [Window.mainWindow 的实际实例查询](decisions/047-window-main-instance.md)、[piledCopy 空目标区域与回调顺序](decisions/049-piled-copy-empty-region.md)，并补齐[图像保存取消的两类证据](decisions/050-image-save-cancellation.md)：32 项编码器内部暂停／取消案例和 18 个页面及时停止场景。当前仍只允许一个活动 Window；051 多窗口在独立工作目录实现，尚未验证，不属于本版本。

[完整回归 34931803098](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931803098)在 `f1f6a3d` 通过 **1,118 项 Node、846 项浏览器和 6 组直接运行时**，全部 14 个 job 成功。浏览器为 723 常规、57 游戏库、59 PWA、7 可信生命周期，所选测试零失败、取消、跳过、flaky 或重试；上述 32／18 项已分别包含在总数内。[兼容检查 34931188627](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931188627)在 `54ecd16` 使用[构建 34931093453](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931093453)的精确产物通过 **78 项**，三浏览器各 26 项；到 `f1f6a3d` 应用源码与构建配置没有变化，兼容结果对应该原构建。

047 首次完整回归的 Page crashed、049 首次完整回归的 V8 SIGTRAP（19 项未报告）和四项浏览器失败，以及 050 首轮的复制正对照失败均保留。[20 次原 player 场景诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931403366)通过且未收集到新原生报告；它和最终绿色回归均不证明历史崩溃根因已修复。完整非插件目标继续进行，完整多窗口、其余图形／系统 API、流式媒体、旧视频编码和菜单嵌套事件等仍未完成。

以下按阶段保留此前实现、失败和验证历史。

Layer.neutralColor 已实现每个实例独立的可写 32 位颜色，接入图像扩容／重建、仿射清除以及无主图 opaque 图层的自身填色；保留旧像素、province 零填充、透明组背景和真正 type 变更的默认值规则。piledCopy 另在 onPaint 前检查来源与目标主图。实现与剩余组合边界见[决策 046](decisions/046-layer-neutral-color.md)。

阶段 046 的[完整回归 34930172005](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930172005)在 `551b97d` 通过 **1,043 项 Node、786 项浏览器和 6 组直接运行时**，全部 14 个 job 成功；浏览器为 663 常规、57 游戏库、59 PWA、7 可信生命周期，所选测试零失败、取消、跳过、flaky 或重试。[原 KAG／离线升级 34929350970](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929350970)在 `259c892` 使用[构建 34929264074](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929264074)的精确产物通过 **78 项**；后续 `551b97d` 仅改浏览器夹具，应用源码相同。

046 首轮 Node 的 2 个预期失败和首次完整回归的 19 个浏览器失败继续保留。18 个浏览器图形夹具已明确初始类型／颜色；PNG 停止用例的点击晚于编码完成，046 的绿色重跑不能证明这一时序已修复。阶段 050 的新观察器与编码器内部取消矩阵分别增加证据，不改写这次历史失败，也不作为真实用户延迟的测量。

上述为阶段 046 当时的结果。047 的[首次完整回归 34930203580](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930203580)仍保留浏览器 821/822 通过、1 项 WebKit JSPI 启动用例 Page crashed 的失败状态；047、049 与 050 当前通过范围以本文开头的组合版本为准。

以下为此前阶段记录，保留当时的范围、后续计划及通过／失败历史。

Layer.update 与 onPaint 重绘链路已接通：支持整层／矩形请求、默认 action owner、请求合并、回调后续重绘、异步处理和各图层独立截止时间；快速更新一个图层不会让另一个图层长期得不到绘制。实现和区域性能边界见[决策 045](decisions/045-layer-redraw.md)。

最新[完整回归 34927280464](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927280464)通过 **1,019 项 Node、750 项浏览器和 6 组直接运行时**；同次构建的[原 KAG／离线升级检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927347461)通过 **78 项**。本阶段新增 32 项 Node、24 项浏览器检查，所有用例零失败、取消、跳过或重试。

下一步继续可写 neutralColor、无主图像的不透明图层填色以及其他图形／系统接口；完整多窗口、流式媒体、旧视频编码、菜单嵌套事件等仍未完成。整体非插件目标继续进行。以下按阶段保留此前范围与验证历史。

Layer 与 Font 已接入原生生命周期：基本父子关系使用弱观察，children 缓存、输入角色和转场分别持有实际需要的强引用；失效会按顺序停止转场、断开图层、清理字体和图像，并支持失败重试。实现与明确限制见[决策 044](decisions/044-layer-object-lifetime.md)。

[完整回归 34926303139](https://github.com/fenghengzhi/krkr2-web/actions/runs/34926303139)通过 **987 项 Node、726 项浏览器检查和 6 组直接运行时**；相同应用源码的[原 KAG／旧版本离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34925944413)通过 **78 项**。本阶段新增 69 项 Node 和三浏览器双后端的 48 项浏览器检查；三轮历史失败均保留。

下一步继续 Layer.update／onPaint 重绘链路、neutralColor 及其他图形和系统 API。重绘分支的 Node 诊断已通过，但完整回归仍在执行，尚未合入此版本；完整多窗口、流式媒体、旧视频编码、菜单嵌套事件等也仍未完成。整体非插件目标保持进行中。

以下为此前阶段记录，保留各阶段当时的范围与验证结果。

MenuItem 已接入原生生命周期：私有状态持有 action owner、子项和缓存，parent／Window 使用弱观察；点击在实际派发期间持有目标，用户修改 children 数组不再影响事件路由。脚本终结器与资源失效分开，支持清理失败后的重试和会话终止时的原生引用释放。实现、当前验证及保留的失败记录见[决策 043](decisions/043-menu-object-lifetime.md)。

当前版本的[完整 GitHub Actions 回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921937558)通过 **918 项 Node、678 项浏览器检查和 6 组直接运行时**；[原 KAG／离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34922607852)另通过 **78 项**。其中包括 12 组源码／字节码菜单报告、24 组原生状态检查，以及菜单缓存、重试、排队失效和挂起回调的实际集成测试。

下一步继续 Layer 的生命周期、字体对象和输入持有关系；完整多窗口、其余图形／系统 API、流式媒体等仍未完成。菜单 popup 的嵌套事件和部分平台行为也仍有明确限制，整体非插件目标继续进行。

以下保留此前阶段的实现与验证记录。

Window 生命周期的[完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34914435535)已通过 **900 项 Node、678 项浏览器检查和 6 组直接运行时**；[原 KAG／离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34913200791)另通过 **78 项**。[最终证据报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34916018555)绑定 543 份证据，矩阵 SHA-256 为 `e5a2da13b7838024e29c01b51c03c8629377d4a7d8aa6cb21e6eb59c7a435f5e`。

Window 现使用实际对象的弱登记和原生失效入口；清理前保留成员可见性，等待视频关闭，再处理托管对象。输入、resize 和菜单事件只在投递时临时持有窗口；窗口属性按实例路由，旧窗口清理与替代窗口隔离。primaryLayer 为只读查询，惰性菜单、登记去重／移除、析构异常和重试已有验证。三浏览器双后端包括 156 个真实 Window 场景、264 个原生失效入口场景和 216 个撤销登记场景；独立句柄、对象和分配诊断也通过。详见[决策 042](decisions/042-window-object-lifetime.md)。完整多窗口、Layer、MenuItem、其他图形／系统 API 和流式媒体等仍未完成，全部非插件目标继续进行。

以下保留此前阶段的实现与验证记录。

视频生命周期的[当前版本完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905170428)已通过 **776 项 Node、678 项浏览器检查和 6 组直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34905448820)另通过 **78 项**。[最终证据报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34906206305)已通过，绑定 543 份证据；矩阵 SHA-256 为 `7996d5d822fbdbbc1acde1c019e247a3cb60b994f474cbe766d6fe78e2921a5d`。

VideoOverlay 自身、窗口和图层引用现采用独立弱观察；后台事件按实际投递持有对象，完成或取消后回收。临时返回对象在显示后释放；视频打开竞态、创建回滚、异步关闭等待及取消/关闭过程中单项失败后的继续清理已接通。三浏览器双后端覆盖 120 个真实视频 Session 场景、144 个弱引用返回/collect 场景，另有 18 个浏览器视频宿主场景、96 个受控音频故障点和 9 个对照。独立对象、句柄、分配诊断也通过，详见[决策 041](decisions/041-video-object-lifetime.md)。Window、Layer、MenuItem、完整图形/系统 API、流式媒体等仍未完成；窗口断开事件的精确原生时序及历史 SIGSEGV/WebKit 中断仍需继续定位。全部非插件功能尚未完成。

此前声音生命周期的[完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34895849611)通过 **710 项 Node、651 项浏览器和 6 组直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34894024462)另通过 **78 项**。[声音阶段证据报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34897329847)通过，绑定 542 份证据，矩阵 SHA-256 为 `bd7c8848e1e0183457644d67a8f6dbfbf41a8a951576db2f608046e7e60307da`，可信冻结为 21,053.1 ms；原始证据继续保留。

声音实例现由服务弱观察，后台事件独立持有并支持动态成员替换，失效时取消事件并等待异步关闭。外部 flags、labels 的失效和 filters Array 的独立所有权已接通；后端阻止迟到解码重新加载关闭资源，Headless 空闲时钟会停止。三浏览器双后端覆盖 60 个真实声音场景、168 个从属对象场景；独立句柄 64 项、对象 120 项和分配诊断均通过，详见 [决策 040](decisions/040-sound-object-lifetime.md)。TJS ABI 5 新增 `soundObjectLifetime: 1`，字体 ABI 2、协议 9 不变。

原引擎不收集任意引用环。历史会话中断等未定位问题保留，原始失败不会被后续通过覆盖。当前状态以最上方的窗口回归与决策 042 为准。

[宿主生命周期最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34883625695)已通过，绑定 542 份证据。矩阵 `out/verification/host-object-lifetime-matrix.json` 的 SHA-256 为 `e2c75876777e77b4b834551a7558d3527e4431ef5f7daf6180fd85d148368d9c`，可信冻结为 21,059.1 ms。

[完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34882175516)通过 **594 项 Node、639 项浏览器和 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877215012)另通过 **78 项**。本轮还有 64 项隔离宿主句柄、120 项隔离对象终结和 20 次 WebKit 字体取消/重启检查。双后端分配诊断通过 600 次观察/升级/销毁、20 次集合清理、1,064 次执行和 188 次字节码分配失败。

宿主句柄释放已处理异常、重入和主错误保留；Timer/AsyncTrigger 使用弱注册和实际事件的独立持有，支持隐式回收、失效重试及暂停/取消。VM 退出会继续清理关键字表和字符串池，Asyncify 在异步调用前检查挂起空间。TJS ABI 5 新增 `hostObjectLifetime: 1`，字体 ABI 2、协议 9 不变，范围见 [决策 039](decisions/039-host-object-lifetime.md)。

声音生命周期正在独立工作目录实现，尚未验证；Layer、Window、VideoOverlay、MenuItem、完整图形/系统 API、流式媒体等仍未完成。原引擎引用计数不收集任意引用环。两次 WebKit 会话提前中断和一次缺少原始分配栈的历史故障仍无确定根因，重复通过不代表它们已被证明修复。以下保留历史阶段记录，当前状态以本段和决策 039 为准。

[对象终结最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34868705139)已通过，绑定 530 份证据。矩阵 `out/verification/object-finalization-matrix.json` 的 SHA-256 为 `0387418a08e9a011d261937358510575a31f10061efaaff1e67c7ae910217d51`；本轮可信冻结为 21,055.1 ms。历史矩阵与失败记录继续保留。

最新 [对象终结完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34866740979) 通过 **466 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34867143808) 另通过 **78 项**。对象终结专项包含三浏览器双后端 360 个场景组合、48 条暂停/取消路径，以及 [120 个隔离进程用例](https://github.com/fenghengzhi/krkr2-web/actions/runs/34867147315)。[分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34866791836) 通过 20 次清理、1,063 次执行和 188 次字节码分配失败。TJS ABI 5 新增 `objectFinalization: 1`，字体 ABI 2、协议 9 不变。实现和原始失败见 [对象终结](decisions/038-object-finalization.md)。

TJS2 原有引用计数不自动收集任意引用环，本轮验证显式断环、终结器异常、构造主异常、保留自身和 8,192 层对象链清理。宿主句柄队列及 Timer/AsyncTrigger、声音、图层等隐式资源回收仍待实现，完整非插件目标保持进行中。以下保留历史阶段记录，其中对象环的范围以本段和决策 038 为准。

最新 [执行资源完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858757086) 通过 **398 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34859159783) 另通过 **78 项**。已限制执行深度和临时寄存器/参数载荷，修复退出帧残留值、部分原生类/Array 构造回滚；暂停/取消覆盖实际参数复制及深层宿主挂起。双后端 [1,063 次执行分配失败与 188 次字节码分配失败](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858195933) 全部通过。TJS ABI 5 增加 `executionBudgets: 1`，字体 ABI 2、协议 9 不变。范围见 [决策 037](decisions/037-execution-budgets.md)，完整非插件目标仍在进行。

[执行资源最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34860651997)绑定 519 份证据，矩阵 `out/verification/execution-budgets-matrix.json` 的 SHA-256 为 `2079d47f87fd1f035b7eb7626249a183fbef66a2b0723f93ebe458e80a78c109`。本轮可信冻结 21,052.5 ms；本地仅恢复经过验证的云端构建，未运行测试。任意对象环、隐式终结器异常、其他宿主生命周期及下表未完成能力继续保留在目标范围内。

此前 [字节码生命周期完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34849454871) 通过 **392 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34848253401) 另通过 **78 项**。常量池、上下文构造和链接支持暂停/取消、失败回滚和构造预算；六组生命周期检查及 36 条控制路径验证了显式实例清理后的资源释放。两种后端共 **188 次分配失败**和 **20 次 WebKit 冷离线重启**通过。TJS ABI 5 新增能力标记 `bytecodeLifecycle: 1`，详见 [决策 036](decisions/036-bytecode-lifetime.md)。

[最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34850540242)已绑定 554 份证据；矩阵 `out/verification/bytecode-lifetime-matrix.json` 的 SHA-256 为 `c3c5c665b1de52cc989edc0a3abad39001c0db1fc560baa49b1dfe63f798089b`。本轮可信冻结为 21,059.7 ms，没有计入历史额外冻结；此前各阶段矩阵和失败记录继续保留。

深层调用/try 栈预算及临时实例退出寄存器后的释放已由 [决策 037](decisions/037-execution-budgets.md) 接续。任意对象环回收、隐式终结器异常、其他原生分配/宿主对象路径和下表非插件条目仍未完成。历史 WebKit JSPI 页面崩溃在此前 20 次独立重启中未复现，原 KAG 异常成员名称也仍无确定根因；原始失败持续保留，目标保持进行中。

此前二进制脚本阶段的 [GitHub Actions 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34841387392)通过 **384 项 Node、639 项浏览器测试及 6 项直接运行时专项**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34840621607)另通过 **78 项**原 KAG 和跨 ABI 离线升级。新增 KBAD 资源、二进制文件偏移、字节码结构检查和反序列化暂停/取消；菜单更新保留节点，视频等待首帧并通过媒体时钟补充区间事件。TJS ABI **5**，能力标记为 `cooperativeCompilation: 1`、`binaryScripts: 1`；字体 ABI **2**、会话协议 **9**。范围与失败历史见 [二进制脚本](decisions/034-binary-scripts.md)及 [视频首帧](decisions/035-video-readiness.md)。

该阶段的 [最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34842156097)已通过，矩阵为 `out/verification/binary-scripts-matrix.json`，SHA-256 为 `b941be09c8d5803d19a8c1014fad9b8dfa1a78351a17734808133117cd1c3041`。报告绑定 496 份证据、12 条二进制控制路径、36 条编译控制路径、24 条页面控制检查和 6 份视频呈现/像素附件；可信冻结为 21,052.3 ms。此前矩阵和本轮所有失败继续保留。

一次 WebKit JSPI 原 KAG 启动出现异常成员名称，随后关闭/开启脚本调用栈各 20 次独立诊断均未复现；原失败仍保留，未宣称根因已解决。该二进制脚本阶段尚未覆盖构造失败所有权和原生分配统计；后续字节码生命周期阶段接续这些工作。深层调用/try 栈预算和其他非插件条目仍未完成。所有执行都在 GitHub 托管 runner 上进行。

此前长脚本编译阶段的 [完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829312486)通过 **371 项 Node、621 项浏览器测试及 6 项直接运行时专项**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829383281)另通过 **78 项**。源码准备、解析/代码生成和导出共有三浏览器双后端 36 条暂停/取消控制路径，详情见 [长脚本编译](decisions/033-cooperative-compilation.md)。

此前的 [原生 Scripts 报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34825096969)继续保留在 `out/verification/native-scripts-matrix.json`，绑定 495 份证据，SHA-256 为 `1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d`。编译控制和二进制脚本各用独立矩阵，不覆盖历史记录。

编译阶段的 [最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34830361115)保留为 `out/verification/compiler-matrix.json`，SHA-256 为 `bd314e7bf7383553468685c6cea0db2d53998f265dd09b882d09733cdc7c55b9`。其中包含 495 份证据、36 条编译控制路径和 6 份视频呈现/像素附件；可信冻结为 21,053.2 ms。二进制资源与结构检查由新阶段接续，完整 VM 审计仍未完成，原生分配统计由后续字节码生命周期阶段接续。

上一轮完成的 [GitHub Actions 回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815634377)通过 **351 项 Node、609 项浏览器测试及 6 项直接运行时专项**，所选用例无失败、跳过或 flaky，未使用测试重试。[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814325349)另通过 72 项原 KAG 与跨 ABI 离线升级，输入时序另有 30 次三浏览器双后端复测通过。完整非插件目标仍未完成。

原生 `Scripts.getTraceString(limit=0)` 与“脚本调试”启动开关已接入，该已验证阶段 TJS ABI **4**、字体 ABI **2**、会话协议 **9**。调用栈在异步挂起、嵌套回调、字节码和取消时保留已验证的位置与顺序；其他 TVP 桥帧、原生错误界面和隐式回收路径仍需继续对齐。设计和失败分析见 [脚本调用栈](decisions/031-script-stack-traces.md)。[最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34816691294)保存为 `out/verification/stack-traces-matrix.json`，绑定 503 份证据，SHA-256 为 `9babc637693f500efb1a04399f246f037ee5f32ba16090d78d2ab6113ec0a9df`。

目标：完成架构规划中的非插件引擎与 Web 平台能力，不能以最小示例或部分测试通过替代完成。插件注册机制保留；原生 DLL、Emote/MotionPlayer 等插件实现不在当前目标内。

本文件记录完整范围和证据缺口。此前的首个实现属于实际进展，但远未证明当前目标完成。

VM 控制台阶段的 [最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812958010)已通过，标准矩阵为 `out/verification/vm-console-matrix.json`，绑定完整回归、66 项兼容性、3 次可信长冻结与 487 份证据。报告 SHA-256 为 `81beb0d8763cfc667c01b6e799d561ab80db8fb9944cba4c1e40408a9f18059d`；详细归档与执行方式见 [测试说明](testing.md)。

VM 控制台阶段已补原生 Console/Controller 类、编译警告与诊断回调、可挂起的 compile 和独立 Scripts.dump 文件。38 项 Node 专项、36 项浏览器面板/VM 检查、6 项直接运行时探测和 6 项冷离线检查通过；本地完整回归已按用户要求中止，后续验证改由 GitHub Actions 执行；新的完整回归已在 GitHub Actions 通过；另有 [GitHub Actions 兼容性运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812505215)通过全部 66 项原 KAG、菜单、异常恢复与 TJS/字体跨 ABI 离线升级检查。TJS ABI 升到 3，字体 ABI 2、会话协议 9 不变。范围见 [VM 控制台](decisions/029-vm-console.md)。

调试面板阶段已接通 Console/Controller 的只读对象、独立显示状态、暂停/失败中的页面操作和焦点恢复。新增 3 项 Node 和 18 项浏览器测试；完整 `npm run check` 通过 **331 项行为/集成与 579 项浏览器测试**（462 常规、57 游戏库、53 PWA、7 原生生命周期），无失败或跳过，原生 trusted 冻结为 **21,055.2 ms**。原 KAG 菜单/快捷键 6 项、综合场景 36 项，以及 TJS ABI、字体 ABI、协议 8→9 各 6 项离线升级检查通过。权威日志为 `out/verification/debug-panels/check.log`，最终证据见 `out/verification/debug-panels-matrix.json`。会话协议为 9，TJS/字体 ABI 均保持 2。范围见 [调试面板](decisions/028-debug-panels.md)。

Debug 日志阶段已接通历史/重要消息、文件输出开关、绑定闭包观察回调、主要异常保留和日志/游戏提交隔离。完整 `npm run check` 通过 **328 项行为/集成与 561 项浏览器测试**（444 常规、57 游戏库、53 PWA、7 原生生命周期），无失败、跳过或 flaky。另有 **96 组原 KRKR2 日志参考、36 项原 KAG 场景、6 项 KAG 异常日志与恢复、6 项 TJS 跨 ABI 和 6 项字体跨 ABI 离线升级检查**通过。范围见 [Debug 日志](decisions/027-debug-logging.md)。

Debug 阶段完整日志为 `out/verification/debug/check.log`，最终证据由 `out/verification/debug-matrix.json` 绑定并再次校验。原生 trusted 冻结实测 **21,054.8 ms**，110 份持久 context 记录保留独立的 30 秒准备/清理与 30 秒正文预算。TJS/字体 WASM ABI 均为 2、会话协议为 8，本阶段保持不变。主机重启前一次 WebKit 视频暂停位置异常未复现，原因仍未确认；失败、严格复测与媒体时钟记录全部保留，不能将它标记为已修复。

纵排阶段已补 Unicode 17 BMP 朝向、vert/vrt2 字形选择、呈现形式回退、文件字形变换、竖向装饰线及没有竖排度量表时的游戏家族路径。原 KAG 负责 ruby、纵中横和禁则，无需替换其排版脚本。完整 `npm run check` 通过 **308 项行为/集成与 537 项浏览器测试**（426 常规、57 游戏库、47 PWA、7 原生生命周期），所选案例无失败或跳过。最终构建另通过 **36 项原 KAG 场景、18 项文字排版场景、6 项 TJS 跨 ABI 与 6 项字体跨 ABI 离线升级检查**。实现边界见 [纵排文字](decisions/026-vertical-text.md)。

纵排阶段修复了升级后旧字体发布资源的离线查找，保留了修复前的失败日志和浏览器 trace。该阶段原生 trusted 冻结间隔为 **21,054.1 ms**。历史完整日志为 `out/verification/text-layout/check.log`；源码、测试、发布文件、原生参考与外部场景由 `out/verification/text-layout-matrix.json` 绑定。字体 ABI 为 2，TJS ABI 2、会话协议 8 保持不变。

字体选择阶段已加入 getList 筛选、游戏家族/样式绑定、HTML 选择与真实字形预览、点击触发的本机字体读取、取消/停止和过期结果隔离。完整 `npm run check` 通过 **301 项行为/集成与 522 项浏览器测试**（417 常规、57 游戏库、41 PWA、7 原生生命周期），所选案例无失败或跳过。新增 11 项 Node、27 项浏览器测试和 256 组原生筛选参考，6 个既有字体离线冷启动案例也验证了选择器。真实 Chromium API 另在隔离测试 context 中完成枚举、预览与选择。会话协议为 8，TJS/字体 WASM ABI 保持 2/1。设计与剩余范围见 [字体选择](decisions/025-font-selection.md)。

字体选择阶段构建另通过 **36 个外部 KAG 场景和 6 个跨 ABI 离线更新场景**。该阶段原生冻结间隔为 21,053.9 ms，事件均为 trusted。历史完整日志为 `out/verification/font-selection/check.log`；源码、配置、发布文件、原生参考与独立探测由 `out/verification/font-selection-matrix.json` 绑定。前一字体几何阶段的统计与矩阵在下文作为历史记录保留。

字体几何阶段已加入 Rect、getGlyphDrawRect 和独立 FreeType 文件字体后端。337 对矩形、25,200 组坐标和 512 组原生字形对照通过；缺字回退、损坏字体恢复、内存增长后的数据所有权、取消与释放均有检查。设计与边界见 [字体几何与后端](decisions/024-font-geometry.md)。

字体几何阶段完整 `npm run check` 通过 **290 项行为/集成和 495 项浏览器测试**（390 常规、57 游戏库、41 PWA、7 原生生命周期），包含 6 个字体离线冷启动案例。长冻结测试的准备阶段有独立的 30 秒 fixture 预算，正文仍为 30 秒，实际冻结仍须超过 21 秒。此前的 WebKit 停滞、主机重启中断和冻结测试失败分别保留证据；完整检查日志为 `out/verification/font-geometry/check.log`，外部场景与最终矩阵另行记录。完整非插件目标仍在进行。

字体几何阶段最终构建另通过 **36 个 KAG 场景、6 个跨 ABI 离线更新场景和 6 个实际字体画布组合**。该阶段原生冻结记录为 21,053.1 ms，事件均为 trusted。源码、测试、构建、字体/TJS WASM 与全部证据由 `out/verification/font-geometry-matrix.json` 绑定；历史失败与中断日志一并保留。

| 要求                                                                | 当前证据/下一步                                                                                                                                                                                                                                                                                                  | 状态   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TJS2 源码/字节码、值桥、回调、异步、调度、生命周期                  | 已有源码/字节码校验、构造回滚、执行预算和分配账本；已验证终结器异常、显式断环和有界深链释放，继续宿主句柄异常/重入及实际宿主资源回收，并追踪历史 WebKit 页面崩溃和原 KAG 成员名称错误                                                                                                                            | 进行中 |
| 文件集合、XP3/ZIP、文本编码、资源查找、补丁/auto-path               | 已修正 adlr/保护位解释，补限定归档路径、auto-path、文本编码与文件流；ZIP stored/deflate、ZIP64、Unicode、CRC 与 HTTP Range 已接入；嵌套包、其他归档变体及完整路径规则仍未完成                                                                                                                                    | 进行中 |
| KAGParser：标签、宏、条件、调用栈、保存恢复、宿主回调               | 已实现 TS parser + TJS 回调桥，通过原有 Conductor 的宏/等待/异步/call/return；继续扩大边界差分与完整 KAG 流程验证                                                                                                                                                                                                | 进行中 |
| Timer/AsyncTrigger/事件、Window、完整输入与系统 API                 | 已补窗口生命周期与 mainWindow 查询、焦点/模态、鼠标/触摸捕获、脚本命中、键盘/提交文字和异步输入；System 事件/连续回调、异常处理与菜单门控已接入；051 页面内多窗口及 052 Window.showModal、输入 ACK、原生检查点与轮次尾部已验证；Menu.popup 新嵌套业务未验证未合入，手势/完整 IME、原生全屏和全部事件重入仍需补齐 | 未完成 |
| Debug 历史、文件输出、回调与调试界面                                | 日志历史、UTF-16LE 文件、异常观察与写入故障隔离已接通；Console/Controller 原生类、VM 控制台、脚本转储和可选原生栈追踪已接通；错误 UI 策略和其他异常/回收路径仍待实现                                                                                                                                             | 进行中 |
| Layer/Bitmap：图像坐标、排序、裁剪、像素/命中、混合、转场           | 已补 26 种像素混合、矩形/缩放/仿射、类型转换/灰度/模糊、整图翻转、Gamma、组透明度、转场、onPaint、截图和 BMP；046/049 已验证可写 neutralColor、无主图 opaque 填色、piledCopy 主图校验及空区域/回调裁剪顺序；其他像素方法和完整几何/转场差分仍未完成                                                              | 进行中 |
| 字体与文字：度量、布局、ruby、纵排、显示一致性                      | 已补 FreeType、Rect/边界、预渲染、选择/样式、Unicode/GSUB 纵排、装饰线及 KAG ruby/纵中横场景；Windows 字体替换/字符集、复杂 OpenType、集合多 face、缓存生命周期与全部最终混合仍待验证                                                                                                                            | 未完成 |
| BGM/SE/语音、循环点、seek、fade、完成事件、流式 PCM                 | 已接通 Wave/MIDI、AudioWorklet 混音、SLI 标志/标签/循环、定位/淡出/完成事件，验证 WAV/Vorbis/MP3/MIDI；边解码边播放、完整 MIDI、CD 映射和精确滤波仍待完成                                                                                                                                                        | 进行中 |
| 视频、时间戳、逐帧合成、资源释放                                    | 已实现 VideoOverlay、MP4 显示时间索引、浏览器遮盖/双图层输出、定位/循环/事件及媒体声音；旧编码、其他容器帧索引、完整 mixer、流式读取与精确事件时序待完成                                                                                                                                                         | 进行中 |
| 游戏写入、文本/二进制流、存档事务、导出/导入、刷新恢复              | 原生文件流、IndexedDB、导出/导入已接通；KAG 普通存档、两种缩略图和刷新读档已有实测，复杂场景与媒体恢复待扩大验证                                                                                                                                                                                                 | 进行中 |
| IndexedDB/OPFS、HTTP Range、缓存预算、版本/中断处理                 | 已有 IndexedDB 存档/游戏目录事务、图像 LRU、HTTP Range 与 OPFS 完整资源副本、块校验/缓存和中断恢复；按块持久 HTTP 缓存、续传与统一预留仍待实现                                                                                                                                                                   | 进行中 |
| TLG 等非插件图像格式与专用算法                                      | TLG5/TLG6、SDS、PNG/GIF、索引 BMP、伴随平面、颜色键、PNG/TLG 写出和加载缓存/预加载已接入；有读取/运算对照和 192 个独立解码写出验证；其他变体与统一内存预留仍待实现                                                                                                                                               | 进行中 |
| 产品：游戏库、导入/恢复、设置、错误诊断、浏览器能力适配             | 已补本地/远程资源持久保存、库中启动与入口/后端设置、容量提示、取消/失败恢复和跨标签页删除保护；身份迁移、包导出与其他设置仍待实现                                                                                                                                                                                | 进行中 |
| GPU 丢失恢复、Worker/媒体清理、后台/前台策略、PWA/静态发布          | 已补 GPU 恢复、用户/图形/页面暂停协调、后台设置与输入/媒体门控；PWA 外壳及更新已验证；移动系统/BFCache、后台长请求、实体 GPU/驱动压力和性能等仍待验证                                                                                                                                                            | 进行中 |
| 验证：参考 KAG 对话/选择/转场/声音/脚本存读档、三浏览器、差分与性能 | 052 与 055 组合版本通过 1,646 项 Node、1,095 项浏览器、6 组直接运行时及同次构建的 78 项原 KAG／离线升级；已合入 main。全部历史失败与未报告案例保留；Menu.popup 新业务、旧 VCL 未知项、历史 V8/WebKit 故障归因、真实用户控制延迟、完整差分与性能仍待验证                                                          | 未完成 |

WebGPU 是架构中的可选后端；应在正确性与性能证据支持时实施，不以它替代 WebGL2 的完整实现。PSB 若仅服务被排除的插件，跟随插件阶段；非插件资源格式需求仍属于当前目标。

纵排调试发现的 `Debug.logAsError()` 缺口已在日志阶段处理。Console/Controller 的原生类语义与 VM 控制台也已接入；Scripts.getTraceString 已接入；原生错误 UI 策略与其他异常/隐式析构路径仍待完成。

参考 `kag3_template.xp3` 已完成 KAGMainWindow 构造，并在浏览器显示 `first.ks` 的 “Hello, world!!”。本项目的场景由参考模板原有脚本处理：输入流程覆盖换行、历史层、翻页与文字选择；新增流程覆盖三种 trans/wt、变量/场景保存恢复、8 位/24 位缩略图和刷新读档。完整图形混合、复杂存档、媒体恢复及更复杂的输入/系统事件仍未证明完成。

原有 Conductor 的独立输出 `ABCD` 验证宏、定时等待、异步继续和调用返回顺序。浏览器报告与截图在 `out/verification/kag3_template-*-flow.*`、`*-save.*` 与 `*-transition.*`，通过 `tests/probes/kag-browser.ts` 重跑；无浏览器的 startup 探测因缺少字体后端不能替代画面验证。目标保持 active，所有尚未证明的条目仍未完成。输入设计与边界见 [输入决策](decisions/006-input-routing.md)。

2026-09-13 的 `out/verification/zip-matrix.json` 汇总了最近通过的完整检查、既有独立图形样本、16 个 ZIP 包的 90 次成员读取，以及 36 个 KAG 场景：XP3/ZIP × 三种浏览器 × 两种 WASM 后端 × 输入/存读档/转场。重打包保留原模板 30 个成员的全部字节，并由 Python 回读核对。所有 KAG 保存案例检查实际 BMP 字节与追加数据，再由原有 KAG 刷新恢复；PNG/TLG 另有浏览器备份/刷新回读案例。这些是选定案例的证据，不是完整商业游戏集合的证明。本轮完整日志、KAG 报告与截图保存在 `out/verification/zip/`；矩阵绑定实现、测试、构建、WASM 和资源哈希，此前阶段记录仍保留。

音频按源采样位置推进，由 TypeScript 混音器在 AudioWorklet 中执行；WAV/MIDI 在会话 Worker 解析，Vorbis 使用按需加载的独立 WASM 解码器消除已测得的浏览器长度差异。头尾标签、循环、淡出、暂停、错误和停止释放有自动验证。仍需流式背压与 seek、完整 MIDI 音色/控制器、CD/CUE 映射、平滑循环精确差分及声音对象隐式回收。详见 [音频决策](decisions/004-audio-clock.md)。

视频使用浏览器媒体元素解码；MP4Box 在 Worker 解析 CTS/edit list，图层帧以 RGBA 转移并通过确认限制在途数量。已验证带 B-frame 的 H.264、AAC 声音、双图层取样、seek/prepare、遮盖缩放、透明度、区间/周期事件与停止释放。WebCodecs/旧 MPEG-I/WMV 解码、长视频 Range、完整混合层/色彩控制、多流选择、严格原生事件顺序和无缝区间循环仍未完成。详见 [视频决策](decisions/005-video-presentation.md)。

图层显示对需要整体透明度的子树先做隔离合成，普通图层仍独立上传 WebGL；含基础或 Photoshop 混合的可见树在 CPU 使用共享整数运算，并与 piledCopy 共用结果。已开放全部 26 种图像类型，binder/effect/filter 仍是无图像节点。独立参考标量对照已扩展到 94,464 组像素，浏览器检查 23 种依赖背景的模式；这不等于完整原生 SIMD/像素或复杂组语义一致。矩阵/三顶点仿射、20 种采样枚举、clear、自复制和可暂停/取消采样已接入，仍需严格几何/采样差分、其他像素方法与性能工作。详见 [仿射决策](decisions/009-affine-rasterization.md)、[像素混合决策](decisions/008-pixel-blending.md) 和 [场景与图像存档决策](decisions/007-scene-transitions-snapshots.md)。浏览器 fullScreen 仍是页面内全屏。

Timer/AsyncTrigger 的隐式回收与所有权已由决策 039 验证，包含实际事件的持有、暂停/取消和失败失效重试。System.eventDisabled、连续事件已有独立实现与参考轨迹验证；052 又接入逐事件原生检查点及合法窗口更新尾部，并在实际 Window.showModal 的输入、计时器和停止路径通过验证。完整立即异常策略、其他宿主对象原生类型语义及全部原生差分仍未完成，不能以本轮通过认定全部生命周期已对齐。

图像处理新增 convertType/doGrayScale/doBoxBlur，并修正翻转应覆盖整图与 province 的行为。333 个数值对照案例使用 TVP 标量及修复了未初始化读取的旧 CPU 模糊参考；具体来源、范围和限制见 [图像处理决策](decisions/010-image-processing.md)。

TLG5/TLG6 解码与 TLG0 SDS 标签已使用纯 TypeScript 接入 loadImages 和规则图读取。310 个原生编码器样本逐字节通过，三浏览器双后端的颜色/透明度、Unicode 标签、转场与取消均通过；详见 [TLG 图像决策](decisions/011-tlg-images.md)。

伴随 mask/province、loadProvinceImage、四种颜色键及 PNG 位置/分辨率标签已接通。新增 TS PNG/GIF 和索引 BMP 解码，以保留隐藏 RGB 和调色板索引；110 个编码器样本与 12,288 个原生加载运算对照已通过。设计、格式/内存范围和有意不复现的原生异常见 [图像加载决策](decisions/012-image-loading.md)。

PNG、TLG5/TLG6 的 RGB/RGBA 写出已接入 saveLayerImage、IndexedDB 与备份恢复，192 个输出通过原生 TLG/Pillow 的独立解码；元数据、取消、原图与旧文件保留、模式和预算见 [图像写出决策](decisions/013-image-writing.md)。

解码图像缓存及 System.graphicCacheLimit/clearGraphicCache/touchImages 已实现，含 LRU 容量、独立副本、资源版本、并发去重、预加载优先级/预算/超时和取消。设计及原生策略差异见 [图像缓存决策](decisions/014-image-cache.md)。继续其他格式变体与像素方法、字体、系统事件及 Web 存储能力。

ZIP 中央目录、stored/deflate、ZIP64、文件名扩展、CRC 与浏览器导入已接通，16 个 Python 独立归档覆盖 90 次成员读取。另补 TJS 文件流写入路径预检，避免无效归档写入进入关闭后的待写队列。格式、预算、嵌套包/旧编码等限制见 [ZIP 资源决策](decisions/015-zip-storage.md)。

HTTP Range 来源、Worker 内身份准备与远程链接入口已接通。23 项来源边界和 4 项真实 HTTP/TJS 集成测试，以及三浏览器双后端的 36 项远程读取测试已通过；8 MiB 以上 XP3/ZIP 的启动流量低于文件的八分之一。版本变化、停机中断、完整下载降级及刷新存档均有验证。设计与限制见 [HTTP 来源决策](decisions/016-http-sources.md)，该阶段日志在 `out/verification/http/`。OPFS 和持久资源库随后已接入；流式媒体仍未完成。

HTTP 阶段完整 `npm run check` 已通过 193 项行为/集成和 243 项浏览器测试，无跳过；最新检查记录为 `out/verification/http/check.log`，来源/测试/构建哈希汇总为 `out/verification/http-matrix.json`。`zip-matrix.json` 保留 ZIP 阶段的 36 个原有 KAG 场景证据，本轮没有重跑该独立探测矩阵。

OPFS 游戏库已接通完整资源保存、按需分块校验、独立目录摘要、启动设置及跨标签页锁。原本 HTTP 阶段列为未完成的“OPFS/持久资源库”，已有上述实现进展；按块 HTTP 缓存、续传、身份迁移与其他未覆盖能力仍未完成。PWA 外壳随后独立接入。设计与验证范围见 [OPFS 游戏库决策](decisions/017-game-library.md)，本轮记录放在 `out/verification/library/`。

游戏库阶段的完整检查已通过 201 项行为/集成测试和 303 项浏览器测试，无跳过；常规 246 项与磁盘游戏库 57 项顺序执行，两组各用 2 个 worker，保留原来的用例和断言超时。新增确定性验证覆盖刷新恰好打断启动点击的竞态，并修复窄屏长名称溢出。权威日志是 `out/verification/library/check.log`，实现/测试/构建及配置哈希见 `out/verification/library-matrix.json`。HTTP 和 ZIP 阶段的矩阵作为历史证据保留，原 KAG 的 36 场景未在本轮重跑。

PWA 阶段已实现生产应用离线准备、完整发布文件校验、显式更新、旧标签页依赖保留和缓存驱逐修复。三浏览器均通过真实应用服务器关闭后的刷新、完整浏览器重启、OPFS 游戏/存档和离线声音/视频；存档提交失败阻止重新载入，库导入期间禁用更新重载。技术边界见 [离线应用决策](decisions/018-offline-app.md)。

本阶段完整 `npm run check` 通过 **209 项行为/集成和 338 项浏览器测试**：常规 246、磁盘游戏库 57、PWA 35。选中的案例无失败或跳过；额外的 WebKit 网络模拟案例因最小 Service Worker 对照也失败而显式排除，实际服务器关闭案例在三浏览器中保留。WebKit 磁盘测试的 trace 连续截图开销另经对照定位，只关闭连续截图，保留 DOM/网络 trace、失败截图、2 个 worker 和原有超时/断言。完整日志为 `out/verification/pwa/check.log`，最终源码/测试/配置/发布文件/WASM 哈希及中间失败诊断见 `out/verification/pwa-matrix.json`。原 KAG 的 36 个独立探测场景未在本阶段重跑；插件以外的整体目标仍未完成。

图形恢复阶段已实现 WebGL 上下文丢失时保留 VM/CPU 图像、用户与图形暂停协调、GPU 程序/纹理重建、首帧提交后继续、失败重试、停止取消和迟到通知隔离。另修复暂停期间 AudioWorklet 电平统计停更的问题；播放时钟保持冻结，统计按实际输出块继续报告。设计与限制见 [图形恢复决策](decisions/019-graphics-recovery.md)。

本阶段完整 `npm run check` 通过 **216 项行为/集成和 386 项浏览器测试**，其中常规浏览器 294、磁盘游戏库 57、PWA 35。新增 7 项 Node 测试和 48 项三浏览器双后端 GPU/媒体案例，选中案例无失败或跳过；既有 WebKit PWA 网络模拟排除项和 trace 配置保持不变。权威日志为 `out/verification/graphics/check.log`，源码/测试/配置/发布文件/WASM 哈希、逐项 GPU 案例和窄屏截图在 `out/verification/graphics-matrix.json`。本阶段未重跑外部 KAG 36 场景矩阵，也未进行物理显卡重置或长期显存压力测试。后台策略、流式媒体、字体与其余非插件接口仍未完成，整体目标继续保持进行中。

页面策略后的系统/输入工作已接入独立菜单与快捷键后台门控、排队 epoch、System.eventDisabled 与 add/removeContinuousHandler。当前鼠标/触摸/键盘包的 epoch 处理不能替代这些独立入口的检查；完整 IME、移动生命周期和 BFCache 仍需各自验证。事件禁用也不能简单复用页面暂停，否则可能阻塞脚本重新启用事件。

页面生命周期阶段已实现默认后台暂停/可选继续、freeze/pagehide 暂停、用户/GPU/页面状态组合、初始隐藏与停止重启、异步 TJS 成功/错误返回等待、旧 Timer/输入失效、主线程媒体控制及后台存档提交。另修复 WebKit 按钮被相同 textContent 更新打断点击的问题，用实际按住跨状态更新的案例验证。设计和边界见 [页面生命周期决策](decisions/020-page-lifecycle.md)。

完整 `npm run check` 通过 **230 项行为/集成与 438 项浏览器测试**：常规 339、磁盘游戏库 57、PWA 35、Chromium 原生生命周期 7，选中案例无失败或跳过。新增 14 项 Node 与 52 项浏览器案例；原生测试检查 isTrusted 的隐藏/冻结/恢复、双后端 VM 和媒体位置，并包含 21 秒冻结。三浏览器信号测试与原生测试分开记录，原有超时、并发、PWA 排除项及磁盘 trace 设置保留。权威日志为 `out/verification/activity/check.log`，源码/测试/配置/构建/WASM、原生事件、两次完整回归失败及其定位结果在 `out/verification/activity-matrix.json`。本阶段没有重跑外部 KAG 36 场景，也未证明移动强杀、BFCache、所有正在加载/seek 的请求排列或全部非插件接口，整体目标仍在进行。

System 阶段已补统一派发、连续注册和频率、异常闭包上下文、Timer 取队时容量、缓存替换、菜单与 popup 门控。30 项新增引擎/集成验证包括 10 组抽取原生函数的参考轨迹；设计与完整边界见 [System 事件决策](decisions/021-system-events.md)。完整 `npm run check` 已通过 260 项行为/集成与 462 项浏览器测试（363 常规、57 游戏库、35 PWA、7 原生生命周期），所选案例无失败或跳过。另有三浏览器双后端共 6 个 ABI 1 → 2 独立探测通过：真实关闭服务器后，旧标签页重建旧 Worker，新标签页启动新 Worker，两代发布资源各自保留。外部 KAG 的 36 个场景已全部重跑通过，覆盖 XP3/ZIP × 三浏览器 × 双后端 × 输入/存读档/转场。权威日志为 `out/verification/system-events/check.log`；源码、构建、WASM ABI 2、协议 6、原生参考、跨 ABI 和 KAG 结果的哈希见 `out/verification/system-events-matrix.json`，全部本轮材料保存在 `out/verification/system-events/`。整体目标保持进行中。

字体阶段已把物理光标观察从脚本事件队列分开，Layer.cursorX/cursorY 在事件禁用和输入等待期间也能读取新位置，后台观察按原策略忽略。此前文档将该接口误称为 Window 属性，已在字体决策中更正。字体文件加载与预渲染映射已接通；完整字体选择/枚举、复杂集合、缓存原生生命周期和所有字形一致性尚未完成。

字体与光标阶段的完整回归已通过 **276 项行为/集成和 474 项浏览器测试**，设计见 [字体决策](decisions/022-fonts.md)。原生提取对照覆盖 12 个字形和 30 组独立阴影参数；合成 TTF 的浏览器加载、字宽、位图存读及 1:1 画布像素已通过检查。既有媒体测试改为精确等待真实首帧回调，避免等待旧计数或误匹配脚本源码回显。回归中复现的 WebKit 图像加载停滞，经进程栈定位为私有流 releaseLock 与读取器 GC visitor 的内部锁等待，已调整清理方式；50 次原场景重复和 133 个真实流读取器的回收检查通过。原始失败、修复依据和完整日志保存在 `out/verification/fonts/`，详见 [私有流清理](decisions/023-private-stream-cleanup.md)。最终构建额外通过 36 个独立 KAG 场景、6 个跨 ABI 离线更新场景、6 个实际字体截图组合和 3,000 次隔离压缩/解压往返。`out/verification/fonts-matrix.json` 绑定本阶段源码、测试、截图、构建、WASM 和诊断证据；会话协议为 7，WASM ABI 2 与两种解释器产物未改变。完整非插件目标仍未完成。

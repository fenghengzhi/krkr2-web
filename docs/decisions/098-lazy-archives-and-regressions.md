# 098 按访问打开归档与回归修复

状态：开发候选已推送，尚待本批 GitHub-hosted Actions 执行。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，并未完成。会话协议 **38**，TJS ABI **5**、字体 ABI **2**。

实现提交 **`a9e3f97802392a374a9d07e5f5c6887fc30521a1`**，63 个文件，已推送到 `codex/migrated-window-attention`。[Full test suite 37335381893](https://github.com/fenghengzhi/krkr2-web/actions/runs/37335381893) 的首次唯一查询确认该精确提交，当时 **pending／conclusion=null**；未实时读取 jobs／artifacts。原返回保存在 `out/verification/github-actions/37335381893/initial-run-discovery.json`。本批结果留待下一轮回收，文档交接提交使用 `[skip ci]`。

本轮从 `e4a5fd1` 继续。所有构建、测试、类型检查、浏览器和可执行参考探针仅在 GitHub-hosted runners 运行；本地只检查和编辑源码，以及下载、解包、核对、解析历史原件。较大批次推送后，下轮取回结果，不实时监控。

## 固定的上一批证据

分别一次查询 096／`37322347188` 与 097／`37329111623` 的 run、jobs、artifacts 后冻结清单。**42 个原 ZIP、889,829,711 字节**全部 API SHA-256／大小匹配，其中 11 个旧包重新核对、31 个新包。总表为 `out/verification/github-actions/098-archive-summary.json`。最后一个 WebKit 大 ZIP 的截断原件及失败记录保留，按同一个冻结地址续取后核对完整哈希，没有重新刷新清单。

| 范围 | 096 终态 | 097 固定快照 |
| --- | --- | --- |
| run | completed／failure | in_progress／conclusion=null |
| jobs | 19 success、8 failure、2 cancelled | 11 success、1 failure、16 running |
| 原 ZIP | 29／861,802,117 字节 | 13／28,027,594 字节 |
| build | success | success |
| Node | 3,226 完整报告：3,194 pass、32 failure | 未报告 |
| 主浏览器 | 2,421 计划，1,962 pass、383 failure、76 未报告 | 未报告 |
| 原 KAG 兼容 | 96/96 pass | 未报告 |
| 直接运行时 | 6/6 failure，窗口清理异常 | 未报告 |

096 的 76 未报告来自取消的 Firefox shard 2（63）和 WebKit shard 2（13）；不能算成跳过或通过。游戏库 57/57、PWA 59/59 有完整通过报告。097 已报告 Chromium 游戏库 19/19。两批有界 Layer 生命周期诊断的 default／Liftoff-only 各三次二十项正常，不证明历史宿主堆崩溃根因已解决。冻结原包没有完整 core；不能假设不存在尚未发布的产物。

096 双 Windows 的 183 光标库存 strict 仍各 **536/596 matched、60 failure、3,178 uncompared**，mask 各 **3,770/3,770**。097 冻结时只拿到 Windows 2025 光标原件；Windows 2022 尚缺原 ZIP。历史失败与未比较继续保留。

## 归档访问与目录选择

固定原版 `StorageIntf.cpp` 的 ArchiveCache 仅在访问时打开归档，成功索引默认缓存 64 个容器。原件见 `out/verification/storage/097-project-root/source/StorageIntf.cpp`，固定提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788`。原始包存在检查以及 add/removeAutoPath 不应读取成员索引。

候选把原始容器和成员索引分开：项目目录选择及原始文件导入不再统一解析每个包；限定成员访问才打开所需容器。成功索引采用 64 容器 LRU，同源并发合并，单个索引解析流程和有界等待队列，失败不缓存，停止立即撤销等待。永久挂载表不持有懒加载成员；AutoPath 表保存规范名字，避免绕过 LRU 长期保留整个索引和读取闭包。字体扫描只使用原文件及已经打开的成员，显式字体文件名可以打开对应归档。

原版直接查找失败后按注册顺序完整重建 AutoPath 表，后注册的同名文件覆盖先注册项。因此不能从后往前找到一个文件就停下，从而隐藏较早已注册损坏包的错误。原始 collection 导入仍保留明确的 Web 裸别名兼容入口；冻结项目模式遵循项目根及 AutoPath。

文件选择器改为当前目录枚举、真实进入归档时打开索引，并增加带当前对话框身份的目录 RPC。目录读取不进入已暂停的 TJS 串行队列；异步选择再次验证模态和会话可用性，停止、取消、脚本中止后迟到结果不能进入新窗口。保存选择在最后一次异步读取后重新检查覆盖状态。展示预算限制当前目录和祖先，不在打开选择器时扫描整棵资源树。

## 回归修复的依据

原版 Window 清理先执行登记对象的 finalizer，最后释放 Form。候选在这个阶段允许读取最后提交的窗口属性，禁止重新请求已经退休的宿主几何；原有生命周期与 mainWindow 失败断言保留。

Window 同步更新已经提交的画面，不应在同一次调用结束或宿主 Pad 操作时重复提交。候选按窗口记录成功呈现的画面版本，并把像素脏状态与待执行的 onPaint 队列分开。禁用游戏事件时发布现有像素不会消费回调；恢复事件仍会排空待处理队列。渲染失败和渲染期间的新修改不能被当成成功提交。

Pad 自更新夹具按原版每轮最多两次 Window 队列条目的规则保留四个调度／保存／暂停检查点。assignImages 的绘画夹具显式设置可见目标，避免把隐藏子图层当成原生窗口失效来源。VideoOverlay 无图 getter 的 real 零字符串按固定 TJS 的 `+0.0` 断言；失败重开在真实 TJS 内捕获，随后继续验证关闭状态和重试，不能先以未捕获异常终止 Session 再读取它。

多个旧像素夹具只扩大 canvas CSS 尺寸，新增的真实 viewport/content 裁剪会截去放大的像素，原报告因而采到页面背景。夹具改为同时缩放整个所属 Window，保留实际 backing、裁剪层级和严格 RGBA 期望。媒体校准补齐现有第九个 VFR 文件库存，视频跨窗口坐标按已经采用的 viewport 锚点更新旧期望，不能把这些旧夹具失败记成媒体像素通过。

实际页面另修 desktop 的起点对齐以及顶层无子菜单按钮误用整行宽度的问题，嵌入窗口位置和菜单换行仍按原几何断言验收。全屏夹具先等待 renderer 的 backing 达到严格的 1200×900，再记录已到达的 DOM 几何，避免把两个独立通道的一次中间快照当作完成状态。图像输入夹具在边框／sunken 设置后指定所需 innerSize，保留逻辑点击坐标断言。

096 Chromium 的 fragmented／interleaved 媒体原件显示：暂停 frame seek 的 currentTime 已为 0.5 秒、seeked 已完成，而新 rVFC 的 mediaTime 为 0.666667 秒。旧门禁把两种时钟强行当成相同的帧索引，导致尚未进入换轨和 RGBA 验收就等待超时。候选对暂停的公开 frame seek 分别检查精确媒体时钟和本次 seek 后的新呈现，拒绝旧时间戳、重复帧计数、旧图和取消后的回调；任意 PTS 查询、换轨完整 RGBA 比较及播放中时钟自然前进的规则保留。没有添加按某个文件硬减偏移的特例。

## 后续边界

本批新增 **36 个 Node、每浏览器 5 个定义**：归档 14 个 Node，窗口清理和选择器 9 个 Node／4 个浏览器，窗口画面提交 4 个 Node，媒体呈现门禁 9 个 Node／1 个浏览器。既有四个完整原 KAG 项目场景改用真正损坏的低优先级归档，并保留访问错误、注册错误、移除恢复和游戏库重启断言，这些增强不另计新增定义。

归档元数据预算是原始挂载及驻留索引共 250,000 个名字和 16 Mi UTF-16 名字单位；AutoPath／临时 collection 别名表另有相同上限，格式解码器保留单索引 64 MiB 边界。解析结果与验证中的描述符可能短暂共存，已接受的读取也可持有退出 LRU 的资源；这不是整个 JavaScript 堆只有 64 MiB 的承诺。原始包覆盖使用本引擎的不可变资源版本，不能宣称等价于原生已缓存 XP3 索引配合 OS 重新打开流的覆盖行为。详细审计在 `out/verification/storage/098-lazy-archives.md`。

本批候选及新增回归定义均尚待托管验证。原生光标严格差异、历史宿主崩溃、Firefox 媒体截图阻塞、更多媒体格式、真实游戏兼容及其他窗口回归仍有未闭合项。`Window.onFileDrop` 本轮完成了原版事件顺序及运行期导入生命周期的设计审计，尚未接入生产；目录拖放能力不能用虚构资源代替。下一轮补取 097 后续原件并回收本批固定结果。

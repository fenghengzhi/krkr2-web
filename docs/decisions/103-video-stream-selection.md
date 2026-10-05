# 103 视频流选择与上一批证据回收

状态：开发候选，尚待 GitHub-hosted Actions 验证。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，包含真实游戏从加载到退出的完整运行，未完成。本批从 `764bc10` 继续；协议 **41**、`nativeSystem:5`，TJS ABI **5**、字体 ABI **2**。

本地仅检查和编辑源码、操作 Git、下载／解包／核对历史原件；没有运行测试、构建、类型检查、浏览器或可执行参考探针。整批提交后只查询一次运行身份，下次取回固定结果，不实时监控。旧失败和未报告均保留。

## 固定回收与实际修复

101／`37348226922` 和 102／`37352789584` 的 run、jobs、artifacts 各端点只取一次。**20 份 ZIP、55,265,320 字节**全部符合 API 大小及 SHA-256；其中六份复用原包重新核对，十四份新取。总表为 `out/verification/github-actions/103-archive-summary.{json,md}`。

101 已终态 failure，18 jobs 为五成功、七失败、六跳过。构建报告七条测试代码类型诊断：`cursor-leave-order.test.ts` 使用超出 ES2022 的 `findLast`，连带回调类型丢失；`layer-set-pos.test.ts` 的两条移动输入缺少完整按钮字段。本批按原测试意图修订。101 应用 Node／浏览器／兼容性没有执行，不能算通过；双 Windows 的 323 光标 strict 仍各有 **477 failure**。

102 固定快照为 in_progress，13 jobs 为五成功、四失败、四运行。栈池 **ASan＋UBSan、TSan 各六场景正常退出**，这是使用生产池代码和受控值／分配器边界的原生 harness 证据。JSPI identity 诊断成功不代表真实 VM 栈池八项或应用套件通过。build 最终结果、Node／浏览器和新增 343 光标库存尚未发布，留待下轮取回。

原版退出参考在双 Windows 各 **7/8 observed**，菜单场景已到达 terminate 调用并执行 Timer 尾部，但等待返回超时。这个结果不能被解释为永不返回，也不能支持所有模态均会被 terminate 自动关闭。原失败保持。beginMove 的三项失败均在 SC_MOVE 调用之前，`invoked=false`；本批只补足输入 tag、实际命中 HWND、所有权与每个前置谓词的同次观测，保留原条件、七场景和一次按下，不声称已修复前置条件。

菜单参考追加一次受控关闭实验：读到 Timer 尾部后保留 500 ms 的原菜单状态；验证持有的进程、随机标题、PID、HWND／HMENU 树和真实 popup 状态后，仅向该 owner 发送一次 `WM_CANCELMODE`。整个场景仍在共同 20 s 时限内，记录自然返回、消息是否发送、干预前后事件。这个观察条件与历史自动退出实验不同；即使干预后正常返回，也不能改写历史超时或宣称 Web 自动关闭菜单的行为已匹配。生产 terminate 行为本批不变。

## 原版公开接口与模式差异

固定 2.32 stable 源码公开 `numberOfVideoStream` 只读属性和 `enabledVideoStream` 可写属性，没有公开 `selectVideoStream`、`getNumberOfVideoStream` 或 `disableVideoStream` 方法。setter 先执行 TJS 整数转换，再收窄为 uint32；无媒体图和越界索引不操作。选择视频流只操作视频组，不能重置音轨、播放状态、速率、循环或 Layer 归属。

Layer1／Layer2 是同一 renderer 的两个绑定槽，新选轨画面应进入当前仍有效的两个绑定。它们不是两条视频轨各自的输出。普通／Layer 模式动态读取 renderer 尺寸和平均帧长；Mixer 模式缓存初次建图的尺寸与平均帧长。因此 Web 使用独立的活动样本时间线和公开时钟：Mixer 保留原缓存，真实选轨的解码、图片和位置查找使用新轨。持续时间继续来自当前媒体图。

原版具体 splitter 是否支持 IAMStreamSelect 取决于媒体图，源码不保证任意 MP4 多轨或不同格式都能切换。这里的 MP4 选择是 Web 容器适配能力，不冒充所有 DirectShow filter 的实测等价。对短轨切换后超出范围的位置，当前适配要求新候选保持冻结媒体时钟并实际呈现；不支持时显式失败并回滚，不静默截断位置。

固定源及哈希审计在 `out/verification/video-tracks/103-streams/103-video-streams-audit.md`，格式审计在 `out/verification/video-streams/103-audit.md`；菜单 owner／HMENU 合同与受控实验在 `out/verification/system-termination/103-menu/103-audit.md`。各自保留源清单，不用当前 Web 实现充当原版参考。

## 有界的实际轨道替换

一次 MP4 解析保存原始顺序的全部视频轨元数据和样本时间线，活动视图保留整个库存。统一选择器同时选择视频和音频，保留原音轨入口作为兼容包装。所有选择均从保留的原始文件出发，支持切回旧轨；不能从已删轨的 Blob 再次选择。

选择器保留媒体 sample 原字节和地址，处理 regular／fragmented／interleaved／separate fragment 布局中被移除的轨、默认项、fragment 和索引。输入、轨数、样本、编辑列表及计算工作量有边界；畸形和不支持的偏移布局拒绝。原始源、活动 Blob、候选 Blob 和临时完整副本各自计入资源预算，失败不提前释放旧图。

Host 在切换前冻结实际媒体时钟。视频流切换允许画面、分辨率和节奏变化，等待新图的真实呈现后提交；暂停的纯音轨切换仍比较整幅 RGBA。旧图在提交前可回滚，提交后先退休再恢复播放，避免双图同时发声。会话暂停继续阻止播放；Stop 后的迟到成功回复不能发布候选快照或修改 Layer，但仍完成关闭资源。

## 托管验收与剩余范围

新增真实两视频／两音频夹具：64×48、12 fps 红色图案和 80×60、10 fps 蓝色图案，AAC 分别为 440／880 Hz；保留旧夹具字节和生成顺序。四种 MP4 布局分别记录独立 ffprobe sample／packet 哈希。单轨参考电影由 FFmpeg 直接复制对应码流，另保留完整 PNG 参考。

新增 **38 个 Node 定义、每浏览器 16 个定义**。Node 为格式与全轨时间线 28、编码资源 2、源码／字节码控制器 8，覆盖联合选择、完整样本原字节、资源预算／取消和迟到回复。浏览器覆盖 Asyncify／JSPI、源码／字节码、regular／interleaved、Layer／Mixer；比较整幅解码 RGBA、Layer 模式两个绑定的实际画布截图、时钟、音轨频率、回切、无效索引和 URL／音频图释放。这些是待执行定义，不是通过数量。

完整非插件目标仍包含历史浏览器失败、精确图形／字体／光标差异、完整 TVP 消息库存、更多媒体格式、实际操作系统边界及真实游戏验收。当前候选和历史已验证版本保持区分；本批不放宽已有完整像素断言或把超时写成通过。

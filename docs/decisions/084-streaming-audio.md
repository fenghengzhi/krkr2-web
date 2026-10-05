# 084 有界音频源与流式播放

状态：开发候选，尚未取得本批执行结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器。本批接通长 WAV／Vorbis 的按需 PCM 播放，修复 083 的测试类型收窄错误；不把新增定义、未运行工作流或历史中断记为通过。所有可执行验证只在 GitHub-hosted Actions 执行，整批推送后下一轮取回结果，不实时监控。会话协议 **29**，TJS ABI **5**、字体 ABI **2** 不变。

## 读取、解码与播放

此前 WaveSoundBuffer 先读取完整资源，再生成完整 Float32 PCM，分别受 64 MiB 编码文件和 128 MiB PCM 预算限制。现在真实 Session 将不可变 `Resource.source` 交给音频后端，Worker 保留解码器，AudioWorklet 只请求并持有有界 PCM 分页。没有把解码器、存储回调或整段长 PCM 跨线程传输。

- 文件／Blob、HTTP／OPFS 原有 ByteSource 能力穿过资源导入；保存覆盖层提供对应旧版本的不可变范围。只含未压缩段的 XP3 提供逻辑范围拼接，显式 Adler 验证仍走原完整验证路径。
- ZIP stored 条目第一次读取先以 1 MiB 块完成一次共享 CRC32 扫描，保留原本的完整校验要求。此路径内存有界，但**必须先读遍条目**，不能称为读取少量前缀就开始播放。Deflate、混合或压缩 XP3 不冒充随机读取，继续受完整回退大小限制。
- WAV 按 RIFF 块扫描元数据，跳过 data，保留 PCM8／16／24／32、float32／64、extensible subtype 和 smpl 循环支持；请求时只转换所需范围。非法范围、对齐、截断和非有限值显式失败。
- Vorbis 预扫描页头、lacing、前三个头包前缀及 EOS granule，仅保存有界逻辑流索引；随后有界解析 setup／首音频页以校准非零起点，验证实际消耗页的 CRC。相同声道／采样率的顺序链分开初始化并精确连接；格式变化或多路交织拒绝。`codec-parser@2.5.0` 从既有传递依赖提升为固定直接依赖，通过公开 parser／decoder API 一次解码一个 packet，避免整页 255 个 packet 形成巨量临时 PCM。
- Vorbis 跳转从对应逻辑流开头重放并丢弃前缀，以保存 decoder overlap／priming；成本 **O(prefix)**，没有宣称实现未证明的 granule 锚点随机跳转。页头扫描在 HTTP 分块缓存下也可能触发整个编码文件的网络读取，不能把逻辑跳过 payload 等同于所有后端都只下载少量字节。
- 其他编码继续走小文件完整解码回退；浏览器 `decodeAudioData` 支持哪些编码仍取决于浏览器，不是所有音频格式都已流式化。

起点校准依据 [Xiph Vorbis I A.2](https://xiph.org/vorbis/doc/Vorbis_I_spec.html) 及固定 v1.3.7 的 [vorbisfile.c](https://raw.githubusercontent.com/xiph/vorbis/v1.3.7/lib/vorbisfile.c)／[block.c](https://raw.githubusercontent.com/xiph/vorbis/v1.3.7/lib/block.c)：正起点从总样本数扣除而不补静音，负起点丢弃前置 PCM；首尾同页的短音频保留尾部裁剪规则。只包含 priming packet 的零输出页不能提前确定起点。违反非零起点的第二 packet 分页要求或页位置不一致时显式拒绝；相应真实 packet 重分页回归尚待托管执行。

## 预算与所有权

| 层 | 上界与释放条件 |
| --- | --- |
| 资源编码快照 | Session 无范围来源的完整快照合计 64 MiB，在读之前预留；失效立即阻止发布，已有 open/read 实际结算后才归还额度。共享存储 provider 不由单个声音关闭。 |
| 后端编码回退 | 已缓冲来源与范围来源的完整回退共享逻辑 64 MiB 预算；传输和临时副本另外存在，不宣称总 JavaScript heap 只有 64 MiB。 |
| 流式解码／I/O 队列 | 后端池最多两个实际活动任务，每个 decoder 串行；候选、排队和每声音请求都有上界。被取消的实际 decoder ready/decode 操作结束后才 free。 |
| 单次 PCM source | 最多 65,536 帧、8 个未结算读取、16 MiB 输出预留；借用输入每次最多 64 KiB。 |
| Vorbis 输入 | 最多 128 KiB packet、1,048,576 页和 256 个逻辑流；每次解码一个 packet，输出上限 4,096 帧，EOS 裁剪在源层完成。 |
| Worklet 分页 | 每页 4,096 帧、每声音最多 16 页、4 个待回包；最多 8 声道时预留 2 MiB。分页预留与旧完整 PCM 共同计入原 128 MiB Session 预算。 |
| 滤镜 | 原 64 MiB Session 工作区预算保留；播放包装器从两个扩为四个 256 帧块，按实际上界计费。单个输出采样最多跨 384 个源帧。 |

初始至多两页在 load 前准备，收到 load ACK 且打开任务仍有效后才提交新 decoder；失败不退休旧的有效流。ACK 之前先到的缺页请求有界保留，提交后处理，避免丢掉唯一请求而永久等待。每次打开使用独立 streamId，请求另有 serial；旧打开、旧页面回包和迟到错误不能作用于替代声音。

同一声音的已发送发布阶段串行至 ACK／提交收口，避免另一个打开取消已被消费者安装的候选，随后又失败而使消费者与 decoder 身份分离。尚未发送的旧准备仍可被新打开取代；close／cancel 不等待发布屏障，立即撤销权限并发送清理。

关闭可取消元数据及 PCM 的借用 I/O 等待，原 provider 的迟到结果被丢弃；它不会凭空中止 provider 本身。实际 decoder ready/decode/free 有明确顺序，借用资源预算仍等待原读结算。完整编码回退的实际大文件读取保留任务／额度至结算，不能快速取消后反复分配；HTTP Session 的整体停止使用现有网络取消路径。长扫描／重放定期让出主任务队列，避免只排 microtask 使 Worker 无法接收 Stop。

Session 控制取消现在先通知声音取消打开／读取，再等待脚本队列排空；单纯暂停混音无法唤醒挂起的 `WaveSoundBuffer.open`。资源完整快照尚未交给后端时也能停止调用者等待，实际读取与预算仍保留到结算。source／bytecode × range／buffered 四个真实 Session 用例要求 Stop 先于原读取返回完成，迟到字节不能继续执行 open 后的脚本。

## 缺页、循环与滤镜

缺页使该声音本量子剩余输出静音，不推进其源位置、边界标签或跳转；其他声音继续输出，fade 时钟继续按原规则推进。解码错误产生一次错误并停止，不能冒充自然 EOF。

无滤镜路径将源边界控制变化与首个可播放采样一起提交，保留 smooth loop 两侧的页面。高播放倍率跨越多个循环／标签时，预检完整步进再提交；缺页不能先改变标志或触发目标标签。单个输出步需要超过 16 个不同 PCM 页时明确报告预算错误，避免反复淘汰页面造成永久等待；恰好 16 页可分多次请求填满。

滤镜路径区分暂时缺数据与真实 EOF：保留部分 input hop、原生环缓冲的两次读取片段和 segment/label 信息，缺页不补零、不运行零输入 EOF、不前进 FFT 环。只有真实 EOF 保留原补零语义。单次输出先预检插值邻点与整个步进跨度；播放位置只在 prepare/advance 提交，预取不改变可见位置。挂起 hop 的动态配置在该 hop 完成后应用。

## 托管验收定义

新增测试文件共 **87 个 Node 定义**：资源范围 12、编码快照所有权 5、PCM 源 32、后端 13、分页 mixer 10、滤镜缺页 9、真实 Session 6；浏览器每项目新增双后端 2 个定义。数量表示待执行库存，不是通过数。

新增定义覆盖：资源快照和并发额度、不可变旧保存版本、真实 Blob.slice、超 64 MiB 的 ZIP／XP3；WAV 转换和稀疏大文件；真实 Vorbis 顺序／倒退／跨链／continued packet 对既有完整解码的精确 PCM；关闭、晚到输入和控制任务让出；后端 load ACK 竞态、替换失败、预算和释放；分页 LRU、stale 回包、另一声音继续输出、smooth loop／flag label；多级滤镜受控缺页与完整 PCM 的音频／标签／位置比较。

真实 Session source／bytecode 用大于 64 MiB 的稀疏 WAV，经 WaveSoundBuffer 打开、播放、远端跳转和停止，比较实际输出样本与标签。浏览器双后端用 72 MiB 编码／144 MiB 潜在 PCM 的原始 XP3，经真实 HTTP Range、Worker 和 AudioWorklet 验证前缀启动、实际非零混音输出、远端标签、缓存上界，以及有请求体挂起时的 Stop。现有短文件／MIDI／浏览器编码验收继续保留。这些都是**待运行定义**，尚不是通过证据。

## 本批回收的历史证据

082 与 083 的 run／jobs／artifacts 各取一次固定快照；固定清单的 **28/28 原 ZIP** 大小和 SHA-256 全部核对，包含 082 已有九份的复核。没有实时轮询，也没有覆盖旧快照。

[082／37242235256](https://github.com/fenghengzhi/krkr2-web/actions/runs/37242235256) 已终态 **failure**。Node **2829 pass／1 fail／2830**，唯一报告失败为光标 smooth scaling 原生像素蓝通道 expected 132、actual 133；不放宽 golden 或容差。binder 34/34、menu-lifetime 14/14 本次通过，仅说明旧 SIGTRAP／SIGABRT 未在本次复现。光标 format 28/28、load 23/24、storage 23/23、Session 26/26。常规浏览器 13 个光标失败；WebKit compatibility 20/32 pass、12 unreported，原 ZIP flow 的 5 秒等待失败且 `kag.json` 未产生，不能把未报告部分记为通过。完整终态在 `out/verification/github-actions/37242235256/084-final-summary.md`。

[083／37263528041](https://github.com/fenghengzhi/krkr2-web/actions/runs/37263528041) 的 run API 快照仍 **in_progress／conclusion=null**，另一个固定 jobs 快照为 11 项均终态；保留这个差异，不另查以合成新结论。Build 在 `browser-input-coordinator.test.ts` 的 filter/map 上报 TS2339；本批改为条件分支内 flatMap 以保留类型收窄。Node、浏览器、KAG、runtime 与 trusted 作业 skipped，083 Gamepad 和光标页面修订仍未验证。

083 两套 Windows 各完整采集 95 份，strict 各 **270/332 匹配、62 draw 差异、1858 未比较**；raw 173/173 仍是 partial。64→32 alpha 在这次限定比较已匹配，其余缩放仍失败。十个 mask plane 在两系统逐字节一致，孤立 1／其补集和 checkerboard 反证固定单点 nearest；它们支持区域 AND 聚合的推断，但不能确定全部 footprint 和边界策略，生产算法没有凭这一推断改成“已验证”。完整快照及原始 plane 记录在 `out/verification/github-actions/37263528041/084-snapshot-summary.md`。

后续继续取回本批结果并修复真实失败；Vorbis 高效随机跳转、其他编码流式化、视频多音轨／旧编码、光标完整缩放与时间行为及其余原生接口仍在整体非插件范围内。当前批次不代表整个模拟器完成。

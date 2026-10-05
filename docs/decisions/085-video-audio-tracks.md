# 085 视频音轨选择与原生光标采样

状态：开发候选，尚未取得本批执行结果。整体目标是完成插件以外的 KRKR2 Web 模拟器，当前仍有未实现和未验证范围。所有可执行验证只在 GitHub-hosted Actions 执行；合并成较大批次推送，本次不实时监控，下次工作时取回上一批的固定快照及产物。会话协议 **30**，TJS ABI **5**、字体 ABI **2** 不变。

已整批推送 `b88247d737706177ef923edf74839dee9c798c86`，对应 [Full test suite 37270916669](https://github.com/fenghengzhi/krkr2-web/actions/runs/37270916669)。首次唯一查询为 **queued／conclusion=null**，仅确认运行创建及精确提交绑定；原响应保存在 `out/verification/github-actions/37270916669/initial-run-discovery.json`。没有查询实时 jobs／artifacts，下次工作时取回固定清单和全部产物。此运行记录用 `[skip ci]` 文档提交保存，不新增验证结论。

## 音轨接口与原版语义

`VideoOverlay.selectAudioStream(index)` 和可读写的 `enabledAudioStream` 进入同一选择路径。参数先由 TJS `int` 转换，再截为 unsigned 32-bit；未打开或转换后的索引超出原始音轨数量时不改变选择。未打开时 getter 返回 −1；省略方法参数报错。

依据固定原版提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [VideoOvlIntf.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp)、[VideoOvlImpl.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp) 和 [dsmovie.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/krmovie/dsmovie.cpp)：方法与属性 setter 使用相同 cast，DirectShow 选择器只在索引有效时启用对应流。**脚本传 −1 是越界空操作，不是关闭声音**。静音使用 `audioVolume=0`；内部 Web 视频协议保留的 −1 静音设置不冒充原版脚本 API。这个结论限定于已查阅的原版绑定和 DirectShow 路径。

有效且不同的音轨选择更新视频 epoch、撤销旧的待投递帧，避免前一媒体图的迟到快照覆盖新音轨或 Layer 像素。候选准备失败保留原来有效的音轨，未打开时的选择不会成为下一次 open 的隐含预设；重新打开文件也恢复默认选择，不沿用前一文件的音轨编号。

## 保留同一媒体时间轴

选轨使用单个 HTMLVideoElement 同时解码视频和选定音轨，由浏览器维护共同媒体时钟。切换先暂停旧元素并冻结当前位置，准备隐藏但连接 DOM 的候选元素，在候选的同一时间位置等到真实呈现帧后替换，再恢复原播放状态。候选准备失败时恢复旧元素；成功后先释放旧媒体图再允许新图发声。这个切换可能出现停顿，**不宣称无缝播放**。

暂停位置、playRate、音量／声像、循环、周期事件、Window 归属及已有 mixing bitmap 随替换保留。相同音轨设置不重新创建媒体源。暂停状态下的普通 seek／prepare 同样等待对应实际呈现帧，再向 Layer 复制图像；播放中的 seek 保留媒体持续推进的语义。Session／页面暂停阻止候选开始播放，Stop、关闭和 Window 退休撤销准备中的候选及其迟到结果。

首次 open 未完成时，普通控制命令明确拒绝，不能被稍后的 open 设置覆盖；关闭、重新 open 和 Session 取消仍可撤销它。候选已经提交后若旧图清理抛错，会继续执行其余释放和新图恢复播放，并报告清理错误；此时新图已经生效，不能谎称发生了回滚。

## MP4 结构与预算

选择器只为自包含且结构受支持的 MP4 提供替代音轨。它保留原文件长度、媒体字节、样本位置、编辑列表、timescale、DTS／CTS；将未选音轨的 `trak`、`trex`、`traf`、`tfra` 改为同长度 `free`。只含未选音轨的片段整个 `moof` 改为 `free`。保留的随机访问索引修正 traf 序号，moof 绝对位置不变；保留的 sidx 字节范围必须完整有效。选择的 tkhd 显式 enabled／in-movie，并清除 alternate group。

原始轨道顺序决定索引，公开音轨／视频轨计数仍来自原文件。先验证所有原始轨道和实际样本 extent，再隐藏未选元数据。普通样本表和 fragmented MP4 都纳入；片段需要安全的显式 base 或 default-base-is-moof，单 traf 的隐式基址也可接受。依赖被删除前一 traf 的继承基址、外部 data reference、加密、未知 handler／结构、过大索引和不安全样本位置明确拒绝。

固定 MP4Box 2.4.1 只对一个 traf 的首个 trun 应用显式 data_offset。为避免依赖这个限制而错误确认样本地址，本批明确拒绝同一 traf 的第二个及以后 trun 携带 data_offset；后续 implicit 连续 run 仍支持。若要支持合法的多个显式偏移 run，需要另行实现独立地址计算。回归同时保留文件内非连续偏移和越界偏移，二者均应在此边界明确拒绝。

字段布局与 parser 合同依据固定 [MP4Box.js v2.4.1](https://github.com/gpac/mp4box.js/tree/v2.4.1/src) 和 [W3C ISO BMFF byte stream format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/)。选择器在首次异步让出前取得私有快照；MP4Box 直接借用这个带 fileStart 的 ArrayBuffer，避免 `MP4BoxBuffer.fromArrayBuffer` 的第二份整文件复制。格式模块只使用 ES2022，控制让出和取消检查由宿主注入。

| 范围 | 上界和所有权 |
| --- | --- |
| 选轨 MP4 输入 | 64 MiB；单轨原始路径继续使用下述 Session 来源总额。本批没有实现长视频的范围读取。 |
| 保留原始编码源 | Session 合计 128 MiB，共享引用只计费一次。 |
| 自有编码资源 | Session 合计 256 MiB，包含原始源、活跃 Blob、选择器临时副本和候选 Blob；准备失败不驱逐旧源。 |
| MP4 结构 | 最多 100,000 个 box、256 条轨道、每轨 1,000,000 个样本、总计 2,000,000 个样本；编辑列表最多 4,096 项。 |
| 媒体实例 | 最多 16 个视频身份；正在替换的候选也有独立取消和释放记录。 |

长元数据扫描定期让出宿主任务队列，取消后不发布候选。实际仍在运行的选择器持有源引用和临时额度，直到它退出才退款。上述预算是页面宿主明确拥有的编码资源额度，**不是 Worker 读取／元数据临时副本、浏览器 decoder、样本对象或垃圾回收后的总 heap 上限**；MP4Box 的有界表展开仍有同步阶段。浏览器实际支持哪些编码由其 decoder 决定，本批不新增旧 MPEG／AVI decoder，也不将非 MP4 容器称为可切换多音轨。

## 托管验收定义

构建作业用仓库自己的合成颜色帧和 440／880 Hz 正弦生成两个 AAC 音轨，产出普通 MP4、共用 moof 的 fragmented MP4、各轨独立 moof 的 fragmented MP4。生成器显式拒绝本机或 self-hosted 环境，保存 FFmpeg 版本、命令、ffprobe 元数据、源／输出 SHA-256、提交与 run ID；同一份构建 tar 分发给各测试作业。

新增 **20 个 Node 定义**：MP4 格式 14、编码资源 4、真实 TJS 源码／字节码 2。格式验收比较实际 H.264／AAC 样本哈希、offset、size、DTS、CTS、duration、视频时间轴、tkhd 默认选择和随机访问索引，并覆盖截断、危险基址、加密、外部引用、异常索引及取消。编码资源验收使用真实 Blob／MP4 选择器，检查四份编码数据的峰值预留、退款和活跃源保留。真实 TJS 定义检查参数转换、方法／setter、未打开／越界空操作、重新打开及后端失败。

应用浏览器新增双后端 × 源码／字节码 × 普通／fragmented MP4 共 **8 个定义／浏览器**。从真实生产媒体图的 analyser 读取频谱，要求 440 Hz 与 880 Hz 随选轨变化；静音、相同音轨不重载、暂停位置与 Layer 像素、播放中从 2 秒处切换的时间连续性、2 倍速、segment loop、Session 暂停和 Stop 的媒体图／URL 清理均在验收范围。没有用伪造 PCM、媒体事件或时钟代替真实解码。另有 **9 个宿主生命周期定义／浏览器**，使用真实视频解码、媒体时钟和受控所有权适配器，注入候选创建／呈现失败、关闭／替换及旧图清理故障。两类合计每浏览器 17 个待运行定义；所有权适配器不冒充真实音频输出验证。

这些是**未执行的验收定义**，不能写成浏览器已经支持或测试已经通过。本机只进行了源码检查和编辑，没有运行测试、构建、类型检查、浏览器或原生探针。

## 光标原生证据扩展

084 的两套 Windows 各 95 份原始观察仍报告 strict 270/332 匹配、62 个 draw 差异、1,858 个未比较 draw；raw 173/173 仅是限定范围的 partial。mask 的现有观察支持区域聚合推断，但尚不足以证明完整 footprint。本批生产缩放算法不凭推断改成通过。

新增独立 `--mask-footprints` 原生观察模式，在 GitHub-hosted Windows 上采集 **1,100 行**：两种位深的逐坐标单零轴线、常量平面和边界点交叉组合。保存每份原始 CUR、GetIconInfo 原平面、逐行 JSONL 和阶段快照；summary 核对原始图案／hash／尺寸，再推导 x／y 支持集合及点组合的一致或冲突。结果只记为 observed，不能代替原版兼容 PASS。原有 95 份严格比较和失败 gate 继续保留。

颜色缩放诊断保持旧 128 个候选的 ID 与顺序，补齐最接近算法的两个方向 × 四种 X 精度 × 四种 Y 精度；已有两个组合复用，新增 30，共 **158 个候选**。等待托管原始 plane 结果后再决定生产修订，不放宽 golden 或像素容差。

## 本次回收的历史结果

083／084 的 run、jobs、artifacts 各取一次固定快照，两次运行均为 **completed／failure**。固定清单的 **10/10 原 ZIP** 全部核对大小和 SHA-256：083 的五份复核已有文件，084 新下载五份。旧快照、原始失败和未报告范围保留，未轮询或重跑。

[083／37263528041](https://github.com/fenghengzhi/krkr2-web/actions/runs/37263528041) 的最终状态补齐了此前 run 尚为 in_progress 的记录。原 TS2339 构建失败保留；没有新增产物。详情在 `out/verification/github-actions/37263528041/085-final-summary.md`。

[084／37267857946](https://github.com/fenghengzhi/krkr2-web/actions/runs/37267857946) 构建失败，共 **9 条 TypeScript 诊断**：可变数组被空数组断言收窄成 never、AudioEvent 联合类型的 label 访问、MessagePort helper 错用包含本地回调的 AudioCommand。本批分别改成副本断言、条件分支内收窄及 WireAudioCommand。构建后的 Node、浏览器、原 KAG、直接 runtime 和可信生命周期全部 skipped，084 流式音频和 083 手柄修订仍未获得执行证据。详情在 `out/verification/github-actions/37267857946/085-final-summary.md`。

两次运行的独立 allocator 均为每后端 60/60；两套 Windows 严格光标结果同上且失败。原生诊断成功不覆盖应用构建或未执行的验收。082 的 Node 光标像素差异、浏览器光标失败和 WebKit compatibility 未报告部分也不被本批覆盖。

后续继续取回本批结果、修复真实失败，并完成 Vorbis 高效随机跳转／其他编码流式化、旧视频编码、完整光标缩放与动画时间行为，以及其余非插件接口和原生差分。完整回归和原版行为对照仍是交付条件。

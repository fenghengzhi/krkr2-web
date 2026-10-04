# 082 光标选择顺序、原生热点与解码并发边界

状态：开发候选，尚未取得本批 GitHub-hosted 执行结果。完整非插件目标保持 active；全部可执行验证交给 GitHub-hosted Actions，以大批次提交，下次工作时回收结果，不实时轮询。会话协议 **27**、TJS ABI **5**、字体 ABI **2** 不变。

已整批推送提交 `0679f6725efe9b69d6747ddd8d0026d13b89384a`，对应 [Full test suite 37242235256](https://github.com/fenghengzhi/krkr2-web/actions/runs/37242235256)。首次唯一查询为 **in_progress／conclusion=null**，仅确认创建及提交绑定；原响应保存于 `out/verification/github-actions/37242235256/initial-run-discovery.json`，未检查实时作业。本条文档记录使用 `[skip ci]`，不新增验证结果。

## 已回收证据

本批只各取一次固定 run/jobs/artifacts 快照，并取回清单当时已有的全部产物。

- [080／37238793190](https://github.com/fenghengzhi/krkr2-web/actions/runs/37238793190) 已是 **completed／failure**。5/5 原 ZIP 的大小和 SHA-256 匹配；两个 allocator 合计 **120/120**。Windows 两系统各 57 份观察、170/170 限定比较匹配，另各 1,372 个未比较 draw 和 7 个接受范围差异保留。build 的 13 条 DOM 类型错误、最终 gate failure 和 Node／浏览器等 skipped 均不改写。完整记录为 `out/verification/github-actions/37238793190/082-final-summary.md`。
- [081／37240240034](https://github.com/fenghengzhi/krkr2-web/actions/runs/37240240034)，提交 `669fe105cbe4eed1523ca899a07e1f0cbbc10b20`，快照仍为 **in_progress／conclusion=null**。5/5 已发布原 ZIP 核对大小和 SHA-256；build success，可信生命周期 **7/7**。两套 Windows job failure；其余 18 个 job 尚在运行，快照没有 Node／常规浏览器／兼容／运行时／allocator 用例报告，不推断结果。记录为 `out/verification/github-actions/37240240034/082-snapshot-summary.md`，终态与后续产物下批补取。

081 的两套 Windows 均完整观察 **81/81** 份文件，清理成功，进程退出 0。每系统 raw 比较为 **173 比较／170 匹配／3 mismatch／2 接受差异**，另 1,729 个 draw 未比较；load 比较为 **284 比较／236 匹配／48 mismatch／2 接受差异**，另 1,618 个 draw 未比较。两种比较观察同一批资源，不能相加。mismatch 包括热点或尺寸，不全是 RGB 差异；采集成功也不表示兼容通过。

## 选择后解码与实际 Session 接入

081 的 `multi-broken-smaller` 正反目录都被 Windows 成功加载：32×32 的候选有效，16×16 的未选候选损坏。原通用解码器先解析所有图像，因而提前报错。

新增 `decodeCursorSelection`，对完整输入快照及 CUR／ANI 容器、目录边界实施预算，先从有界头部获取候选尺寸／位深，再仅解码选中的图像。选中的载荷仍完整校验，损坏即失败，不尝试低优先级候选。每个 ANI frame 分别选择，完整 sequence、rates 和 frame 列表保留；源文件计费仍为整个输入，图像／像素预算计选中的平面。原 `decodeCursor` 保持检查所有目录项的语义。

Session 通过 `loadCursorBytes` 走该入口，共用原有协作检查点和 PNG 解码。只有整份资产完成选择、解码和加载转换后才能发布；ANI 后续帧失败不能发布之前的部分结果，也不消耗成功资产 ID。

矩形排序根据两系统实际观察修订：先考虑宽和高都覆盖目标的候选，再按尺寸距离、面积和位深排序，完全相同时保留目录顺序。交叉矩形的正序选择 48×40，反序选择 40×48；未观察的一般组合仍由后续参考矩阵校准。

## 高位热点与缩放

原 CUR 热点保留 uint16。固定桌面的实际加载路径将其作为 signed SHORT 缩放，使用 `trunc(value * target / source + 0.5)`，再收窄为 signed SHORT，最后以 `ICONINFO` 的 DWORD 记录。原始 `(65535,32768)` 在 32×32 自然大小加载后为 `(0,4294934529)`；8×4 放大后为 `(4294967293,1)`。即使图像无需缩放，也要做该转换。嵌入 ICO 按目标中心处理。

页面保留 unsigned 元数据，只在光标放置运算时解释为 signed int32。负热点和很大的负 Y 通过现有裁剪路径呈现，不能按热点分配巨大画布。

根据原生 color plane 修订 32 位平滑采样的遍历和逐字节截断阶段，并加入 10 个独立原生像素取样断言。DIB256 与 PNG256 实测都按点采样，而 PNG48 为平滑采样；当前将整数倍缩小作为候选分支，新增 64／96 大小进一步核验。**这不是完整缩放已匹配的结论**：全平面的浮点量化和分支范围仍待托管严格比较。

AND mask 继续独立采样；已观察到 256 alpha 资源的 mask 边界还有行差，不能因 alpha 的 DI_NORMAL 暂未显露而忽略。新增 256 单色及零 alpha 资源，使该 mask 差异进入实际绘制对照。

## 单帧 ANI 与时间元数据

复核发现原比较只记录 ANI rate，没有对它断言。本批严格 load gate 为每个合法 step 要求唯一、成功的 `GetCursorFrameInfo` 观察，对位比较 rateJiffies、steps，以及所有合法 rate 的总时长；缺失、重复或不可用的查询都失败。时间元数据与绘制分别记录，不能靠像素匹配掩盖时间差异。

081 两套原始观察一致：`ani-zero-rate` 的合法三步为 `[0,1,0]`、steps=3；`ani-single` 的源 defaultRate=9，合法 step0 却返回 rate=0、steps=1。原完整解码继续保留文件声明；加载层只把一 frame、一步的 ANI 转为 `[0]`／duration=0，kind 和像素仍保留。单显示步没有帧切换，页面按静态光标呈现。多 frame 一步或一 frame 多步不从此样本推导新的加载规则，多步零 rate 的墙钟语义仍未校准。

## 解码并发与寿命

原缓存的 64 MiB 已准备平面预算不限制同时进入 decoder 的临时展开。现在每个 CursorStorage 只允许一个解码／校验／复制／预留流程活动；资源读取保持并发，按读取完成后进入队列的顺序执行，较早的慢读取不阻挡已准备好的资源。路径共享、源字节预算、已发布缓存预算和稳定 ID 规则保留。

队列对每个调用者独立保存有效性及原错误。全部调用者过期的任务在开始解码前退出；一个失效或抛错的调用者不取消同路径的健康调用者。失败 flight 在拒绝旧 Promise 前按身份摘除，随后同路径的新请求可以重新读取；旧 finally 不会删除替换后的 flight。解码器同步重入前已安装共享 Promise；解码器不得等待同一 storage 的嵌套 load，实际 Session 解码链没有这种依赖。

Stop／dispose 立即清空缓存、队列源引用及等待者，外部读取或 decoder 尚未返回时，调用者也能结算。实际活动 decoder 的许可到它自身结束时才释放，晚到成功／失败不得复制平面、发布资产或重新启动已退休队列。完成的等待者从可移除集合退订，避免永久 stop Promise 保留每次 Promise.race 的历史结果。

这限制了并发展开，不声称总 RSS 等于一张图像或外部生产者的缓冲立即释放。源快照、加载快照、拥有的平面与缓存依然有各自的有界占用。

## 比较门禁与诊断

实际文件加载的严格比较改为调用产品 `loadCursorBytes`。所有原生接受文件必须在此核验接受范围、自然尺寸 DI_NORMAL RGB、加载后热点和完整必比 ANI 步；必比步数来自原生夹具，不能由候选缩短。额外 `DrawIconEx(48,40)`、mask-only／image-only 和墙钟播放仍明确是独立的未比较范围。

raw 比较继续检查通用格式解析。当原生接受、完整目录解析拒绝、产品选择后加载成功时，记录原错误及 `full-directory-rejected-load-accepted`，计入 `separateLoadScope`，raw 汇总只能是 **partial**，不能算 raw 匹配。它依赖同一工作流中不可省略的严格 load 比较覆盖该文件；任一产品加载接受差异、像素或热点差异仍失败。原 raw 全目录失败记录没有被删除或追认通过。

Windows 2022／2025 的原生矩阵从 81 扩至 **87**，新增 DIB／PNG 的 64、96 两种大小，以及 256 的 1 位／32 位零 alpha mask 资源。新增 `cursor-scaling-candidates.ts`，仅在 GitHub-hosted Windows 执行，将 **128** 组有界坐标／遍历／量化候选与原始 GetIconInfo color plane 比较。报告完整记录每个候选的差异，排名不自动选择生产算法。所有候选都有差异时也只能称诊断完成，不能替代兼容 gate；捕获或输入不完整则诊断失败并保留报告。严格 raw／load 失败后仍执行诊断，产物始终归档。

## 本批验收定义与未完成范围

| 范围 | 新增／修订定义 |
| --- | --- |
| 光标加载 | 新增 12 个，共 24 个：先选再解码、损坏首选不回退、完整 ANI、选择预算、源快照／取消、矩形选择、高位热点、原生采样及单帧静态 ANI 的原始／加载元数据区别。 |
| 光标存储 | 新增 7 个，共 23 个：ready FIFO、独立调用者、Stop 的早结算与晚到结果、同步重入、取消恢复和同路径失败退场顺序。 |
| 真实 Session | source／bytecode 新增 6 个，共 26 个；核验 CUR／ANI 未选损坏项、选中项失败的原状态／ID、DWORD 热点、实际平面字节数与缓存清理，以及单帧 ANI 的静态时间线和 ID 复用。 |
| 浏览器 host | 从 3 增至 4 个定义／浏览器，扩展 signed 热点放置、边缘裁剪和极大负 Y 不扩张平面；新增单步零时长 ANI 呈现及多步零 rate 仍明确拒绝。既有 Worker／Session 实际呈现定义一并执行。 |

以上都是本批待执行定义，不是通过数量。下一批先补取 081 终态和所有后续产物，再回收本批固定快照。平滑缩放、mask 量化、更多目录组合、零 rate 墙钟播放与其他非插件系统／图形／媒体缺口继续在目标内；不能用本批光标工作替代整体完成。

本次还静态定位了三个光标以外的明确缺口，作为后续功能批次输入：`SoundService.open` 仍整读音频并保留完整 PCM，长 BGM／双缓冲淡化需要流式读取、解码和背压；`VK_PAD*` 只有常量，浏览器尚无真实 Gamepad 输入，且 `System.getKeyState` 第二参未接通；视频后端拒绝非零音轨，原 KAG 的 `audiostreamnum` 及存档恢复会进入该路径。它们分别要用实际长音轨、原 KAG 手柄操作和两条可区分音轨证明行为，不能只增加接口或 snapshot 字段。已有播放／循环、PhaseVocoder、视频混合、帮助和鼠标 capture 继续按现有实现核验，不重新算作尚未实现。

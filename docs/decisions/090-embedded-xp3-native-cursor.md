# 090 EXE 内嵌 XP3、原生光标与窗口捕获

状态：开发候选，尚未取得本批执行结果。目标仍是完成插件以外的 KRKR2 Web 模拟器。协议 **33**、TJS ABI **5**、字体 ABI **2** 不变。所有可执行验证只在 GitHub-hosted Actions 进行；较大批次推送后，下次工作时回收固定快照，不实时监控。

上一目标轮完成 089 的 32 文件实现、提交与推送，并取得对应运行身份，属于实际进展。本轮补取证据后继续修订实际失败，并新增此前明确缺失的资源加载功能。

## 固定快照与历史结果

本轮每个 run 的 run、jobs、artifacts 端点各只取一次。固定清单合计 **36/36 原 ZIP、344,446,513 字节**，全部核对 API SHA-256 和大小；11 个旧包重新核对、25 个新包下载，失败下载尝试和原快照均保留。

- [088／37279350828](https://github.com/fenghengzhi/krkr2-web/actions/runs/37279350828)，提交 `7ebb8f65a9ecfffee8826b14a65dd3c739e14759`：**completed／failure**，25 jobs 中 14 成功、11 失败；25 ZIP、310,826,691 字节。Node 完整 TAP **3,023 通过、33 失败／3,056**，无取消／跳过；11 份浏览器报告合计 66 unexpected，兼容库存 **94/96**。光标原两个 Node 失败已消失，但不追认其他范围通过。
- [089／37282816379](https://github.com/fenghengzhi/krkr2-web/actions/runs/37282816379)，提交 `34c91a0093706c3e4bb0cbf417d41db45abfe434`：**in_progress／conclusion=null**，24 jobs 中 8 成功、2 光标失败、14 运行中；固定 11 ZIP、33,619,822 字节。构建成功、无 TypeScript 诊断；Node、主浏览器、runtime、Firefox／WebKit library/PWA、KAG 未发布结果，不能记为通过。没有刷新这些作业。

完整原始报告与计数位于各运行目录的 `090-final-summary.*`／`090-snapshot-summary.*`、`090-review-archive-inventory.json`。088 的窗口失败与 089 的已投修订分别保存，不把待验证代码算作旧失败已修复。

## EXE 中的原始 XP3

固定 KRKR2 2.32stable 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [XP3Archive.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/XP3Archive.cpp) 定义 `TVPGetXP3ArchiveOffset`：独立归档从零开始；文件以 MZ 开头时，从偏移 16 起按 16 字节段落搜索第一个 XP3 标记，每次读 256 KiB。索引指针、续接索引和数据段位置均相对找到的归档起点。它不要求解析 PE 节表。

新增 `findXp3Archive`，按该规则定位完整标记，再提供有界的归档相对 ByteSource。独立 XP3 继续使用原源；内嵌归档的索引、压缩段和原有范围读取通过同一个 view 平移，不改写磁盘字节。每次实际读取检查范围和短读，扫描与后续 view 读取均经过取消检查点；前缀按块扫描，内存不随整个 EXE 大小增长。遇到首个损坏归档会报错，不跳到后续标记寻找可通过的内容。

导入根据文件头识别 MZ，因此更换后缀也能读取；没有 XP3 标记的 MZ 文件仍作为普通资源保留。原 EXE、成员裸路径、`game.exe>member` 限定路径都保留，选择顺序、覆盖规则、存档覆盖和只读归档写入限制沿用既有机制。处理的是数据，不启动 EXE。加密／提取插件、自动 patch 发现和嵌套归档仍未由此实现。

新增夹具独立写入 little-endian 字段和相对位置；Adler-32 取自 zlib 原始编码的尾部，不调用生产校验函数。覆盖 raw／zlib 的单索引及续接索引、Unicode 成员、16 字节对齐、扫描块两侧、末尾截断、首个损坏标记、短读、取消和普通 MZ。真实 Session 覆盖源码／编译字节码、像素、限定路径、存档及导入失败不污染既有挂载；远程 HTTP 增加内嵌 XP3 的有界流量与延迟脚本读取检查。浏览器验证真实文件导入、压缩续接包、图像、游戏库及刷新恢复。

## 原生光标的 Q16 步长

089 两套 Windows 的 **96 个 target × 288 个候选**及原始 source／color 哈希一致。按生产已有分支独立划分后，平滑缩放涉及 41 个完整平面；端点映射、从底部遍历、双轴比例截成 16 位小数并使用原分段截断核，是唯一全部零差异的候选。此前 f32 步长匹配 24/41，新规则匹配 41/41，没有原已匹配目标退化。43 个原尺寸、2 个半尺寸 alpha、10 个整数点采样目标属于其他分支。

生产仅替换通用平滑坐标步长为 `floor((source-1)*65536/(target-1))/65536`，保留独立点采样、半尺寸 alpha、mask 和热点路径。新增两个 Node 定义包含 28 份原生完整 RGB／RGBA 平面哈希。证据及独立复核分别保存在 `090-cursor-quantization-evidence.json`、`090-cursor-quantization-independent-review.json` 和 `090-cursor-analysis.md`。

原 strict 仍是 **362/422 matched、60 failures、2,308 uncompared**，其中也有未进入单图诊断的多目录文件；新规则不是完整加载通过结论。原 125 份身份、顺序、字节保留，再追加 30 个不同几何／色场样本至 155；288 候选、3,770 条 mask 比较和全部严格断言保留。这些新样本是待执行的额外覆盖。

## 窗口移动的捕获与测试坐标

原 host 在祖先 section 上监听 `lostpointercapture`，只比较 pointerId。游戏 canvas 释放旧捕获后的迟到事件会冒泡到该 section，可能撤销刚获得的新拖动捕获。现在同时要求事件 target 就是当前 section；真正丢失宿主捕获仍取消。新增真实 pointerdown／move、canvas→section 交接和 section 主动丢失的浏览器回归，不伪造 capture 事件。

088 共 24 个 beginMove 浏览器失败中，19 个是 y 位移断言，原 trace 显示 console 操作后的页面滚动与 begin 内 scrollIntoView 混用了视口基准。测试现在在滚动完成后取基准，原距离与精度断言不变。其余五个 Chromium 类状态失败未记录 capture 事件，不能仅凭源码问题把其历史根因全部确定；新增有限、被动的 pointer／capture／focus／scroll 附件继续区分。

Node 两个 fullscreen 用例在预期未捕获错误之后继续复用已经故障的 Session；改在 TJS 内捕获原错误，再检查同一活窗口和后续调用。089 已修的多语句入口继续保留，另外将单行 console 的多行文本转换为单行。固定证据见 `out/verification/github-actions/37279350828/090-window-move-analysis.md`。

## 新定义和剩余范围

新增 **17 个 Node 定义**：内嵌 XP3 conformance 8、真实 Session 6、HTTP 1、光标 2。新增**每浏览器 5 个定义**：内嵌 XP3 四个、真实捕获交接一个。所有新增或修订行为仍待本批托管执行。

本轮另按固定原版确认两个真实窗口缺口：`onPopupHide` 的公开事件与后台投递链，以及外框 `width/height/setSize` 和客户区 `innerWidth/innerHeight/setInnerSize` 的区别及全屏 setter 限制。它们属于后续功能批次，不能把现有同名尺寸字段当成完整语义。089 未报告的媒体／输入修复、剩余光标严格差异、WebKit 呈现、更多非插件 API 和真实游戏覆盖继续在整体目标中。

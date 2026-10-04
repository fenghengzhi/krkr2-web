# 081 — 光标文件加载、选图与缩放

状态：实现候选，待 GitHub-hosted Actions 验证。整体目标继续是完成插件以外的 KRKR2 Web 模拟器；本批既不是完整自定义光标完成，也不是整体目标完成。本地未执行类型检查、构建、测试、浏览器或原生探针，所有执行仍随较大批次交给托管 runner，下轮回收结果。

## 080 已回收的证据

对 [080／37238793190](https://github.com/fenghengzhi/krkr2-web/actions/runs/37238793190) 的本轮一次快照为 **in_progress／conclusion=null**，精确提交 `baa6de2667fe2fb926d4656e8cecf983377e436f`。固定清单中的 4 份原 ZIP 均已下载，大小与 SHA-256 全部匹配；没有再次查询或等待新产物。原始索引在 `out/verification/github-actions/37238793190/081-snapshot-summary.md`，initial discovery 保留。

两套 Windows 2022／2025 都完成 57 份观察，原 portable 比较各 **170/170** 匹配，failures=0；它只比较同一原文件中未发生加载缩放的限定 DI_NORMAL RGB／热点，不覆盖所有加载语义。每套另有 1,372 个未比较 draw 和 7 项 native-rejected-portable-accepted，分别保留。新 alpha 全范围样本给出了本次源预乘量化／目的项取整的额外成功证据；不能将该限定成功扩展为完整缩放或浏览器合成已通过。

应用构建的类型检查失败，13 条错误都在新 DOM 文件 `src/backends/input/cursor.ts`。静态检查确认它被 `tsconfig.worker.json` 的 `src/backends` include 纳入，而原有 DOM input 文件都明确 exclude。本批按相同边界补上 cursor 文件；主页面和 tools 的 DOM 编译图仍检查它，没有给 Worker 或纯引擎放开 DOM lib。由于 build failure，080 的 Node、direct runtime、browser、compatibility 和 trusted 作业均 skipped，没有这些用例的结果。Asyncify allocator 60/60；快照时 JSPI 仍在运行，其终态及后续产物留给下轮。

## 文件加载策略

固定原版 `WindowImpl.cpp:38–69` 将解析后的实际路径交给 `LoadCursorFromFile`，成功后注册稳定数值 ID，没有额外指定图像尺寸或 KAG 选图规则。080 的实际 Windows 桌面为 32×32 系统光标、32 位显示、96 DPI。新增 `src/formats/cursor/load.ts` 明确建模这组默认配置，不把浏览器 DPR 当作原生桌面 DPI，也不声称已支持其他桌面默认值。

Session 现在执行“通用解码 → 文件加载策略 → 缓存并发布”，将每个 ANI frame 选成一幅 32×32 图像，同时保留全部 frame、重复 sequence、原始 rates、名义 ANI 字段和原 sourceBytes。缓存账本按实际输出 RGBA／AND 平面重算，每帧 5,120 字节。加载在首个暂停点前复制选中的源平面、热点及时间线，每八行／每帧经过 Session 的取消和让出检查；失败不发布部分资产。

目前实现的排序先比较尺寸差，再对等距尺寸优先较大，之后选不超过显示位深的最高位深；完全相同的排序保留目录先出现的项。实际依据包括正反目录都选择 32 像素精确项、同尺寸都选 32 bpp、无 32 项而有 16/48/64 时选 48、完全同尺寸同位深时选第一项。48 与 16 的比例热点缩放后恰好相同，选图结论还核对了有区分度的原生 RGB，不能只凭热点推断。交叉长宽、只有小尺寸、位深与尺寸相互竞争等一般化排序仍须新增矩阵检验。

CUR 热点随图像尺寸按最近整数缩放；embedded ICO 使用加载后图像的中心。原 CUR 字段是 uint16，加载后的热点是 DWORD，因此浏览器接收范围相应放宽到 DWORD，而不再次套用原文件的 uint16 范围。已观察到 13×9 热点 `(12,8)` → `(30,28)`、256×256 热点 `(191,203)` → `(24,25)`；高位热点的具体原生处理新增独立样本，尚未证明。

1/24 bpp 的 8×4 和 4 bpp 的 13×9 原生结果支持中心 nearest 采样，AND 掩码独立采样；PNG256 缩小样本也对应源中心 `(4+8x,4+8y)`。32 bpp DIB 和小尺寸 PNG 的平滑结果还存在更细的字节量化，本批实现完整双线性缩放候选，继续保留所有帧和像素，不因难校准而拒绝整类缩放或退为首帧。该候选不等于原生逐字节一致，新的严格加载比较会把差异计为失败；不能把其通过范围缩到 nearest 子集。

通用解码器新增 DIB header size、行方向和 ICO 类型事实；原生加载层按已观察行为拒绝选中的 DIB 52/56/V4/V5 和 top-down，通用格式表示仍保留。当前解码器先解码所有目录候选，未选中的损坏内容也可能提前造成失败；真正“先选再解码”的文件接受语义仍需结合新增损坏备选样本修正。PNG 与 DIB 混合目录的完整位深选择也尚未穷尽。零 rate ANI 原始数据保留，但墙钟播放依然没有采集，浏览器仍明确报未校准的时间策略。

会话协议升为 **27**，TJS ABI **5**、字体 ABI **2** 不变。页面只接收 Session 已选定的单图 frame，不再把正常多目录源文件当作尚未支持；无法呈现的时间线仍保存完整定义并报告错误。真实 Session 浏览器夹具改为核对加载后的 32×32 和缩放热点，并增加多目录正反序的实际呈现。

## 新的独立门禁与原生平面

原 `cursor-compare.ts` 及它的未比较范围继续保留。新增 `cursor-load-compare.ts` 以同一份原文件经过实际加载策略后，比较原生句柄自然尺寸的 DI_NORMAL RGB、热点与文件接受范围；不把额外 `DrawIconEx(48,40)` 的二次缩放冒充加载本身。native 接受／拒绝与候选不一致均计失败。

必比 ANI 步数来自原参考夹具，不能由被测实现自己缩短。缺少输出 frame、时间线步数不同、非首帧热点未观测、任一应有步没有自然尺寸绘制，都无法计为匹配。每个文件分别保留状态和逐像素差异；无有效比较不能绿色退出。raw 格式比较失败也不会使加载比较跳过，两个报告保持独立。

Windows 探针还将 `GetIconInfo` 返回的原 color/mask 位图用 `GetDIBits` 读为独立、标明 stride／位深／行方向／palette 的平面。读取完成的 scanline 数、返回值及 GDI 清理状态分别记录；文件写出异常仍释放已取得的位图。单色光标的双高度 AND/XOR mask 原样保留。这里采集加载后的实际平面，用于区分后续缩放量化与 DrawIconEx 合成；没有更改全局指针，也没有墙钟动画测量。

参考矩阵由 57 扩至 **81**：6 组正反序目录共 12 份、6 份 13×9 各位深缩放、2 份 48×48 DIB、PNG48 与 DIB256 各一份，以及两个 uint16 高位热点样本。目录包含只有小／大尺寸、交叉矩形、尺寸与位深竞争、损坏的首选或未选候选。workflow 同时检查 81 份实际数量、提交身份、采集完成、平面读取完整和原始文件，保持 Windows 2022／2025 两套观察。

## 本批验收定义与后续

| 范围 | 定义与实际证据的边界 |
| --- | --- |
| `tests/conformance/cursor-load.test.ts` | 新增 12 个定义：已观察选图、最近邻像素／热点、完整 ANI、native DIB 加载政策、复制所有权、协作取消及配置边界。未知平滑量化没有用实现自己制造 golden；由严格原生像素门禁检验。 |
| `tests/integration/custom-cursor.test.ts` | 原 16 个真实 Session 场景更新加载后大小／缓存计数；新增目录排序与逐帧 ANI 选择各 source/bytecode，共 20 个定义。1×1 原资源仍保留，以验证实际扩到 32×32。 |
| `tests/browser/custom-cursor-composition.spec.ts` | 仍为 4 个定义／浏览器，覆盖完整 Worker/Session 路径中的加载后尺寸、热点、正反多图目录、完整 ANI 和游戏／视频实际背景；尚未因 080 的 skipped 获得通过证据。 |
| `tests/browser/custom-cursor-host.spec.ts` | 从 2 增至 3 个定义／浏览器。新定义直接用隐藏光标时的页面截图作为 AND/XOR 背景期望，对照 1.5×／2.25× 的 auto/pixelated 实际 CSS 光栅；保存四组合全部读数后再断言。生产采样没有根据抽象规范猜改滤波核。 |

下一轮先补取 080 终态和缺失的 JSPI 产物，再回收本批完整结果。继续缩放字节量化、目录选择与先选再解码、零 rate 时间策略及已保留的其他非插件缺口；本批新定义尚未运行，不能以旧 Windows 或旧浏览器成功替代。

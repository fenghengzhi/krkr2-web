# 080 — 自定义光标资源与浏览器呈现

状态：实现候选，新增验收尚待 GitHub-hosted Actions。整体目标仍是完成插件以外的 KRKR2 Web 模拟器；本批不构成完整自定义光标或整体目标完成的证据。所有可执行验证只在托管 runner 上运行，本地只编辑、审查及归档历史结果。整批推送后不实时监控，下轮取回结果。

## Session 资源语义

`Layer.cursor` 保留 TJS String 类型，交给现有 VFS 解析；其他值沿原 `int` 和 int32 转换。数字外观字符串仍是资源路径，不把它转换为数值光标。解析使用游戏路径、autoPath 和归档资源入口，不追加图像扩展名。

新增 `CursorStorage` 按解析后的 `Resource.name` 缓存，每次赋值都先重新解析资源。相同路径覆盖后继续返回原 ID 和像素；路径已无法解析时即使存在缓存也失败。不同路径不按内容去重。成功发布的自定义 ID 从 2 开始，Session 内不复用，Layer 退休不驱逐资产。读取、解码或发布失败不改变 Layer 的旧值；一旦发布成功，之后 owner 失效也不能回收或重用已经对外发出的 ID。

并发同路径共用一次读取与解码，但各调用者独立检查 Layer 实例、生命周期记录与请求版本。读取后已经没有有效调用者时不继续解码。每份源文件最多 32 MiB，同时读取源字节总预约最多 64 MiB；至多 256 个已缓存资产和 256 个并发路径。已提交及待提交解码像素共同受 64 MiB 上限约束。源字节和 RGBA／AND 平面保存紧凑独立快照，不因 Buffer view 保留未计账的大块底层缓冲。

Session 先发送 `cursor-asset` 定义，再通过既有输入 controller 发布数值 ID，继承、capture 和原版通知时点沿用原路径。取消立即关闭缓存并只发送一次 `cursor-assets-clear`；晚到的读取、解码或页面消息不能恢复已停止的资产。页面 Stop 同步退休自己的注册表，晚到定义不再制造错误或重新注册。

会话协议升至 **26**；TJS ABI **5**、字体 ABI **2** 不变。快照新增 `cursorCacheEntries`、`cursorCacheBytes`、`cursorCachePending`，停止后全部为零。

## 浏览器画面与输入

选图与呈现分离，显式选中的资产复制每帧像素并保留全部 ANI sequence、非均匀 rates 与逐帧热点。当前 player 只在每一帧都恰有一个图像时明确选择索引 0；多图目录完整保留并报告尚未支持，不能默认取首图。Windows 多图选择、DPI 和缩放规则仍需依据原生参考继续实现。

物理指针沿既有 BrowserInput 事件流采样，虚拟位置继续受 revision、physical sequence 和窗口代际约束；没有另建输入泵。两种位置共用同一资产动画时钟。暂停、隐藏、离开、页面失焦及 Stop 撤下呈现，恢复不会复活已退休的虚拟位置。资产退休与普通隐藏分开，退休释放选中像素引用。

呈现只使用至多 256×256 的 scratch bitmap，读取当前已提交的 DOM 游戏 canvas，并按宿主管理的实际 DOM 顺序、矩形、裁剪和透明度叠加视频背景、video 和 mixing bitmap。layer 模式视频已经画在游戏 canvas 中，不重复采样。每帧在所得背景上执行格式层的 alpha 或 `(destination & mask) ^ source`，因此保留彩色 XOR、反色和透明掩码，而不是用 CSS URL 代替依赖背景的运算。

热点按实际 viewport 坐标定位，支持 CUR 中的 uint16 图外热点，不擅自裁成图像内部。图像目前按一源像素对应一个 CSS 像素呈现；Window 的绘制缩放不直接放大指针。079 的 Windows 实测已确认单图 13×9 和 256×256 都会在加载时变成 32×32，并相应改变热点，所以当前原尺寸呈现只是接入中的候选，存在明确的原生尺寸差异；不能把 8×4 浏览器夹具当作原生加载尺寸的证明。呈现平面裁剪游戏客户区，保持 pointer-events:none，不占用标识主绘图 canvas 的 `data-window-id`。宿主控制与窗口遮挡继续由 DOM 处理。

首个不透明 canvas bitmap 尚未提交或图像源暂未就绪时隐藏叠层并在后续绘制帧重试，不把全透明读回值猜成黑背景，也不永久禁用该资产。任意透明 HTML 背景无法普遍读回；低层宿主必须明确提供真实的不透明背景。正式 WebGL renderer 没有修改 preserveDrawingBuffer；这里读取 transferred HTMLCanvasElement 的已提交 placeholder bitmap，不声称同步读取下一帧 Worker 绘制结果。跨浏览器实际读回、视频色彩和 GPU 恢复仍需本批 Actions 验收。

背景采样会读取 canvas/video/mixing bitmap 的 `image-rendering`，整数倍 `pixelated` 有像素条纹验收；非整数 `pixelated` 当前仍采用 nearest，不宣称已经复现 CSS 两阶段过滤。零 rate ANI 保留原始帧和时间数据，但浏览器明确报告尚未校准的播放策略，不跳过零时长帧或自行补成一个 tick；完整定义仍留在注册表中。原生实际墙钟播放未采集，这也是未完成范围。

## 托管验收定义

| 文件 | 已定义范围；尚非通过结果 |
| --- | --- |
| `tests/conformance/cursor-format.test.ts` | 在原 23 个定义上新增 5 个原生证据回归，共 28 个；覆盖 RGB555/565 位复制、alpha 源预乘量化、图外热点、seq flag/chunk 组合和零 rate 的完整保留。旧错误拒绝断言按实际 Windows 接受证据修订。 |
| `tests/conformance/cursor-storage.test.ts` | 16 个定义，覆盖缓存身份、重新解析、并发有效性、读取与像素预算、快照所有权、发布失败及取消后的迟到工作。 |
| `tests/integration/custom-cursor.test.ts` | 8 场景 × source/bytecode，共 16 个真实 Session 定义；覆盖 String/int32、VFS 与 autoPath、CUR/PNG/完整 ANI、实际保存覆盖、失败原子性、Layer 退休与数值 ID 复用、继承和 capture，以及 PNG inflate 挂起期间 Stop 和晚到 resolve/reject。当前没有公开删除 API，移除 autoPath 只证明路径重新解析失败；实际删除由低层资源查询夹具覆盖。 |
| `tests/browser/custom-cursor-composition.spec.ts` | 2 backend × source/bytecode，共 4 个定义／浏览器；通过真实 Worker/Session、CUR/完整 ANI、游戏 canvas 和实际视频/mixing bitmap 检查像素、热点、物理接管、绘制缩放、暂停／隐藏／离开、GPU loss/restore 和 Stop。JSPI 缺失时按已有能力条件明确跳过，不记为通过。 |
| `tests/browser/custom-cursor-host.spec.ts` | 2 个定义／浏览器，检查首个 bitmap 未就绪后的恢复、显式选择第二图像及独立像素、透明 canvas 的明确背景、整数 pixelated、图外热点与客户区边缘裁剪、两 Window、迟到快照和旧 surface epoch。显式第二图选择不代表已证明 Windows 的选图政策。 |

## 078 终态与同批夹具修订

[078／37234602267](https://github.com/fenghengzhi/krkr2-web/actions/runs/37234602267) 为 **completed／failure**，20 份原 ZIP 的大小与 SHA-256 均匹配。Node 这次具有 reporter finish 和最终 TAP plan：**2720 通过、7 失败、2 超时取消／2729**，不能把两项取消改称普通失败。完整证据在 `out/verification/github-actions/37234602267/080-final-summary.md`，旧部分记录不覆盖。

此前字符串自追加和 selector 的目标回归已获得本次成功证据：native selector 26/26、abort-entry 10/10、integration selector 38/38、browser selector 48/48，原 bounded source/bytecode 都已执行到 dispose 返回；字符串 source/bytecode 2/2，原生 ASan/UBSan 诊断日志 PASS。独立 identity allocator 两后端合计 120/120。它们不将历史越界、挂起、崩溃或本轮其他失败追认为通过。

四项 Node identity 和六组 direct runtime 都被测试中的非法操作名 `not-registered` 挡住；本批改为合法但未注册的 `Identity.Missing`，保留“不能凭身份恢复已注销 native 资源”的断言。两项 mouse capture 超时夹具在 `invalidate this` 后使用未限定的 `Scripts`，本批明确走 `global.Scripts`，并将等待门与生产调用的提前结束竞争，避免隐藏未到挂起点的错误。它们仍需新结果验证，不能先称已修复超时。

另外两项 transition 夹具和一项窗口坐标旧失败已在 079 修订。078 常规浏览器为 **1963 通过、11 失败／1974**，Firefox cursor/hint、activity、WebKit 启动／Web Locks 和 Firefox compatibility 截图失败分别保留，不合并根因。当前自定义光标、多图选择及其他非插件兼容缺口继续属于整体目标。

## 079 原生结果与本批扩展

[079／37236286963](https://github.com/fenghengzhi/krkr2-web/actions/runs/37236286963) 的 Windows 2022／2025 两套参考均完整观察 47 份原文件，但 portable 比较均失败：135 次比较中 117 次匹配、18 次像素不一致，另有 3 项原生接受而候选拒绝，共 21 项失败。7 项原生拒绝而通用解码器接受另外标为 acceptance difference，未冒充渲染通过，也不为消除差异而删除通用解码表示。原始文件、BGRA、旧比较报告与失败结果保持不变。

079 的 23 份原 ZIP 大小和 SHA-256 全部匹配，终态索引在 `out/verification/github-actions/37236286963/080-final-summary.md`；同运行先前 queued／零产物快照没有覆盖。每套 Windows 的 1,017 个未比较 draw 仍是未比较，不能计入匹配。Session 对 DIB 52/56、V4/V5 与 top-down 的原生加载接受策略尚未收敛，也列为后续工作。

16-bit RGB555／565 的通道扩展须按位复制；例如 5-bit 的 7 在原生为 57，线性比例四舍五入得到 58。alpha 观察表明源通道先向下量化为预乘值，不能对源和背景的总和只做一次舍入。现有背景与 alpha 取值尚不足以确定目的项在所有字节值下的舍入规则，因此新增 DIB/PNG 各一份包含全部 256 个 alpha 的样本，并增加灰阶 1、127、129、253 四种背景；继续逐字节比较，不放宽像素容差。

另外，原生接受热点 `(33,40)` 的 32×32 图像并原样返回热点；AF_SEQUENCE 置位但未带 seq chunk、steps 等于 frames 时可按原序号取得各帧；零 rate metadata 原样为 `[0,1,0]` 且各步可独立 Draw。加载／逐步绘制证据不证明零 rate 的墙钟规则，格式接受与浏览器时钟支持分别记录。

参考样本从 47 扩至 **57**：上述 2 份 alpha 样本、4 份单图缩放样本（8×4 单色／彩色 XOR、13×9 alpha DIB／PNG），以及 4 份无精确尺寸／同尺寸同位深目录正反序样本。独立生成器只在托管 Windows 上执行，workflow 仍检查实际数量、提交身份、完成状态和全部原字节／像素。它们用于继续落实加载时的选择与缩放，当前没有这些新定义的运行结果。

079 Node 有完整终态：**2744 通过、6 失败、2 超时取消／2752**，其中 CUR 格式定义 **23/23**、window-layers **4/4**。4 项身份和 2 项 Stop 夹具修订见上；另外 2 项 primary exchange 已越过不存在的方法错误，实际帧高度为 `38.99999999999999`，本批参照同文件的子层投影，对浮点尺寸采用小于 `1e-10` 的误差界，整数原点和脚本 cursor 的断言仍精确。

079 Firefox 常规分片 **332/332 + 326/326 = 658/658**，cursor/hint **8/8**；这证明该提交的本次运行，不反推旧失败的唯一原因。WebKit 两项失败分别是 storage-public-paths 的 Target crashed 和 video-readiness 缺少 frame-open-ready，仍保留待查；不并入已修订的夹具问题。

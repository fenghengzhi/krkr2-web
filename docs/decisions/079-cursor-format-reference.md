# 079 — CUR／ANI 格式与 Windows 参考证据

状态：底层候选与托管验收已定义，尚未执行本批改动。完整自定义光标功能仍在实现；字符串 `Layer.cursor` 的 Session 资源加载、稳定 ID 缓存、浏览器物理／虚拟指针、动画和真实游戏／视频背景合成尚未接入。不能把本批底层格式或离屏像素比较当作完整功能完成。

整体目标仍是完成插件以外的 KRKR2 Web 模拟器。此次继续 076 的完整自定义光标范围，不用首帧 PNG 或 CSS URL 的局部效果代替该范围。原版实际入口、解析路径缓存及通知时序见 [076](076-layer-cursor-hint.md)；077／078 输入所有权修订继续保留。

## 资产表示和有界解析

`src/formats/cursor/index.ts` 解析完整资产后才返回。CUR 保留每个目录图像及各自热点，不提前按浏览器偏好丢掉候选。ANI 保留所有帧、每帧图像列表、重复的播放顺序和每步 jiffies（1/60 秒）；不是按唯一帧保存时长。名义尺寸、位深、planes 和 flags 另行保留，尚未据此猜测 Windows 的图像选择。

DIB 候选覆盖 CORE12、INFO40、52／56、V4／V5 头，1／4／8 位调色板、16 位 RGB555／bitfields、24 位 BGR 和 32 位 BGRA／bitfields。每行 XOR 与 AND 都按各自 DWORD stride 读取，双高及正负行方向分别处理。PNG 先核目录尺寸和资源预算，再交给现有有界 PNG 解码器；保留 RGBA，并复制宿主返回的像素。

图像保留 `alpha` 或 `and-xor` 两种操作，以及逐像素 AND 平面。后者的每个 RGB 通道执行 `(destination & mask) ^ source`，包括透明、黑／白替换、反色及彩色 XOR。原型合成器只处理给定的不透明 RGB 背景和整数位置／裁剪；它尚未读取实际浏览器游戏或视频画面。32 位非零 alpha 的判定、混合舍入和位域扩展目前是候选，需要原生结果确认。

源字节上限 32 MiB；单帧最多 64 个图像、总计 1,024 图像、256 帧、4,096 步、4,194,304 解码像素和一小时动画时间线。单图尺寸为 1–256，解码数据账本按 RGBA 与 AND 平面共五字节／像素记录。调用方可以降低预算，不能放大预算。越限、截断、非法序号、重复关键 chunk、部分 mask 或当前未支持的编码明确报错，不丢帧、不驱逐可寻址资产。

本阶段拒绝的情况包括非图标 ANI 帧、带嵌入颜色配置文件的 DIB、RLE／其他压缩 DIB、零时长、目录外热点和部分未规范化的 ANI 组合。这些不是对 Windows 接受范围的既成结论；参考探针包含相关边界，后续应按实际证据补齐或明确 Web 资源限制。此处没有声称所有旧格式、畸形文件或 OS 版本行为都已一致。

异步入口用 `new Uint8Array(input)` 保存独立字节，不能使用对 Node Buffer 仍返回共享 view 的 `slice()`。PNG 结果同样独立复制。DIB 每八行、每个图像和异步 PNG 返回后设检查点，调用方可取消。时间采样比较整数比例 `milliseconds * 60` 与 `jiffies * 1000`，避免先对分数毫秒周期取模使 `[1,1]` jiffies 动画在精确 50 ms 处落回前一步。

## 托管 Windows 参考

`.github/workflows/native-cursor.yml` 在 GitHub-hosted Windows 2022／2025 独立执行，作为完整 Tests 的必需作业。`tests/probes/native-cursor.cpp` 独立构造真实 CUR／ANI／PNG 文件，调用与固定原版相同的 [LoadCursorFromFileW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadcursorfromfilew)，再用 [GetIconInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-geticoninfo) 和 [DrawIconEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-drawiconex) 记录热点、尺寸及离屏 BGRA。它没有执行原版 KRKR／VCL，也没有创建游戏窗口或改变全局鼠标。

样本覆盖不同头／位深、所有四种单色掩码组合、彩色 XOR、全零／非零及预乘对照 alpha、PNG RGBA／RGB／索引透明度、256 尺寸、大小／位深目录逆序、多帧默认和指定 sequence／rate、内嵌 ICO、名义 ANI 字段及格式边界。每步分别在黑、白和 `0x123456` 背景，按原尺寸及 48×40 尺寸记录 DI_NORMAL／DI_MASK／DI_IMAGE 原始像素；ANI 还观察首个越界步。

动画格式依据 Microsoft [*Multimedia Standards Update* 1994-04-15 revision 3](https://billposer.org/Linguistics/Computation/riffnew.pdf) 第 9–10 页 ACON 章节（Microsoft 原文的外站镜像），以及上述 Win32 API 文档。原版将所有加载行为交给 OS，因此选图与缩放须从 Windows 结果中确认，不能直接把另一个 API 的选择规则套到 LoadCursorFromFile。

可用时额外记录 `GetCursorFrameInfo` 的经验性 rate／step／逐帧信息；该导出没有公开 SDK 合同，缺失时明确记录 unavailable，不以其存在作为通过门禁。探针没有测量操作系统的实际墙钟播放，记录的帧元数据不能替代动画时序的端到端验证。

所有原始 CUR／ANI、生成器源码、逐步 BGRA、Windows 版本／显示位深／DPI、编译日志、完成状态及实际文件 SHA-256 随 artifact 保留。探针独立进程有 180 秒期限，超时及中间产物不会标成完成；本地不编译或执行。

`tests/probes/cursor-compare.ts` 使用同一份原始文件运行候选解码器。单一候选且无尺寸变化的 DI_NORMAL 比较实际 RGB 和可用的热点信息；alpha 字节不作为 GDI 的输出保证。多候选结果记录每个候选的差异，但不凭最接近的结果推定 OS 选图规则。缩放、单独 mask/image 和越界步明确为未比较，不计匹配数。Windows 接受而候选拒绝、像素或热点不符均保留失败；没有任何可比较样本时也失败。采集完成与解码匹配是不同结论。

## 格式验收与既有失败

`tests/conformance/cursor-format.test.ts` 新增 23 个 Node 定义，用独立二进制夹具和手算期望覆盖调色板、位域、AND/XOR、alpha、PNG、完整 ANI 时间线、多图热点、裁剪、预算、截断、Buffer 所有权与取消。其中包含 `[1,1]` 的 50／100 ms 及多圈边界。测试由完整托管 Node 作业运行，当前没有本批执行结果，也没有浏览器接入的通过声明。

077 终态为 failure，Node cancelled。新回收报告定位出两个几何夹具调用不存在的脚本 `exchange`；本批改为公开 `beginTransition`／`stopTransition`，通过真实 transition 完成执行原生树交换。为满足 transition 同图像尺寸，replacement bitmap 设为 101×103，其 Layer 尺寸仍为 75×77，原 primary、帧和 cursor 断言保留。另一个窗口输入夹具按 MulDiv 后 origin `(6,8)` 将客户区点击改为 `(12,16)`，子层局部坐标仍断言 `(1,1)`；没有改生产几何公式来迁就旧夹具。

Firefox cursor／hint 失败仍未定因。已有 trace 显示已交付的 move／命令与之后的清空，尚未记录清空对应的 DOM 边界事件。此前两个 headed worker 共享一个 Xvfb display，存在独立测试争用真实指针的隔离问题。本批每个 Firefox display 只运行一个 worker，常规套件分两台托管 runner 保持吞吐；不放宽期限、断言或追加补偿 move。原用例加入最多 4,096 条被动 DOM／Session 时间线，失败清理前保存 enter／leave、pointer、focus／visibility、状态序号及光标字段，用来进一步确认原因。历史失败保持，不能先称共享 display 已被证明是唯一根因。

本批之后仍须接入 Session 缓存与失败原子性、完整字符串／数值语义、VFS／autoPath／XP3、稳定 ID 和 Stop 清理，以及物理／虚拟光标在真实游戏／视频背景上的热点、缩放、动画和掩码呈现。整体非插件目标保持 active。

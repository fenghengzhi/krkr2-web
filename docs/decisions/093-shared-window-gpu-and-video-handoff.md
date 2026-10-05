# 093 共享窗口 GPU、视频画面保留与独立几何证据

状态：开发候选，本批尚未执行。整体目标是完成插件以外的 KRKR2 Web 模拟器，以原版行为、真实游戏兼容性和可追溯执行证据共同验收。协议 **34**、TJS ABI **5**、字体 ABI **2** 不变。上批 092 已完成实现、提交和推送，本批继续修复固定快照中的具体问题。

已整批推送 **25 个文件**，精确提交 `68abdf4716d3116e8d2834280dbc9d6c5b1f3118`，对应 [Full test suite 37296239220](https://github.com/fenghengzhi/krkr2-web/actions/runs/37296239220)。首次唯一查询为 **pending／conclusion=null**，只确认运行与提交身份，没有查询实时 jobs／artifacts。原响应保存为 `out/verification/github-actions/37296239220/initial-run-discovery.json`；本段随 `[skip ci]` 文档提交保存。下一批补取 091 缺失结果并回收 092／093 固定快照，未取得本批通过结论。

所有可执行验证均由 GitHub-hosted Actions 执行。本地仅检查和编辑源码、下载核对与解析历史原始产物；没有运行测试、类型检查、浏览器或候选算法。大批次推送后只查询一次新运行身份，下一批回收结果，不实时轮询。

## 固定回收范围

对 091／37289840732 和 092／37292345654 的 run、jobs、artifacts 各取一次，归档 **24/24 原 ZIP、266,038,696 字节**，全部 API SHA-256／大小一致；7 个旧包重新核对、17 个新包下载。091 仍 **in_progress**，24 jobs 中 16 success、6 failure、2 in_progress，缺 WebKit 浏览器 shard 2。092 仍 **pending**，0 jobs、0 artifacts；全屏、拖动 Stop 修订及 183 光标样本尚未报告。

091 构建通过且无 TypeScript 诊断，直接 runtime **6/6**，兼容 **95/96**；Firefox KAG help 仍在截图步骤超时。浏览器十份报告共 **2,005 项，1,957 expected、48 unexpected**：视频音轨 24、beginMove 8、popup 14、Firefox 视频生命周期 1、WebKit CSS 光标 1。缺失 shard 不计通过。校准的 16 项是完成观察，不表示媒体兼容问题已解决。

Node 计划定义 **3,097 = 3,084 pass + 2 region failure + 11 unreported**。TAP 报告的 3,087 包含一个整文件 synthetic failure，不能当作完整计划库存。`layer-lifetime.test.ts` 在九个 source 子项后发生 **SIGABRT／corrupted size vs. prev_size**；210 worker 有 209 条退出记录。托管 GDB 回溯和原 core SHA 保留，ZIP 没有 core 本体；malloc 检出点不证明破坏内存的位置。本批没有宣称修复此崩溃。

两份原生光标结果均为 155 样本：strict **485/512 matched、27 failure、2,758 uncompared**，mask **3,770/3,770**。这些不属于 092 的 183 样本。原 ZIP、旧快照、完整错误、`093-snapshot-summary.*` 和 `093-review-archive-inventory.json` 均独立保留在各 run 目录。

## 一个 Session 共用 GPU，Window 独立提交画面

091 Chromium 六窗口 popup 启动只完成四窗，随后等待恢复；固定浏览器源码确认 Worker 默认 WebGL 上下文限额为四。新增 `WindowGpuPool`，一个 Session Worker 共用 scratch OffscreenCanvas 和 WebGLRenderer，各 Window 通过独立 bitmaprenderer 输出；缺少时使用实际 Canvas2D 拷贝并关闭 ImageBitmap。窗口退休仅释放自己的输出，Session 退出才释放共用 GPU。

GPU 丢失／恢复先使所有输出失效，再通知可重入订阅者。scratch ready 不代表其他窗口已经提交；每个输出成功提交自己的画面才就绪。同轮 registry retry 最多重建一次失败 GPU。捕获或输出提交失败可独立重试，清理错误聚合保留。纹理缓存只保留当前帧图层，窗口交替可能重复上传；输出需要 bitmap 存储，本改动不构成总堆内存上限。

新增 **8 个 Node 定义、每浏览器 8 个真实八窗口定义**；原 12 个图形定义按共用 GPU 故障范围修订，保留像素、输入、尺寸、重试与退休窗口断言。新场景包含两后端与源码／字节码、八窗颜色和输入、退休后开第九窗、恢复全部存活输出、2D 备用路径、丢失期间 Stop 和重新启动。使用真实 WEBGL_lose_context，不提高上下文限额。观察 helper 只统计申请过 bitmaprenderer 的输出 canvas，排除字体测量等 2D canvas。

## popup 与 region

091 Node popup **14/14**。Firefox delivery-visible 两项失败由 reset 前 console mousedown 的排队通知干扰，夹具改用真实 Enter 提交 reset。固定 Playwright／Juggler 源码强制 focus／active 状态，普通连接切换页不能证明失活：原八个 generic 定义保留其他全部动作，完整 blur／hasFocus=false／恰好一次／返回后 F8 子场景迁到既有 Chromium noDefaults 连接，新增 **4 个定义**。没有伪造事件或改变生产失活语义。旧失败和逐项映射在 `out/verification/window-popup/093-regression-analysis.{json,md}`；Firefox／WebKit 原生 OS 失活仍未验证，不宣称覆盖等价。

region **8/10** 的两项失败对 primary Layer 写 opacity=0，但原版要求主图层不透明。夹具捕获预期异常，断言 opacity=255、region 不变并保留像素／偏移／缩放／生命周期；生产限制不放宽。

## 换轨保留实际暂停画面

独立 numbered 视频、回调和 FFmpeg 参考表明不能统一平移时钟。普通视频 Chromium 请求 1.291666 秒得到 PTS 1.25／第 15 帧；Firefox 报告约 1.291667 秒也显示第 15 帧。numbered fragmented 在同一中点请求上，Chromium 得到第 16 帧、Firefox 第 15 帧。同样请求 2 秒，原重复色块 fragmented 与 numbered fragmented 的回调和图像也不同。重复色块不能唯一识别序号。原附件及 576 张参考 PNG 在 091 的 `093-decoded-media-attachments*` 与 `093-shared-video-fixtures*`。

换轨暂停旧元素，保存时钟、呈现记录和完整 RGBA。候选必须在相同暂停时钟完成 seek，呈现记录对应同一报告区间，完整图像逐字节一致才提交。区间归属本身不证明图像身份；新增 `videoReportedFrameAt` 仅用于这条完整图像核对路径。原严格 PTS seek、首帧屏障、公开 frame／fps／position 保留。异常走候选清理和旧图回滚。

读回前预留两份图像，单份至多 64 MiB、同时保留预算 128 MiB，不包含解码器、GPU 或等待 GC 的内存。共用 wait 收到事件后重新核对条件，避免无关 seeked 提前完成。新增 **1 个 Node 定义、每浏览器 1 个生命周期定义**；后者翻转候选末像素一个字节，首像素保持，要求拒绝候选、回滚、随后成功换轨。原换轨／取消／迟到回调／旧图清理断言保留。播放中暂停时 last presentedTime 与即时读回是否一致仍需真实运行确认；不以放宽像素比较掩盖失败。

原版公开帧时钟、平均帧率、旧编码和所有码流的精确定位仍未完成。

## CSS 光标完整视口取证

091 margin4、margin16、完整视口三份独立背景一致。WebKit auto/1.5 旧 8×8 小截图与规范背景差 15 通道；pixelated/1.5 生产零 padding 与规范背景差 24 通道，实测 padding 1／2／4 一致。旧小截图的通过或失败不代表整页像素。

生产在所有浏览器和比例统一增加一 CSS 像素周边，再直接读回原尺寸。前后 oracle 改为完整视口 PNG 的纯 RGBA 裁剪，仍要求完整 8×8 零差异，无浏览器特判或容差。旧小截图、旧 expected、差值、十二种采样和 DPR 观察保留。DPR auto/1.5 的 48 通道差异仍独立未闭合；原 CUR／ANI 缩放不变，历史报告不改写。

## 原生几何与剩余工作

主工作流和 All tests 接入双 GitHub-hosted Windows User32 几何观察，每系统 **24 配置、960 行**：六种 style、四种 menu、五阶段尺寸、两种客户区边框、四种滚动条组合。保存父窗／客户区／viewport／paintbox、菜单、DPI、事件和清理。名义 AdjustWindowRectExForDpi 后只作一次实测修正；失败保留原行并标失败。进程 watchdog、工作流时限和 HWND／HMENU 所有权清理有界，不注入全局输入或改变显示模式。这些观察不证明 VCL 属性保留、约束或自动滚动兼容。

下一批补取 091 终态与缺失产物、回收 092 和本批固定快照。后续实质工作包括原生堆崩溃、完整窗口外框／客户区模型、媒体公开时钟与码流、原生光标严格差异、KAG 兼容失败及未完成 API。整体目标继续 active；本批所有新定义和原生测量均未执行。

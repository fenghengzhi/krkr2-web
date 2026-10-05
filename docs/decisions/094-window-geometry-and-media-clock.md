# 094 窗口五矩形与媒体公开时钟

状态：开发候选，尚未取得本批托管结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器；上一轮 093 的 25 文件实现、提交、推送是实际进展。本轮在干净 `25f4468` 上继续实现窗口几何、媒体时钟和已定位夹具错误。协议升至 **35**，TJS ABI **5**、字体 ABI **2** 不变。

所有测试、构建、类型检查、浏览器与原生可执行探针只在 GitHub-hosted Actions 上运行。本地仅源码检查／编辑及历史原始产物下载、解包、哈希核对和解析。本批没有本地执行候选算法；推送后只取一次运行身份，下一轮回收固定结果，不实时轮询。

## 本轮固定证据

091、092、093 的 run／jobs／artifacts 端点各查询一次，按冻结清单保存 **49/49 原 ZIP、575,013,476 字节**：24 旧包重新哈希，25 新包下载，API SHA-256／大小全部一致。原 ZIP、原报告及旧快照不覆盖。总表为 `out/verification/github-actions/094-archive-summary.json`，各 run 保留 `094-final-summary.*`／`094-snapshot-summary.*`、清单与原错误。

| 范围 | 091／37289840732 | 092／37292345654 | 093／37296239220 |
| --- | --- | --- | --- |
| 运行 | completed／failure | in_progress，无终态 | pending，无结论 |
| jobs | 25：16 success、9 failure | 24：16 success、7 failure、1 running | 0 |
| ZIP | 25，304,913,235 字节 | 24，270,100,241 字节 | 0 |
| Node | 3,084 pass、2 子项失败、11 未报告；另整文件崩溃 | 3,105/3,109，4 失败；全部定义与 211 worker 退出已报告 | 未报告 |
| 浏览器 | 2,278/2,339 expected，61 unexpected | 十份报告 1,977/2,024 expected，47 unexpected；缺 WebKit shard 2 | 未报告 |

091 缺失的 WebKit shard 2 已补齐；旧 `layer-lifetime` SIGABRT／`corrupted size vs. prev_size` 及 11 未报告子项保留。092 同文件 20 项通过不证明旧崩溃修复。092 的四个 Node 失败为两个 fullscreen 字典回调及两个 region 主图层透明度夹具错误；后者 093 修订尚未报告。

092 已报告的 Chromium／Firefox beginMove **24/24** 通过，确认该范围内宿主 Stop 修订；三浏览器 modal-host 已报告 **24/24**。fullscreen 16 项中 8 失败，均成功执行最后表达式但得到 `0,1`；窗口失效、外部 Layer 仍有效。兼容 **95/96**，本轮 Firefox help 通过、KAG cursor 的 pad 状态失败。直接 runtime **6/6**，两套 allocator 各 **60/60**。新 Chromium numbered 校准有一次 callback 时 `seeking=true／readyState=1` 无可读像素，仍保留失败；WebKit 一项 input-admission 在启动前报 InvalidState，未进入 ACK 验收。

双 Windows 的 183 光标样本均已观察，strict **536/596 matched、60 failure、3,178 uncompared**，mask **3,770/3,770**。本批没有据此猜测或更换原生缩放算法。093 的共享 GPU、完整换轨图像、CSS 光标及 User32 几何工作流全未报告。

## 五矩形模型与真实 DOM 测量

`Window.width/height` 现在表示外框；Form client 排除真实宿主 chrome，inner 为 client 减去 sunken 的四像素空间，viewport 再排除实际滚动条占用，PaintBox 则是按实际缩放变换的 primary Layer 矩形及滚动偏移。所有矩形以同一逻辑外框原点表达，输入／IME／cursor 的传输坐标仍为 viewport 局部。

独立 geometry MessagePort 允许 TJS 保持 setter 的同步语义，同时等待主线程的真实 DOM 测量。主线程在同 CSS 的隔离、隐藏、inert 树中测量标题、菜单换行、边框和滚动条；不靠猜 Windows 非客户区常数。新 geometry 带 generation、Window、surface epoch、请求 revision 和物理 scroll sequence。只有有效回复提交新尺寸；失败保留旧公开尺寸和绘图权限。退休／Stop 取消挂起测量，迟到回复不能重新激活窗口。菜单和 primary 尺寸更新后重测，字体造成的 chrome 高度变化也请求重测；纯响应式缩放不回写脚本尺寸。

真实页面的 canvas 是 viewport，采用同一外框 CSS 缩放；原生滚动容器中的 sticky canvas 保留滚动条命中。绘图、物理输入、虚拟鼠标、鼠标键、IME 和光标共享 PaintBox／viewport 变换。Window region 仍裁剪外框，不随图层滚动。零物理视口使用有界画布占位，公开 inner getter 保留原版的小尺寸带符号减法。

`setSize` 与 `setInnerSize` 分开；inner 请求保存显式的尺寸偏好，菜单／outer 尺寸变化不重写该偏好。fullscreen 使用当前页面视口作为宿主外框，依据保存的 inner 请求等比拟合居中，实际缩放与公开请求缩放分离；退出恢复原外框、位置和 sunken。`setZoom` 按原版约分，`setLayerPos` 为单次事务；参数不足按原生数量检查。DOM fullscreen 不改变操作系统显示模式。

直接 Engine 的无 DOM 平台及不提供测量能力的旧 embedding 使用明确的 unframed 几何合同；真实 GameWindows 总是提供测量通道。它们不是同一套平台边框数值的证明。

外框／表面仍受既有 4,096 像素资源预算限制；接近上限的 inner 请求可能被 chrome 或尺寸约束限制，不能保证实际 inner 等于请求值。zoom 目前只接受 1–65,536 范围内的正整数参数再约分，原版零／负数等更广输入仍未闭合。primary Layer 的尺寸方法与单属性写入都会先同步几何，再重新检查输入目标，避免同一 TJS 调用读到旧滚动坐标。

普通 `MenuItem.popup` 按原版 Form client 原点定位，独立于 sunken、LayerLeft 和滚动。原版 fullscreen 使用额外的、可能在屏幕外的 MenuContainer，再经 User32 popup clamp；本批 Web 采用可见菜单容器锚点，不宣称已复现该 OS 定位。

主要固定原版依据为 `WindowImpl` 的 outer／inner setter、`WindowFormUnit` 的 `SetInnerSize`／`InternalSetPaintBoxSize`／`SetFullScreenMode`／`SetZoom`，以及 `MenuItemImpl` 的 `ClientToScreen` 路径。相关引用沿用 092／093 窗口审计，补充原件与哈希保存在 `out/verification/window-geometry/source/094-menu-container-manifest.json`。

## 媒体公开时钟与呈现帧分开

固定 `dsmovie.cpp` 的 MEDIA_TIME 路径明确：`position` 毫秒四舍五入，`totalTime` 毫秒截断，`frame` 与 `numberOfFrame` 按平均帧间隔取最近整数，`fps` 为该间隔的倒数；`SetFrame` 先转换为整数 100 ns 时间。本批用这些公式替换公开属性中的 PTS floor／毫秒 floor／样本数除编辑后时长。

MP4 元数据增加独立 `frameDuration`，由未应用 edit／CTS 起点的解码样本时长求平均。因此空 edit 或初始 composition gap 不会人为降低码流平均帧率。公开帧 seek 和 segment clock 采用该间隔；它与实际图像在 PTS 数组里的序号可以不同。VFR 平均帧请求可能落入 sample 内部，真实 frame seek 允许其回调报告同一时间区间，并同时等待 seek 与稳定媒体时钟；原精确 PTS 识别函数及换轨完整 RGBA 身份比较保留。任意 position seek、不同码流的 keyframe 行为和原生解码器协商的 AvgTimePerFrame 仍需更多对照，不能据 MP4 平均时长声称所有 DirectShow splitter／codec 等价。

`VideoEvent.callbackFrame` 与公开 snapshot 分离。原 BufferRenderer 的 `p1` 来自 IMediaSample media time／renderer 计数，不是 PTS 数组 ordinal；原消费者在 layer 模式保留与 GetFrame 相差至多一帧的值，超过则校正，mixer 总用媒体时钟。本浏览器 producer 将 rVFC mediaTime 按 cadence 转换后应用该消费者规则，明确属于浏览器呈现近似；公共 snapshot 始终读实际 media clock。真实 rVFC 按 segment → frame → period 顺序处理，layer period 使用修正后的回调值；timeupdate／ended 仍保留媒体时钟补漏策略，不把补漏当作呈现某帧的证据。

新增第九个独立编号 VFR 媒体：72 图像的时间戳按 12 Hz 的 `0,1,3,4,…,106` tick 排列，最后一帧一个 tick，总计 107 tick。首个平均帧请求约 123.8425 ms，位于 83.333…–250 ms 的 sample 内。托管 FFmpeg 继续为原八个视频和新视频保存全部参考 PNG、时间与哈希，总计 648 张。浏览器用真实暂停时钟、回调以及七位图像条码识别该帧；有损编码内点阈值用于识别图像，不冒充完整像素零差异。

原源新增 `BufferRenderer`、`dslayerd`、`CVMRCustomAllocatorPresenter9` 原件、哈希及审查在 `out/verification/video-tracks/reference/094-frame-clock-review.md` 和 `win32/krmovie/094-renderer-manifest.json`。

## 视频空间锚点

`VideoOvlImpl::SetRectangleToVideoOverlay` 对四条边使用 `ActualZoom`，再加 `WindowForm.GetWindowHandle` 的客户区偏移。该偏移不包括 PaintBox 的 LayerLeft／滚动。因此 DOM overlay／mixer 锚定 viewport，随实际缩放但不随图层滚动；只有 vomLayer 的实际图像通过 Layer 绘制和滚动。混合位图的归一化也使用当时的实际缩放。旧 host 几何夹具的偏移期望按该固定源修正，并增加 outer 与 viewport 尺寸不同、实际与公开 zoom 不同、滚动后的独立锚点检查。

## 已定位的夹具问题

fullscreen Node 矩阵的函数放在 Dictionary 中，未限定的 `win` 被其动态上下文中的缺失成员遮蔽；改为 `global.win` 才真正调用被测 Window。浏览器 fullscreen 和八窗退休夹具要检查 Layer 随 Window 销毁，就必须先 `Window.add(layer)`：原 Window 只失效其登记对象列表，Layer 构造不会自动登记。本批增加明确登记，保留原 `0,0` 销毁断言；没有让生产代码强制销毁外部 Layer。旧截图、原错误与 `094-fullscreen-close-evidence.json` 保留。

旧夹具仅在确实把 drawable 尺寸／物理页面位置当作前提时修订：菜单建立后明确请求 inner 尺寸、响应式 IME 以整个外框缩放、caret 对比实际页面矩形。真实 outer 合同继续独立测试。

## 有方向的宿主堆诊断

091 崩溃发生在 glibc malloc(32)／`node::RegisterDestroyHook`，同时有 V8 WASM 优化编译线程；这个栈不证明 TJS Layer 释放写坏了宿主堆。headless 仅使用 WASM 与 stub graphics，未发现可确认的新 bridge UAF，不无据修改生产内存管理。

新增独立 hosted 诊断作业，固定 Node **24.19.0** 与同一构建，默认 V8／`--liftoff-only` 各完整运行同一 20 定义文件三次。固定库存不会首轮成功即停止；同步保存子项开始／通过／失败和 Session 操作边界，保存 runtime／WASM 哈希、库版本、core 原件压缩包及 backtrace。普通 Node 门禁与产品 flags 不变。干净对照也不能抹去旧崩溃；诊断超时、失败、日志缺口与 core 压缩失败独立保留。审计依据在 `out/verification/node-lifetime/094-layer-lifetime-audit.md`。

## 验证与剩余范围

本批新增 **35 个 Node 定义**（几何 21、通道与输入 6、媒体 8）以及**每浏览器 20 个定义**（几何 8、CFR／VFR 时钟 12），覆盖真实 MessagePort 关闭／退休／过期回复、源码／字节码的几何事务与回调语义。宿主堆诊断另运行既有 20 定义 × 3 次 × 2 模式，共 120 次调用，不计为新增定义。既有 strict 像素、生命周期和兼容门禁保留；新增作业接入 All tests。全部本批定义仍待 GitHub-hosted 执行，静态审查不构成通过结论。

下一轮先补取 092 的缺失 shard／终态，再回收 093 与本批固定快照。183 光标严格差异、历史宿主堆崩溃、旧视频编码／原生 seek、fullscreen popup 的 OS 定位、更多窗口 API 和真实游戏兼容缺口仍未闭合；整体目标保持 active。

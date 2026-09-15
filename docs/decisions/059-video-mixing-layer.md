# 059：VideoOverlay 的调用时混合图像

本阶段实现 `VideoOverlay.setMixingLayer` / `resetMixingLayer`，让 `vomMixer` 视频使用调用时的 Layer 主图副本。[完整回归 35008104463](https://github.com/fenghengzhi/krkr2-web/actions/runs/35008104463) 在 `d4fe7cc633765f77dd59862f6000518d3c086768` 实际通过 **1,833 项 Node、1,278 项浏览器和 6 组直接运行时**，14 个作业全部成功，所选用例无失败、取消、跳过或重试。历次构建与浏览器失败仍分别保留于文末。所有可执行验证只在 GitHub-hosted Actions 进行，本机未执行测试、类型检查、构建或浏览器验证。

该绿色运行仍收集到一份 WebKit Networking 诊断：`is_simulated=1`、`EXC_GUARD/GUARD_TYPE_USER`，栈中有 `didReceiveInvalidMessage`；WebKit 的 385 项常规案例均通过。报告及 SHA-256 已归档，现有日志不能把该 PID 关联到具体案例，不将它称为已证实的进程崩溃，也不把原生诊断写成空。此前 WebKit 启动停顿或其他历史故障的根因没有因此被证明修复。

组合基线为 `2b16fe5`，包含 058 System 对话框的焦点顺序及 Firefox 组合输入夹具修订。058 首轮已报告的失败与未报告案例仍分别保留，不能当成通过；后续原 KAG 与旧版本升级结果以组合版本的独立兼容工作流记录为准。

## 原版合同

依据固定官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable 源码和原版 2.32r2 SDK 文档：

- [TJS 方法绑定](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp#L403)先检查参数数量和真正的 Layer 原生实例，允许 null，没有同 Window 限制。两个方法均返回 void。
- [SetMixingLayer](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L1002)在未打开视频时直接返回；已打开时 null 或自身隐藏的 Layer 清除混合。可见 Layer 读取 `left + imageLeft`、`top + imageTop`、整张 MainImage 和自身 opacity；父坐标、祖先可见性、子层、绘图 clip、Layer type 不参与。可见但没有主图时，GetImageLeft 先报错；自身隐藏则先清除，不要求主图。
- SDK 的 setMixingLayer 页面明确说明：图像在调用时取得，后续图像修改需再次调用方法。原生函数也没有保存 Layer 引用；临时 HDC 分支在方法返回后立即删除位图与 DC。
- [VMR9 下层](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/krmovie/dsmixer.cpp#L316)只设置 HDC 和 FilterMode 标志，没有 color key。HDC 输入不提供逐像素 alpha，因此使用主图 RGB 和独立的 `opacity / 255.0f`，忽略 Layer mask。[Microsoft VMR HDC 文档](https://learn.microsoft.com/en-us/windows/desktop/DirectShow/displaying-an-application-supplied-bitmap-on-the-composited-image)
- 普通 overlay 和 layer 后端继承[空的 SetMixingBitmap / ResetMixingBitmap](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/krmovie/dsmovie.cpp#L892)。有效的非 mixer 请求无效果；上层可见无图检查仍先发生。

原始源码、SDK HTML 和哈希清单归档在主工作区 `out/verification/video-mixing/reference/`；详细只读合同为同目录上一层 `contract.md`。这批材料没有执行原版视频引擎，不能当作原版实测结果。

## 快照、位置与 Web 呈现

Session 通过 `LayerService.cast` 验证 native lifetime identity，不信任可写的 `__id` 或自称为 Layer 的类。验证发生在未打开视频的空操作之前。复制发生在第一个异步 backend 等待之前，不触发 onPaint、piledCopy、图层更新或转场完成。源 Layer 可以来自另一 Window；调用结束后没有新增长期 Layer 强引用或观察者。修改、隐藏、释放原主图、失效源 Layer 或关闭源 Window 都不会改变已复制图像。

目的矩形四边为 `(edge + 0.5) / outputDimension`，保持原生 float32 运算；分母来自调用时 video 输出矩形，非视频原始尺寸，且不减去 video.left/top。[上层设置输出矩形](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L490)先应用 Window zoom。实现直接读取引擎 Window 状态，按每条边的 MulDiv 四舍五入结果相减求宽高；正负半整数向远离零的方向舍入，溢出返回 −1。[MulDiv 官方说明](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-muldiv)

规范化矩形保留在快照中。后续修改视频尺寸或 Window zoom 时，现有混合图随视频一起缩放；再次 set 才按新输出矩形重新归一化。Mixer 的 Host 输出布局与捕获共用每边 MulDiv 的计算，不能一边按取整后的宽度归一化、另一边继续按 `width * zoom` 显示。比如 `left=1,width=3,zoom=1/2` 的输出宽度是 1，并非 1.5。非 mixer 的既有布局不在这次坐标修订范围内。页面响应式尺寸只增加外层显示缩放，不能改写调用时坐标。负坐标和超过视频范围的图像由视频容器裁剪。

浏览器继续用 HTMLVideoElement 解码视频和播放声音。每个 Movie 单独持有一张静态 Canvas，放在该 video 上方，只在 set 时复制图像；不逐帧读取视频。画布的 opacity 与 video 的 mixingMovieAlpha 独立，因此 movie alpha 为零时仍能显示混合图。reset 只移除混合画布，保留播放状态、时间、视频透明度和背景。新的 open 不继承之前的混合图。

## 资源与失败路径

新增 `VideoCommand` 的 mixing 操作携带 `id`、`epoch`、独立 RGBA 副本、冻结 normalized rectangle 和 global opacity。会话协议版本升为 13，页面与 Worker 必须使用同一发布版本。引擎副本将 mask 设为 255，原 Layer 数据保持不变。MessagePort 再复制属于请求的传输数组；不会 detach 调用者数组、子数组所在 backing buffer 或活 Layer 主图。浏览器同样复制直接调用者提供的数据。

Host 为全部视频的混合画布设置 64 MiB 存活 backing 总预算，独立于压缩视频资源预算；单图尺寸仍受 4096 限制。新的尺寸、数据长度、坐标、opacity 和预算通过验证，并成功建立画布之后，才替换旧画布。构造替换期间可能短暂同时存在新旧 backing，不将这个暂态描述为 64 MiB 绝对进程内存上限。失败不会以半成品覆盖旧图。

混合请求沿用 VideoService 的 in-flight、断连和 epoch 验证。关闭、重开、停止或 Window 退役不会让旧请求重新创建媒体。画布与 Movie 一起迁移到同一 Window 的替换 surface；它没有独立 Window 生命周期。释放先撤销持有关系和预算，再清除 DOM 与 backing，即使其他资源清理抛错也继续回收。源 Window 的关闭不撤销另一目标 Window 已取得的快照。

## 验证范围和剩余差分

新增 6 项纯测试检查 RGB/mask 分离、独立副本、可见无图检查顺序、非 mixer 空操作、float32 alpha、各边 MulDiv 取整与 video/image 坐标；另有 1 项真实 MessageChannel 传输用例检查原始数组有效性。真实 TJS 的源码与字节码各 10 项检查参数、native 身份、跨 Window、调用时快照、close/open、待决请求和 Stop 释放。浏览器新增 6 个实际 Session 模板（三浏览器共 18 项），使用实际 colors.mp4、真实 TJS 与混合容器截图，比较源图变化前后、重新 set、reset、独立 alpha、缩放及 Window 生命周期的实际像素；其中分数 zoom 同时检查输出矩形取整与合成像素。Host 新增 8 个模板（三浏览器共 24 项），检查预算、失败替换、过期 epoch 和资源清理。

这些用例已编写或部分作业通过，不等于本阶段完整通过；所有失败和未完成结果须分别保留。此前阶段的通过也不能替代本阶段证据。

原生请求 bitmap point filtering，但[最终 presenter](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/krmovie/CVMRCustomAllocatorPresenter9.cpp#L664)优先线性缩放整张已合成视频。独立 Web Canvas 的分数坐标、缩放滤波、色彩转换和 alpha 舍入尚未与 VMR9 逐像素标定；这里保留可解释的 normalized geometry 和核心快照行为，不声称所有 VMR9 屏幕像素等价。原版设备重建后的 bitmap 保留行为也未取得实测证据。

既有 Layer.left/top 仍接受超出 int32 的 JS 安全整数，目标 VideoOverlay 方法仍通过其 `__videoId` 注册值查找对象；本次加强的是来源 Layer 的 native identity。全部 Layer 大整数转换和 Video 方法接收者绑定的统一校准属于后续范围，本阶段不能据此宣称这些既有接口已完全等价。

## 首轮类型检查记录

[35004938171](https://github.com/fenghengzhi/krkr2-web/actions/runs/35004938171)（`46a7591`）和 [35005314239](https://github.com/fenghengzhi/krkr2-web/actions/runs/35005314239)（`5e2cd67`）都在 Worker 类型检查处失败：新的 DOM 混合画布模块被 Worker 的 backends 扫描纳入，因而找不到 HTMLCanvasElement／document。后者只同步了 058 的模态测试适配器修订，没有解决这一独立边界；两轮均未进入用例执行，不计任何测试通过。

后续将 Worker 配置中只排除 video/browser/host.ts 改为排除其完整 DOM 宿主目录。主线程类型检查仍通过 createPlayer／WebVideoHost 的实际依赖检查其中两个模块；没有给 Worker 或 engine 加入 DOM 类型，也没有关闭类型检查。两轮原始构建日志与未执行状态独立保留，后续结果另记。

[35005524084](https://github.com/fenghengzhi/krkr2-web/actions/runs/35005524084)（`0f5e9fc`）通过上述 Worker 边界后，在 tools 项目的 `web-video-mixing.ts:244` 报 TS2683：测试里临时替换 getContext 的函数断言丢失了 this 的上下文类型。后续仅为该故障注入函数添加 HTMLCanvasElement 的 this 参数类型；不改产品、断言或检查选项。这轮同样未执行用例，原始失败另存。

## 首轮浏览器执行与夹具修订

[35005817503](https://github.com/fenghengzhi/krkr2-web/actions/runs/35005817503)（`a7bea99`）构建和 Node 作业成功。已下载的 Chromium 与 Firefox 常规浏览器报告均为 **381 通过、4 失败／385**；本节不把部分作业结果视为整轮通过，也不覆盖该轮原始失败。原始 ZIP、trace 和 error-context 分别保存在 `out/verification/github-actions/35005817503/early-chromium/` 与 `early-firefox/`，逐项静态提取另记 `out/verification/video-mixing/35005817503-failure-classification.json`。

三项混合透明度用例已完成原始 RGB、mask、副本不随编辑改变及 opacity=128 的截图检查，随后等待错误的字符串 `0` 超时。原始日志实际有对应 marker 的 `+0.0`，表达式已经执行结束；这是 TJS real 零的字符串形式。修订保留相同表达式和零透明度预期，精确匹配 `+0.0`，并同步修正后续 reset 的组合结果为 `+0.0,255`。没有改动属性实现或放宽像素断言。

四项跨 Window 用例原始日志返回 `0,1`，原夹具误期望 `0,0`。Window 关闭仅失效显式 `Window.add` 的对象；本夹具仍用全局变量持有 source 和 rootA。DrawDevice 释放 manager 引用不等于失效仍被引用的 Layer，图像在 Layer 自身失效时释放。[原版 Window 清理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L181)、[DrawDevice 析构](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/DrawDevice.cpp#L34)、[Layer 构造与清理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L397)。修订明确要求 Window 已无效、source 仍有效且 `.window===null`、原主图仍可读；再显式失效 source，并再次检查目标视频的 magenta 快照。原有 Window 消失、只剩一份 video／bitmap 和全部截图断言保留。

Firefox 的 JSPI 混合透明度用例在更早的 ready 检查失败，必须单独解释。trace 中启动日志和执行按钮检查已通过，随后 27 次找到视频元素却没有 `data-presented-time`；原始 screencast 同时显示红色视频与紫色混合图。Host 在设置 src/load 之前注册 rVFC，并要求 loaded 与 presented 同时完成才结束 open；测试原先到 loadedmetadata 事件才另外注册观察回调。trace 没有记录这两个底层事件的精确先后，不能将其进一步描述为已证明的 Firefox 内部调度问题。

修订只在本文件透明包装现有的 requestVideoFrameCallback，以真实浏览器 metadata 记录呈现时间，再保留原 this／参数转发同一个回调并返回原 request ID。没有新增或取消帧请求，不改生产加载、seek、播放或等待顺序；ready 仍要求时间 0、暂停且不在 seek，实际合成截图仍需通过。原 trace SHA256 为 `4618de17c3870d494412d10b72f5fe31c186608e77936b51f882b403a6d677d9`。三类修订均未在本地执行，仍须新的 Actions 结果验证。

上述第四轮 `35005817503` 的最终实际结果为 Node **1,833/1,833**、浏览器 **1,265/1,278**、直接运行时 **6/6**。其中 WebKit 常规为 **380/385**：四项混合用例属于上述字符串／源 Layer 生命周期预期，另一项旧 `video-readiness.spec.ts:100` 在第二次启动等不到 `frame-open-ready`。失败前和 error-context 仍为 LOADING，但失败后晚 105.852 ms 的 trace snapshot 已出现该标记、第二个 video、运行中和 16 MiB VM；必须同时保留两组观察。为何断言未在预算内观察到它尚不确定，没有据泛化的浏览器错误文字推断 OOM。新一轮绿色结果没有追改这轮失败。

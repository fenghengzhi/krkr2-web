# 077 — 鼠标 manager 顺序与共享 DrawDevice 几何

状态：实施候选，尚无本批执行结果。测试、类型检查、构建和浏览器验证只在 GitHub-hosted Actions 运行；本地只编辑与静态审读。下面的验收数量是已定义库存，不是通过数。075、076 的历史结果另行保存，不作为本切片的通过证据。

## 问题与决定

076 暴露了两个相连的差异：Web down 会额外执行 mouse move，改变 hover、最后一次移动位置及 cursor/hint 通知；鼠标投影、画面、虚拟光标和 IME 锚点则直接使用 zoom 比值，跳过原版 PaintBox 整数尺寸和 origin 的舍入。对于非整倍缩放或非零 layerPos，画面与输入可能落在不同位置；Window 回调中修改变换，还会使已经入队的事件被重新解释。

本切片按固定 2.32stable 的 Window → DrawDevice → LayerManager 顺序处理鼠标，并用 `src/engine/scene/draw-device.ts` 统一几何。浏览器在采集事件时保存 PaintBox 整数点，Session admission 给未提供该点的旧调用方补齐快照；Window 回调后只重新采样当前目标尺寸。显示中的 manager 按稳定注册身份选择，交换 primary Layer 不改变 manager 优先级。

**会话协议由 24 升为 25；TJS ABI 仍为 5，字体 ABI 仍为 2。** 新字段是可选 `InputPacket.paintBoxPoint: { x, y }`，只允许 move/down/up/wheel 使用，两个坐标均须为 int32 整数。原始 `x/y` 与 075 的 `pointerSequence` 保留：前者用于物理位置观察，后者用于物理输入接管及迟到消息去重。

## 固定来源

基线为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/`。原字节、URL、长度及实际 SHA-256 保存在 `out/verification/custom-cursor/source/manifest.json`；本批相关锚点与 Microsoft MulDiv 文档归档列于 `out/verification/mouse-manager/source/manifest.json`。这些是静态来源证据，没有执行固定 Windows 引擎。

| 原文件 | SHA-256 |
| --- | --- |
| `visual/win32/DrawDevice.cpp` | `15487b0680f966c622bc217a23a17dce5f8cec527a7b48c6283badc2ae37f021` |
| `visual/win32/WindowFormUnit.cpp` | `14a1cab6980f499811ba961c72da7599caec8674bd53aa6a247e24c11a5518af` |
| `visual/win32/WindowImpl.cpp` | `c661fd84993d83f51ebce4ec0bcd54aaefddc8007abaf1a5adda9655d0837488` |
| `visual/WindowIntf.cpp` | `6fb38c8479b8d61c414d780e93092858d643e49da2eead138b4e94dc226e2239` |
| `visual/LayerManager.cpp` | `28e38241876d6b644870af1b8df4d18feb2bc0ad1e3bf57dbd7eec099a613d09` |
| `visual/LayerManager.h` | `ce19fe5d1cabdac611dfe8ab7bf2898042fb2aa73955d41b5f0be0c1943d3223` |
| `visual/LayerIntf.cpp` | `05a8279842f1e4a057c7b9005437fbc85579524307864509e47429228f59240b` |

[Microsoft MulDiv 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-muldiv)的 HTML 保存为 `out/verification/mouse-manager/source/MulDiv.html`，51,494 字节，SHA-256 为 `849d0609a0c5fa5dcd9f98db8c679e05e67ccc805c4730408764b9496481a864`。原版 headers 与其他相关文件的完整来源清单沿用 076 归档。

## 坐标合同

设显示中的 primary 尺寸为 `W/H`，Window 的 layerPos 为 `L/T`，zoom 为 `N/D`。`M(a,b,c)` 表示 Win32 MulDiv：int32 输入、64 位乘积，商舍入到最近整数，正负半整数均远离零；除零或结果超过 int32 时返回 `-1`。`I(v)` 表示先向零截去小数，再窄化到有符号 int32；`Q(a,b,c)` 表示整数乘除，除法向零截断，分母为零时返回零。

| 阶段 | X 方向公式 | Y 方向公式 |
| --- | --- | --- |
| PaintBox origin | `OX = M(L,N,D)` | `OY = M(T,N,D)` |
| PaintBox 目标尺寸 | `DW = M(W,N,D)` | `DH = M(H,N,D)` |
| 捕获的鼠标点 | `PX = I(I(rawX)-OX)` | `PY = I(I(rawY)-OY)` |
| DrawDevice → primary | `X = Q(PX,W,DW)` | `Y = Q(PY,H,DH)` |
| primary → Window 客户区 | `I(Q(X,DW,W)+OX)` | `I(Q(Y,DH,H)+OY)` |

PaintBox 的尺寸来自显示中的 primary，不能拿 Window 客户区尺寸替代，也不能把 `W/DW` 简化成 `D/N`。原版 [InternalSetPaintBoxSize](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L808) 用 MulDiv 分别计算 origin、宽和高；[NotifySrcResize](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp#L1407) 从 DrawDevice 获取 primary 尺寸。整数正反投影见 [DrawDevice.cpp:50–83](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/DrawDevice.cpp#L50)。

例如 primary 为 `101×103`、zoom 为 `1/2`、layerPos 为 `(3,-3)`，origin 为 `(2,-2)`，目标尺寸为 `51×52`。raw `(20.875,15.875)` 先成为客户区整数 `(20,15)`，再成为 PaintBox `(18,17)`。如果 Window.onMouseDown 把 zoom 改成 `2/3` 并修改 origin，Layer 仍使用旧 `(18,17)`，但通过新尺寸 `67×69` 得到 primary `(27,25)`；位于 `(10,6)` 的子层收到 `(17,19)`。回调内的新 origin 不能再从旧点中减一次。

固定 VCL [PaintBoxMouseDown/Move/Up](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1802) 已拿到 PaintBox 相对整数坐标；[WindowIntf](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L320) 先执行 Window 回调，再调用 DrawDevice。这决定了上述快照时机和回调后投影次序。负数除法使用向零截断，例如 `-25*101/51` 为 `-49`，不能用 floor 得到 `-50`。

到达 primary 后才减去 Layer 及祖先的整数偏移，逐步保存 int32 结果。物理观察的 raw 坐标不因这个转换被改写。touch 的坐标和接触尺寸仍是 real，使用当前共享目标几何的 X/Y 比例，但不进入鼠标 int32 转换，也不携带 paintBoxPoint。

## manager 时序与引用

固定 [NotifyMouseDown](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.h#L287) 直接调用 PrimaryMouseDown，没有前置 PrimaryMouseMove。本批移除这个额外 move，因此程序直接 down 可以命中并捕获目标，但不会伪造 enter、move，或覆盖最后一次已交付 move 的坐标。

- **Down：** 在 Window 回调后完成一次 primary 投影，再按现有 capture 或真实命中选目标。目标回调中的 releaseCapture 必须阻止重新捕获。替换 capture 时，先释放旧 VM 引用，再取得新引用；引用释放可能执行 finalizer，继续前检查 controller/window 的存活。成功的目标 down 回调与 capture 处理后清空 hint；异常不会执行后续成功路径。
- **Up：** Window 回调后只投影一次。目标 Layer 回调改变 zoom 或 layerPos，后续释放 capture 和 mouse recheck 仍使用已经求出的 primary 点。有目标且所有鼠标按钮均已松开时才释放并复查；无目标、仍有其他按钮按下、或目标回调抛异常时，不额外制造这个复查。
- **Move：** `poschanged` 比较的是前后已交付的整数 primary 点。raw 小数发生变化而仍落在同一 primary 像素，不产生额外 Layer.onMouseMove；Window.onMouseMove 仍接收本次整数点。变换发生变化时，相同 raw 点也可能投到新的 primary 像素。
- **Leave 与强制复查：** 无 capture 的 leave 使用已经属于 primary 空间的 `(-1,-1)`，不能经新 origin/zoom 投影。ForceMouseRecheck 使用保存的 primary 点和零修饰键；它不重新解释最近物理 raw 采样。

依据为 [LayerManager.cpp:355–539](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L355)。数值 cursor/hint 的继承、通知采样和共享重入保护继续遵守 076。

已被 native invalidate 的捕获对象可能仍由 manager 的 VM 引用持有。该对象退出 LayerTree 不等于把捕获事件改投给下面的 Layer；实现保留 manager 数值槽，禁止已退休对象回调，并在需要 hover 持有同一对象时从既有 VM ownership 槽复制引用。这里解决的是“已有 capture 引用，再 invalidate”的路径，没有新增 host retain，也不恢复已关闭 Window 的输入。Stop/manager 清理仍必须释放这些槽。首次 down 回调内 self-invalidate 后新建 capture 的差异尚未闭合，见后文边界。

## 显示、脚本指针与 IME

Session 将同一 PaintBox origin 和整数目标尺寸传给 SceneComposer；X/Y 比例分别为 `DW/W`、`DH/H`，允许因宽高分别舍入而不同。普通子层矩形和裁剪保留绘制所需的小数精度。本批不把整数鼠标规则套到所有渲染中间量。

每个 Window 只向 renderer 提交显示中的 manager 的 primary 树；未显示的 secondary primary 不改变目标尺寸或加入画面。选择依据为稳定 `managerId`，而非当前 primary Layer 的创建先后：原版 [AddLayerManager](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/DrawDevice.cpp#L106) 保留注册顺序，[primary exchange](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L900) 只在原 manager 内重新 AttachPrimary。`Window.primaryLayer`、输入 root 和渲染选择共用同一策略。

075 的 cursor getter/setter、虚拟 marker 和 attention anchor 也使用共享正反投影。因此 setter 与 getter 不保证数值互逆：上述 `101×103` 半尺寸场景，primary `(45,50)` 投到 PaintBox `(22,25)`、客户区 `(24,23)`；读回只剩 primary `(43,49)`。这是整数目标像素造成的信息损失。075 的每层 cursorX 暂存、cursorY 提交、setCursorPos 不改暂存 X、物理 sequence 接管和会话存活保护保持有效。

目标宽或高被舍入为零时，对应输入投影返回零，画面没有可绘制面积；不会除零或输出 NaN。detached/secondary manager 的 cursor getter/setter 差异仍按 075 的原版合同保留，不能把 secondary manager 当成显示中的 primary。

## 待运行验收

| 文件 | 当前定义与目的 |
| --- | --- |
| `tests/conformance/mouse-event-order.test.ts` | 11 个场景 × source/bytecode，共 22 个真实 Session 用例；直接 down、旧 move 样本、无目标 up、两级回调改变变换、按钮捕获、异常与 releaseCapture、primary 整数变化、leave、快照深拷贝和旧调用方 admission。 |
| `tests/conformance/draw-device-geometry.test.ts` | 4 个场景 × source/bytecode，共 8 个真实 Session 用例；捕获 renderer.present 的实际 FrameLayer 几何/clip，交叉检查 cursor/attention、secondary manager、零尺寸和 primary exchange。检查对象是提交给 renderer 的帧，不是最终浏览器像素。 |
| `tests/conformance/mouse-capture-lifetime.test.ts` | 共 6 个用例：2 个 controller/service ownership 用例检查重入释放顺序，另 2 个场景 × source/bytecode 构成 4 个真实 Session 用例，检查已有 capture 的 invalidate、既有 VM 引用别名和清理边界。 |
| `tests/conformance/window-mouse-coordinates.test.ts` | 6 个 controller/service 用例，其中本批净增 2 个；int32、负数截断、分别舍入的目标尺寸、入队 origin 与回调后尺寸、touch real 和 TJS variant 类型。 |
| `tests/browser/window-mouse-manager.spec.ts` | backend × source/bytecode 共 4 个定义，由 Chromium、Firefox、WebKit 运行，共 12 个计划项目实例；真实物理拖动、非零 origin、非整尺寸、Window 回调修改变换和负坐标捕获。JSPI 不支持时按既有能力条件跳过。 |

新浏览器测试通过 MessageChannel 被动记录原日志及之后的 state 序号，等上次变换完成发布后才发下一个物理事件；期望值独立按固定整数公式写出，没有调用产品几何 helper 生成答案。断言 down 不额外产生 move，并保留真实 mouse-up 和 Stop 清理。

既有 Layer cursor、attention、multiwindow 浏览器坐标期望，以及相应 conformance/integration 用例，按同一几何调整；焦点、IME、physical takeover 与生命周期断言继续保留。原 KAG compatibility 验收由完整批次运行。任何静态审读、跳过、未执行或中断的工作流均不能计为通过。

## 明确保留的边界

- Web 仍从 up packet 的 clicks 信息合成 click/double-click。固定 VCL 的 [PaintBoxClick](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1780) 使用保存的 LastMouseDown 坐标；本批没有声称两种操作系统入口在所有顺序与位置上等价。
- 首次 down 回调 self-invalidate 后，原版仍可将尚未析构的 invalid Owner 新设为 capture；Web 在 LayerTree finish 后不会新取得该引用。这不同于本批已处理的“原先持有 capture，再 invalidate → hover 别名”。现 WeakObject 缓存不能补齐前者：runtime upgrade 与 bridge 的 `krkr_owner_upgrade`/`krkr_value_set_owner` 均拒绝 `IsLifetimeValid()==false`，finish 还会 unobserve 并移除 token。完整解决需要独立设计只在实际析构时失效的 native weak identity、对应 ABI 和寿命验收；不能通过延长所有 callback 的强引用来冒充一致。本批不宣称所有 capture 生命周期均与原版等价。
- BigInt 用于准确实现已定义的乘除和 int32 窄化，不复制 C++ 有符号乘法溢出的未定义行为。MulDiv 的错误返回规则明确实现；原 Windows 引擎在极端溢出输入上的编译器偶然行为不属于本批兼容承诺。
- Web 使用当前 WindowView 的 zoom 和 layerPos。原 VCL 的 ActualZoom、OS fullscreen、滚动条及 PaintBox 布局还可受操作系统改变，本批没有实现这些 OS 窗体机制；浏览器 CSS 尺寸换算也不等同于 Windows screen/client API。
- wheel 的 Web 入口使用当前 canvas 客户区采样并捕获 PaintBox 点；固定 Windows 的 DirectInput 和窗口消息路径不同，本批不据此宣称模拟了所有 OS 鼠标输入机制。
- 本批不是 CUR/ANI 自定义 cursor 支持。完整资源解析、热点、动画、AND/XOR 背景运算、缓存与生命周期范围继续见 076。

执行结果应在下次回收该批 GitHub-hosted Actions 的固定 run/artifacts 后补充；不实时轮询，不用本地执行替代。

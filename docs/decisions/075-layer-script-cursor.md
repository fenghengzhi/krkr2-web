# 075 — Layer 光标写入与 KAG 键盘链接导航

状态：实施候选，尚未执行验证。所有构建、类型检查、VM、Node 和浏览器检查只在 GitHub-hosted Actions 运行。074 的运行与本切片分开记录；没有用前批次的测试数量证明新行为。

## 实际缺失链路与固定来源

原有 `Layer.cursorX/cursorY` 只有 getter，`setCursorPos` 未实现。固定原始 KAG `system/MessageLayer.tjs` 的 `setFocusToLink` 在 2275–2276 写入两个属性；`onKeyDown` 的方向键和 Tab，以及 `onBeforeFocus`，都会调用这个原方法。鼠标点击能选择链接并不代表键盘这条路径可用。

KRKR2 基线仍为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788`，路径前缀 `kirikiri2/branches/2.32stable/kirikiri2/src/core/`。依据 [Layer.cursorX](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_cursorX.html)、[Layer.setCursorPos](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_setCursorPos.html) 及固定源码；邻接移植仓库只作定位线索，不替代原版合同。

| 原始文件 | SHA-256 |
| --- | --- |
| `visual/LayerIntf.cpp` | `05a8279842f1e4a057c7b9005437fbc85579524307864509e47429228f59240b` |
| `visual/LayerManager.cpp` | `28e38241876d6b644870af1b8df4d18feb2bc0ad1e3bf57dbd7eec099a613d09` |
| `visual/win32/DrawDevice.cpp` | `15487b0680f966c622bc217a23a17dce5f8cec527a7b48c6283badc2ae37f021` |
| `visual/win32/WindowFormUnit.cpp` | `14a1cab6980f499811ba961c72da7599caec8674bd53aa6a247e24c11a5518af` |
| 固定 KAG ZIP 的 `system/MessageLayer.tjs` | `322022ef5ed50dd945519c33f16c93fea5d578d30c66252f3695571e5e9b9f36` |

原源码字节及逐文件来源清单保留在 `out/verification/layer-cursor/source/manifest.json`；这不构成执行过 Windows 原版的证据。KAG XP3 与配对 ZIP 的固定身份沿用 [074](074-web-help-plan.md)，测试不重写原 MessageLayer 方法。

## 属性与坐标合同

- 每个 Layer 有独立暂存 X，初值 0。写 `cursorX` 只改变暂存值；getter 查询当前位置，不读暂存值。
- 写 `cursorY` 用暂存 X 和本次 Y 提交移动；祖先坐标在提交时读取。`setCursorPos(x,y)` 至少两参，先完成转换再移动，不改变暂存 X。额外参数正常求值。
- 坐标使用原版 `tjs_int` 的 32 位值。转换包括各级 Layer 位置、Window 绘制偏移和 zoom；整数除法向零截断，负坐标不使用向下取整。图像内部偏移不改变 Layer 光标坐标。
- detached Layer 没有 manager，查询为 0、提交不移动；已连接非主 manager 的 Layer 则沿原 DrawDevice 路径取得主坐标 `(0,0)` 后减去祖先偏移，其子层 getter 可为负数，但提交同样不移动当前 Window。暂存 X 仍可保留。失效对象不能借旧 ID 移动新对象。

原版最终调用 OS `SetCursorPos`。Web 不具备移动系统指针的权限，因此这里采用当前游戏窗口内的可见虚拟光标。它是产品适配边界，不宣称 OS 指针、其他应用或浏览器界面跟随移动。隐藏、被模态阻塞、后台或已停止会话不会接受新的可见移动；超出客户区的点不把图标绘制到其他窗口。永久隐藏鼠标状态保持隐藏，临时隐藏按原 `RestoreMouseCursor` 路径恢复。Web 坐标沿现有 renderer 的 zoom 比例保持一致；Windows DrawDevice 对整数 DestRect 的最终量化及原 C++ 极端溢出没有被当前测试证明等价，自定义光标文件加载也仍待后续实现。

## 事件、呈现与物理输入接管

成功提交立即可供脚本 getter 查询，并把普通 move 放入已有 System 事件队列。沿现有 InputController 路径调用 Window 和 Layer 鼠标事件、执行命中、hover、hint 和 capture；不在宿主导入中递归执行 TJS，也不建立第二个事件循环。移动带窗口、Layer、input generation 与 controller epoch 身份；被后续移动替换、物理输入接管、暂停、移除 manager、Stop 或对象释放后，排队旧移动失效。原事件禁用与恢复策略保持适用。

`InputView.virtualCursor` 包含客户区 `x/y`、会话递增 `revision` 和提交时已观察的 `basePhysicalSequence`。BrowserInput 将它按 canvas 实际 CSS 尺寸映射成不参与命中的图标，并保留当前光标形状/隐藏规则。暂停、隐藏、销毁和 Stop 撤销图标。

每个 Window 的真实鼠标采样具有递增 `pointerSequence`，同一次采样同时附在立即 `pointerState` RPC 与正常输入包；Worker 去重后不会让迟到的旧输入包覆盖较新的脚本位置。序号跨同一 Window 的 surface 重建连续，新会话重新开始。DOM 一观察到物理输入即撤销图标；迟到快照的 `basePhysicalSequence` 小于本机已发送序号时被拒绝，避免旧虚拟光标复活。脚本虚拟 move 不伪装成物理采样，旧 embedding 无序号入口仍可调用。

新增协议字段使会话协议升至 **24**。TJS ABI 5 和字体 ABI 2 保持；本切片不更改内核 nativeHelp 等能力版本。

## 待运行验收

真实 Session source/bytecode 定义覆盖暂存顺序、参数与整数边界、当前祖先和缩放、detached/reattach、hover 回调、队列非重入、物理序号去重、暂停/Stop 及多窗口隔离。真实浏览器定义覆盖图标位置和形态、实际鼠标接管、旧快照、surface 与会话生命周期。

新增 `cursor-kag.ts` 从固定 XP3 启动原 MessageLayer，载入两个普通链接的独立场景，用真正的 ArrowRight/ArrowLeft/Tab/Enter 操作。独立 Timer 只记录原链接状态，不改原四个方法；必须出现新的 keyLink/lastLink 观察和不同的高亮画布。随后在光标仍可见时，将真实鼠标移到第二个链接的当前热点并确认图标撤销，再用 Enter 跳转第二条链接、Stop 释放 Worker。物理接管必须在 Enter 前证明，避免原 `processLink` 的临时隐藏操作使断言空过。保留原始文件、场景、探针、构建身份、每阶段 JSON/截图和 trace。

兼容库存新增三浏览器 × 两后端的 6 项，成为 **96 项预期案例**；这是计划覆盖范围，不是通过数。新的 helper、源代码、类型和运行结果都需要下一批 Actions 证明。

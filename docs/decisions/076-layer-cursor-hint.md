# 076 — Layer 数值光标与提示的继承、通知时序

状态：实施候选，托管验证结果待回收。本切片修正数值 `Layer.cursor`、`hint` 和 `showParentHint` 的呈现时序；**CUR/ANI 自定义光标加载仍未实现**。构建、类型检查、VM 和浏览器验证只在 GitHub-hosted Actions 运行。075 的结果单独记录，不作为本切片的通过证据。

候选已随 `3443f9fc6beaf1f1c79c60d7421587c482486d01` 推送至 [37231345437](https://github.com/fenghengzhi/krkr2-web/actions/runs/37231345437)。首次查询仅确认创建及提交身份，当时 in_progress；执行结果尚未取回，下批回收，不实时监控。下面的验收数量是用例定义，不能当成通过记录。

准备 077 时的一次回收仍为 in_progress。已发布的 13 份 ZIP 全部核对 digest；兼容检查 96/96 通过，library 57、PWA 59、trusted 7 通过，direct runtime 六组 failures 为空。Node 与四份常规浏览器作业尚无归档，本切片新加的 26 个 VM 用例和 24 个浏览器项目实例尚未取回，不能由兼容检查替代。保留首次快照与新 partial 摘要，后续只在下一批补取。

## 问题与决定

原 Web `InputController.view()` 每次直接取 hover Layer 的 cursor，没有 `crDefault` 的父链继承；hint 则在本层为空时动态向父层搜索。两者都把“属性当前值”当成“Window 已收到的呈现值”，会跳过原版通知的时机及回调顺序。

本切片在每个 Window 的 InputController 保留已经提交的 cursor/hint。`view()` 只发布这两个值，属性改变是否更新它们由真实输入通知决定。浏览器继续读取现有 `InputView.cursor/hint`，物理光标和 075 虚拟图标共用同一呈现值。**会话协议仍为 24，TJS ABI 仍为 5，字体 ABI 仍为 2**；没有新增资源协议或宣称支持光标文件。

## 固定原版合同

基线是 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/`。原始字节、下载 URL、长度及按实际字节计算的 SHA-256 保存在 `out/verification/custom-cursor/source/manifest.json`，研究笔记为 `out/verification/custom-cursor/research.md`。这些是静态来源证据，没有执行原 Windows 引擎。

| 原文件 | SHA-256 |
| --- | --- |
| `visual/LayerIntf.cpp` | `05a8279842f1e4a057c7b9005437fbc85579524307864509e47429228f59240b` |
| `visual/LayerIntf.h` | `dd4e07bf42e58052d0cfccad8ac579dd56190834902b3d7d89e94e066a6efd0e` |
| `visual/LayerManager.cpp` | `28e38241876d6b644870af1b8df4d18feb2bc0ad1e3bf57dbd7eec099a613d09` |
| `visual/LayerManager.h` | `ce19fe5d1cabdac611dfe8ab7bf2898042fb2aa73955d41b5f0be0c1943d3223` |
| `visual/win32/WindowImpl.cpp` | `c661fd84993d83f51ebce4ec0bcd54aaefddc8007abaf1a5adda9655d0837488` |
| `visual/WindowIntf.cpp` | `6fb38c8479b8d61c414d780e93092858d643e49da2eead138b4e94dc226e2239` |
| `base/UtilStreams.cpp` | `f9fc77345614e9b313c404e41e0474ff4dc2d69bd9b8e14cf8ce44d414e6acd2` |

`LayerIntf.h` 为 36,333 字节，`LayerManager.h` 为 15,272 字节；其余归档文件，包括 DrawDevice、WindowFormUnit、StorageIntf 和 UtilStreams.h，列于来源清单。

- **cursor 原值与有效值分开。** getter 返回本层保存的数值 ID。有效光标从本层开始，仅当值为 `0`（`crDefault`）时继续找父层；数值设置按 `tjs_int` 的 int32 边界保存。参见 [LayerIntf.cpp 的设置与继承](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2583)。
- **只有匹配的 Layer 通知才改变 Window。** setter 先保存属性并采样有效 cursor，然后在 manager 中选择 capture owner，或用最后一次已交付 mouse move 的主层坐标执行命中检测。只有该目标正好是被修改的 Layer，才提交预先采样的值。因此鼠标停在默认 cursor 的子层时，修改父层不会马上改变显示；子层再次赋值 `0` 会重新通知。参见 [NotifyMouseCursorChange](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L210)。
- **进入新目标后才重新采样。** `PrimaryMouseMove` 在 enter 及一次命中复查结束后提交 cursor/hint；同目标内移动不重新遍历父链。目标从 Layer 变为无命中时提交默认 cursor 和空 hint。Force-leave、释放 capture 本身不等于重新呈现。参见 [PrimaryMouseMove](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L413)。
- **hint 的继承不检查空串。** 进入目标时，只要 `showParentHint` 为真就沿父层走，即使本层 hint 非空也忽略它。赋值 `hint` 总先把 `showParentHint` 设为 false，再通知原字符串；赋空串可以明确清空提示。`showParentHint` setter 只存布尔值，不通知、不重新命中。参见 [SetCurrentHintToWindow/SetHint](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2691) 与 [SetShowParentHint](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.h#L526)。
- **cursor/hint 共用重入保护。** setter 的命中回调可以改变属性，但嵌套通知不覆盖外层已经采样的呈现值；异常保留已写属性、维持旧呈现值，并释放通知保护以便后续恢复。enter 期间的通知同样受保护。鼠标按下成功执行目标回调及 capture 获取后清空 hint；同目标 mouse-up 不恢复它。参见 [NotifyHintChange](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L259) 和 [PrimaryMouseDown](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L355)。

## 实现范围与现有限制

`src/engine/input/controller.ts` 增加每个 controller 的呈现值、最后交付的主层整数坐标和共用通知保护，沿已有 cooperative input pump 执行命中回调。内部 ForceMouseRecheck 使用已保存的主层坐标和零修饰键，不因之后改变 Window zoom 而重新投影旧采样。`src/engine/session.ts` 将 cursor/hint setter 接到独立通知入口，避免通用 `Input.change` 隐式复查鼠标；showParentHint 直接存值。`src/engine/scene/layers.ts` 在 hint 赋值时关闭继承，`src/engine/tvp/layer.ts` 对 showParentHint 使用原布尔转换语义。没有为本切片新增 TJS 强引用或第二个输入循环。

暂停、窗口关闭、manager 切换和 075 虚拟光标的身份/物理接管规则继续适用。数值 cursor 的具体浏览器图形仍沿现有 CSS 映射及 075 图标，不构成 Windows 系统光标像素级一致性的证明。

一个已有入口差异保留：固定 [LayerManager.h 的 NotifyMouseDown](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.h#L287) 直接调用 PrimaryMouseDown；现 Web down 处理先进行 mouseMove。本批浏览器先真实移动再按下，不能据此证明“没有先交付 move 的程序化 down”与原版完全一致。更广的坐标量化和输入入口对齐仍需独立校准。

后续静态审计保存于 `out/verification/layer-cursor/input-order-audit.md`，已明确下一批应处理 down 的额外 move、up 无目标时的 capture 行为、up 回调改变 zoom 后仍复用原主坐标、leave 的固定主坐标及 poschanged 的坐标空间。普通浮点鼠标与 touch 路径、capture 的引用释放顺序也须按固定入口分别验证；本批不宣称这些差异已闭合。

## 待运行验收

`tests/conformance/layer-cursor-hint.test.ts` 定义 **26 个**真实 Session source/bytecode 用例，覆盖继承时机、原值与呈现值、shared guard、命中回调失败、enter 采样、最后交付坐标、zoom 后的旧坐标重查、capture、down 清提示、detach/窗口隔离、int32 与无命中恢复。已有 multiwindow 结构变更测试改用真实 move 建立采样后再显示图层，保持原“窗口移除后不得重新获得 hover”断言。

`tests/browser/layer-cursor-hint.spec.ts` 定义 **8 个** backend × source/bytecode × 场景用例，由 Chromium、Firefox、WebKit 三个项目运行，构成 **24 个计划项目实例**；不支持的 JSPI 按既有能力条件跳过。测试用真实键盘在鼠标仍悬停时修改属性，避免点击控制台制造 leave/re-enter；被动观察原 Session 事件，等待晚于命令或 mouse callback 日志的 state 序号，确认完成呈现后再作“不刷新”的负断言。浏览器断言覆盖 CSS 光标、canvas title、075 marker 共享呈现值、物理接管及 Stop 清理。

上述数字是待运行库存，不是通过数。此文不记录 075 的结果，也不把静态审读、未运行或被中断的执行当成通过。

同批修订验证证据采集：保留现有 spec/TAP 和进程日志，增加 `scripts/record-node-test-events.mjs` 作为第三 reporter，记录固定 Node v24.19.0 不受文件声明顺序缓冲的 enqueue/dequeue/complete 事件，显式保留错误与 cause。另给 selector-native 增加用例及 VM/host 调用边界 JSONL。两者不改变测试并发、顺序、断言或超时；日志写入失败会留下缺口记录，不覆盖原始测试异常。自然结束的 reporter 标记不是测试通过证据，文件聚合事件也不能重复计入用例数。采集器本身等待本批 Actions 验证。

## CUR/ANI 的完整后续范围

固定原版真正提供的是 `Layer.cursor` 字符串分支，未发现脚本 `Window.cursor` 属性。`LayerIntf.cpp` 仅对真实 `tvtString` 调用资源加载；非字符串才转数值。现 Web 字符串仍经过 `int(value)`，尚不等价于这个分支。

[WindowImpl.cpp:38–69](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp#L38) 先 SearchPlacedPath，再按解析路径查询进程级缓存；未命中时通过 LocalTempStorageHolder 调用 Windows LoadCursorFromFile，成功后分配从 2 开始的数值 ID 并登记到 VCL。失败不改变本层 cursor。非本地/XP3 资源会先复制到保留 basename 的临时文件，加载后删除；已加载光标不随 Layer 销毁释放，见 [UtilStreams.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/UtilStreams.cpp#L29)。

[Layer.cursor 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_cursor.html) 和 [LoadCursorFromFile](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadcursorfromfilew) 同时包含 CUR 与 ANI。原版将图像选择、热点及动画交给 Windows；完整后续工作需要有界的格式解码、全部动画帧及顺序/时长、资源热点、多图像选择、调色板/alpha 和 AND/XOR 掩码。AND=1/XOR=1 的背景反转不能由固定透明 PNG 等价表示，参见 [Microsoft 的掩码说明](https://learn.microsoft.com/en-us/windows/win32/menurc/using-cursors)；PNG 压缩资源及 ANI RIFF 容器另见 [资源格式](https://learn.microsoft.com/en-us/windows/win32/menurc/resource-file-formats)。首帧替代、简单 RGBA 或 CSS URL 被接受均不足以宣布这项支持完成。

完整接入还需保持解析路径缓存身份、getter 返回数值 ID、别名/autoPath/XP3 行为与失败原子性；资产由 Session 持有，数值 ID 在原 Layer 销毁后仍可复用。应先明确源字节、像素、图像候选、帧数、时间线和总资产预算，越限抛错而不是静默丢帧或驱逐仍可寻址的 ID。Worker 发布不可变资源定义，物理指针与 075 marker 共用热点和动画表示，并处理实际游戏/视频背景上的掩码合成。异步加载需要原 Layer 与 Session 存活检查；Stop 必须释放缓存、UI 引用、URL、动画回调和图标。

Windows 的图像选择、旧格式变体和畸形 ANI 接受范围由 OS 加载器决定，后续可在 GitHub-hosted Windows 上用同一 API 建立明确 fixture 证据；这仍不等于执行了固定原版引擎。当前已有图片首帧解码能力不能替代以上验收。

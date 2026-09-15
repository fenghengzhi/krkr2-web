# 063：窗口按键拦截与图层注视位置

本切片补上 `Layer.setAttentionPos`、使 `useAttention` 的父链选择生效，并让 `Window.trapKey` 真正把游戏按键交给其它页面内 Window。焦点仍留在用户实际操作的窗口；普通宿主输入框、系统／字体对话框和剪贴板控件继续处理自己的编辑操作。

当前实现尚未通过完整回归。与 062 整合的首轮 [35013970344](https://github.com/fenghengzhi/krkr2-web/actions/runs/35013970344) 在 `8cf6ae9bb1b1b26a0d96cf53ba51f65f4fcf6c2f` 完成 native 内核构建后，于 Web Crypto 适配器类型检查报 TS2345；Node／浏览器／直接运行时用例实际执行数均为 **0**。后续将 UUID 自有缓冲区的类型明确为 `Uint8Array<ArrayBuffer>`，不改随机源或输入行为。没有运行本地测试、构建、类型检查或浏览器探针，原始失败继续保留。

## 原版依据

固定官方源码为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/`。完整只读审计及 12 份原始源码的 SHA-256 保存于工作区 `out/verification/window-attention/contract.md` 与 `reference/SHA256SUMS`；该目录是验证归档，不是分发依赖。

- [Layer 方法和属性](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7959)：脚本方法叫 `setAttentionPos(left, top)`，内部 C++ 方法才叫 SetAttentionPoint。至少两参，转换成 tjs_int 后一次写入，不开启 useAttention，返回 void。
- [LayerManager](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp#L821)：从焦点向祖先找第一个 useAttention；没有则禁用。原版只在真正焦点切换或当前焦点自己的 attention setter 时重新采样，祖先属性变动不立即刷新。
- [WindowForm 的拦截](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1108)：按创建顺序倒序选择可见 trapper，不要求 focusable，也不激活它。普通 keyDown 先开启接收；首次孤立 keyUp 被吞掉但随后开启；字符及系统键消息不能自行开启。每次赋 true 都重置门控，不改变优先顺序。
- [Window.postInputEvent](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp#L1324)：显式调用绕过消息拦截，继续直达指定 Window。

这些是固定源码事实；本切片没有执行原版 HWND／IMM 观察。

## 图层与字体采样

Layer attention 坐标使用 TJS int32 转换，负数及图层外坐标允许；没有 MainImage 也可设置。`setAttentionPos` 在两参数转换完成前不修改状态。`useAttention` 使用 TJS bool 转换，包括非零小数。

InputController 保存 nullable 的 primary 坐标采样。位置来自最近启用的焦点或祖先，累加到 Primary 为止，不加 Primary 自己的偏移，不读取 imageLeft/top 或 clip。`view()` 只投影已有采样；移动祖先、改变祖先 attention 或仅刷新画面不会偷偷重新寻找节点。设置当前焦点的相同 attention 值仍会重新采样。无焦点、manager 更换、对象失效会清理不可用结果。

字体始终来自焦点 Layer，即使坐标来自祖先；采样时无 MainImage 使用宿主默认字体。释放、重建或 resize MainImage 本身不会刷新之前复制的字体，下一次规定的 attention 刷新才重新决定。正常 Font 属性 setter 和 `doUserSelect` 将描述复制到 Layer 的纯值镜像，实际 attention 刷新时再采样；字体 setter 本身不会重算注视点。镜像和输入快照不保留 Layer、Font、actionOwner 的额外 TJS 强引用。内部 `__fontData` 是实现细节，直接修改它不会绕过正常 Font setter 自动更新该镜像。

## Web 输入与坐标选择

注视点使用页面中实际绘制图层的坐标：采样 primary 点乘 Window zoom，加内部 layerLeft/top，再按 canvas CSS 尺寸投影到私有 textarea。Window 的页面 left/top 由 DOM 容器承担，不能重复加入。null 恢复该 surface 默认锚点，并清除旧字体样式；它不禁用字符输入，也不删除 textarea。字体描述只作为 CSS 编辑承接点样式，异常或过大的 CSS 字号回到默认值，不能因此使原本可赋值的 Font 属性报错。

这个选择与固定原版的整数 DrawDevice 缩放以及未叠加 PaintBox.Left/Top 的 attention 路径不同。它是明确的 Web 显示映射，不宣称逐像素复刻原生候选窗口。`inputMode="none"`／`"text"` 仅提供输入方式提示，不能控制用户 OS IME 开关或语言模式。

每个真实来源 Window 的 InputView 附带 `keyboardRoute`，包含逻辑接收 Window、焦点、IME 提示和单调 revision。接收窗口变化、真实 Layer 焦点变化、窗口路由状态变化、manager/模态输入代际变化会使旧编辑路由失效。浏览器在 DOM 观察时给 key/text 包标记 revision；Session 在观察共享物理键之后拒绝过期逻辑输入，避免首个被吞的 keyUp 或迟到包导致卡键。

Session 只对来自游戏输入入口的 keyDown/keyUp/text 选择 trapper，目标在接纳时固定。排队期间改 trapKey 不把该事件转投另一个窗口。来源与接收者都有独立 Window/controller 身份和代际检查；跨窗回调期间来源被清理，也不能继续投递旧 Layer 尾事件。实际 Window→Layer 分派继续使用已有 InputController，显式 postInput、指针、滚轮和触摸不进入拦截。

被页面模态阻塞的 Window 不作为可接收 trapper；这是 Web 模态所有权政策，原版 FindKeyTrapper 本身没有对应的 Enabled 检查。DOM 在游戏之外的输入／textarea／contenteditable 上产生的编辑不会送入这个入口。BrowserInput 还验证真实 activeElement 属于自己的 canvas 或私有 textarea，不能仅凭一个尚未刷新的“活动窗口”字段接受宿主剪贴板操作之后的迟到文本。

DOM 的 `altKey`、VK_MENU 和 F10 被标记为 systemKey，其它按普通键处理。这是浏览器可观察信息的映射，不能覆盖所有 Windows WM_SYSKEY 情况。来源本身是最新 trapper 时也经过门控；暂时隐藏再显示不会自动重置，重新赋 true 会重置。

不把键消息的 shift 复制成接收窗口的鼠标重检查状态。定向核对发现原版 key 只传递 shift 实参，ForceMouseRecheck 使用旧鼠标坐标与 flags=0，几何变化自身不强制产生 onMouseMove。现有 Web 几何重检查机制的差异单独保留，不在 trapKey 切片中以未经证实的 Ctrl/Alt 预期改变它。

## 合成文本和真实焦点

跨窗 trap 使用真实来源 Window 的 textarea，不把 focusable=false 接收窗口激活或聚焦。跨窗使用来源的默认锚点，仅借用接收者 IME 提示；同窗使用已有 attention 采样。Web 统一键接收者与 IME 逻辑来源，这与原版 GetKeyTrapperWindow 排除自身的特殊分支不同，避免两个 trapper 同时存在时键与编辑状态来自不同窗口。

路由或焦点身份变化会取消旧逻辑合成，拒绝迟到 compositionend/重复 input；普通 resize、attention 投影和字体样式刷新不开始新的编辑事务。提交仍保留 UTF-16 内容，不以 Enter 或 keyCode 229 单独推断合成结束。构造 CompositionEvent 的测试只能验证 DOM 事件生命周期，不能证明真实系统输入法或候选框行为。

## 验收与边界

新增实际 TJS source/bytecode 用例覆盖方法参数、父链与刷新时机、字体来源、生命周期、trap 创建顺序、门控、直投对照、回调和排队固定接收者、共享物理状态。浏览器用真实点击和键盘操作验证焦点／键路由与宿主编辑隔离，另对 nullable attention、坐标和构造合成事件做明确的 DOM 验收；三浏览器及 Asyncify/JSPI 执行由 GitHub-hosted Actions 完成。

当前新增定义数为 Node 86（attention 32、trapKey 42、浏览器协调器 12），浏览器规格 28（trapKey 16、attention 12；三浏览器展开为 84）。现有 multiwindow-ime 仅修正显式 useAttention 夹具，原用例数不变。这些是静态定义数，首次 Actions 的实际执行数、失败或未执行项须另行记录。

与 062 System 配置整合后的会话协议统一为 **16**，native kernel ABI 保持 5；System 的新 native 能力另由 manifest 标记校验。此阶段不包含窗口形状、全屏、键盘模拟鼠标、系统指针移动、完整 OS IME 或插件支持。

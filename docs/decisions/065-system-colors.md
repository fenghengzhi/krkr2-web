# 065：System.toActualColor 与 Web 系统色

本阶段补上真正的原生静态 `System.toActualColor`，恢复系统色常量的编号，并让 System 与原版指定的 Layer 入口共享同一个 session 调色板。默认颜色来自实际页面的 CSS 系统色；无 DOM 的 engine 使用明确的 Web 静态表。它们都不冒充 Win32 `GetSysColor` 或 Windows 桌面主题。

状态：实现和测试定义已编写，**当前 Web 候选尚未通过验证**；首次整合构建失败的结果见下。所有可执行验证只在 GitHub-hosted Actions 进行，本地没有执行测试、构建、类型检查、浏览器、VM 或原版 SDK。下面的原版参考运行已经实际完成，但不能代替 Web 候选的测试结果。

与 063／064 整合的首次 [完整回归 36442487130](https://github.com/fenghengzhi/krkr2-web/actions/runs/36442487130) 在 `991c4072e09fd477a844e1a645ce7e017db91705` 完成原生内核编译后，因 `system-colors.test.ts` 的负向测试把故意不完整的依赖对象直接断言为 `SessionDependencies` 而报 TS2352。Node、浏览器和直接运行时实际执行数均为 **0**，不能记为任何功能通过。后续只把这个刻意缺少后端的负向夹具显式经过 `unknown` 转换，保留“无效调色板必须在访问后端前拒绝”的断言；未放宽生产类型。原始构建失败和日志保留，待修正后的整批运行。

第二次组合运行 [36443186745](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443186745) 的 Firefox PWA 原始 `out/ci/results.json` 明确记录 `Browser system color is not opaque: Highlight`，多个游戏因而在建立 Player 时无法启动。初版错误要求每个原始采样的 alpha 都为255；修订改用下述明确的24位合成政策。该轮未记录具体 CSS 字符串/RGBA，不能据此报告某个精确透明度。历史失败及完整原始产物保留，**本修订尚未运行，不能声称已经恢复通过**。

第二次整合 [36443186745](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443186745) 的构建成功，实际 Node 为 **2,172 通过、2 失败**，直接运行时 **6/6** 通过；浏览器暴露了上述共同初始化问题。为避免继续重复该错误，剩余普通浏览器作业被取消，保留全部已完成与部分报告，不能把此轮计为完整回归成功。复用同一构建的 [兼容检查 36443590538](https://github.com/fenghengzhi/krkr2-web/actions/runs/36443590538) 在取消请求前已经自行失败：原 78 项中 **24 失败、54 未执行、0 通过**，24 项均独立记录相同 Highlight 错误；15 项旧 PWA 的旧版在线／离线启动已完成，失败发生于当前版本启动。后续半透明颜色修复和输入夹具修正尚待与下一批功能一起验证，不覆盖这些历史结果。

## 原版证据与解释边界

固定源码是 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable：

- [SystemIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/SystemIntf.cpp)：原生静态方法、至少1参数及未使用结果时跳过转换。
- [LayerImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerImpl.cpp)：最高字节为零时直接返回 RGB；任意非零最高字节调用 VCL，再由 BGR 换成 RGB。
- [LayerIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp) 与 [ScriptMgnIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/ScriptMgnIntf.cpp)：具体调用点、ARGB/字节数据边界与25个公开常量。

原版参考 [35017080903](https://github.com/fenghengzhi/krkr2-web/actions/runs/35017080903)，提交 `3bf56af4f340bcf7d0240963a86bbe3cf46adea6`，在 GitHub-hosted Windows 2022/2025 各完成97项真实源码记录：93返回、4个预定捕获的调用错误，退出0，无超时、缺失、重复、解析或全局错误。原 SDK 固定 engine SHA-256 为 `b1e9b84905f29489d2a9caba0c45e125c971b19f71156b0cf3f506835c18e19d`，版本 `2.32.2.426`；没有据此假定其准确源码/VCL revision。

原始 UTF-16 事件、25项独立 GetSysColor 采样、结构化结果、两份 ZIP、GitHub 元数据与 hash 保存在主归档 `out/verification/github-actions/35017080903/`。五份源码和六份参考输入也按原字节保留。该运行是原 SDK **source** 观测，不是原 SDK bytecode 或 Web 测试。

结果支持以下实现规则：

| 输入的低32位          | Web 解释                     | 原版实际支撑                                                             |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| 最高字节为0           | 原样 `0xRRGGBB`              | 8个普通RGB样本                                                           |
| 最高字节非0，bit31为0 | 丢高字节，把低24位BGR换成RGB | 01/02/03/04/7f + `010203` 均返回 `030201`                                |
| bit31为1              | 低8位作为系统色索引          | 81/ff/c0及80000105/80010005/80800005均别名到index5；80000100别名到index0 |
| index25或31..255      | 返回0                        | 25/31/255实际返回0；其余保留索引按公开Win32索引范围之外的Web兼容政策处理 |

这是固定源码边界、有限实测和公开索引规则支持的兼容实现，不是遍历全部32位输入的证明。14个大整数/有符号样本实际证明必须先保留 TJS int64 的低32位，再转 JS Number；`9007199254740993` 返回1。图像专用标记传给本方法时仍走上述数值规则，不能当 `loadImages` 指令解释。

25个公开常量与各自 runner 独立 GetSysColor 全部吻合，但 `clHighlight` 在 Windows 2022 为 `0x0078d7`、Windows 2025 为 `0x0078d4`。因此没有把任何一份 Windows 调色板硬编码为普适答案。index26实际返回 `0x0066cc`，index30返回 `0xf0f0f0`，证明“大于24都变黑”不成立；它们不在此次独立0..24采样中，不能声称另有独立 Win32 等值核验。26..30的角色由 [GetSysColor 公开索引](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsyscolor)确定。

## 调色板、页面与嵌入 API

`PlayerOptions.systemColors?: readonly number[]` 可以传入31项 `0xRRGGBB` 数组，对应index0..30，index25必须为0。长度不符、空位、非整数、负数、超过24位或非零index25立即拒绝。`createPlayer` 只读取该选项一次，在建立 MessageChannel、媒体host和Worker之前验证并复制；Worker `createSession` 在构造任何port/surface之前再验证。EngineSession 保存独立只读快照，不持有调用者可修改的数组。不同player/session互不影响。

未传配置时，`createPlayer` 在实际canvas的 `ownerDocument` 中读取其 computed `color-scheme`，临时不可见元素逐个求 CSS 系统色的computed值，再用同document的1×1 canvas转换为RGB。采样元素禁用页面的transition/animation；每个不同关键字只采一次，临时DOM随后移除。生成的31项快照经 SessionClient/InitializeRequest 传入worker；之后页面颜色方案变化不会重算该session。页面支持不足时会报告错误，不把一次失败采样悄悄换成 Windows 色表。

CSS 系统色可以含 alpha，24位调色板使用明确的 Web 合成政策：首先用原生 Canvas2D `source-over` 把实际 CSS `Canvas` 叠在固定白色 `#ffffff` 上，取得不透明 RGB 底色；`Canvas` 对应条目直接使用该结果。其余角色分别在这个 RGB 底色上合成一次，保留透明与半透明输入的视觉贡献。白色只为透明 `Canvas` 提供固定 Web 底色，不代表 Windows 色表或页面实际背景。合成继续使用浏览器默认 sRGB Canvas 的实际栅格化和8位输出，不先丢弃 alpha，也不先把原始RGBA读回再重建透明颜色，以避免额外的预乘/反预乘精度损失。

依据 [CSS Color 4 §15.5](https://www.w3.org/TR/2026/CRD-css-color-4-20260926/#resolving-other-colors)，系统色的 computed/used 值包含颜色及 alpha；[HTML Canvas 合成](https://html.spec.whatwg.org/multipage/canvas.html#compositing) 默认 `source-over`，其 [Porter-Duff 公式](https://www.w3.org/TR/compositing-1/#porterduffcompositingoperators_src_over) 保留背景贡献。这里选择 `Canvas` 与最终白底属于本项目的24位兼容政策，不是这些规范指定的 KRKR/Windows 主题行为。

| 索引                     | CSS 关键字     |
| ------------------------ | -------------- |
| 0、1、2、3、4、5、12、24 | Canvas         |
| 6、10、11、21、22        | ButtonBorder   |
| 7、8、9、23              | CanvasText     |
| 13                       | Highlight      |
| 14                       | HighlightText  |
| 15、16、20               | ButtonFace     |
| 17、19                   | GrayText       |
| 18                       | ButtonText     |
| 25                       | 保留0，不采CSS |
| 26                       | LinkText       |
| 27、28、30               | Canvas         |
| 29                       | Highlight      |

前25项按 [CSS Color 4 系统色及旧色角色映射](https://www.w3.org/TR/2026/CRD-css-color-4-20260913/#css-system-colors)收敛；26..30依公开Win32角色选择对应的Web颜色政策。多个旧角色允许共用一个CSS值，浏览器也可以提供固定系统色值，不能把同名当作Windows主题等价。

无DOM EngineSession/独立LayerTree的默认表使用固定Web角色值：Canvas=`ffffff`、CanvasText/ButtonText=`000000`、ButtonBorder=`767676`、ButtonFace=`f0f0f0`、Highlight=`3399ff`、HighlightText=`ffffff`、GrayText=`787878`、LinkText=`0000ee`。该fallback用于没有页面的环境，浏览器默认路径实际采CSS；测试可以显式注入不对称RGB，以暴露R/B或索引错误。

## 原生方法与常量

新增方法沿用 System native static member，固定policy为 `1 | 0x100`：至少1参数；参数不足时即使结果未使用也报错；结果未使用时跳过TJS `int(color)` 和host调用，但实参表达式仍先求值。使用结果时由真实TJS转换为整数，host在BigInt中先截低32位，再解释颜色。

原版已经实际确认：octet/object有结果调用抛转换错误，无结果调用不转换；extra实参被求值但不被本方法转换。借用普通receiver和保存为 `incontextof null` 的方法都能正常返回 `0x123456`。实现沿用现有TJS闭包绑定与native入口，不增加“必须是System实例”的限制。

TS描述表与native固定表都追加第14个方法，runtime描述容量由13改14。实际内核构建manifest将 `nativeSystem` 从1升2，原有ABI5不变，因为窄绑定export形状没有变化。生产loader要求 `nativeReleaseState:1`、`nativeClipboard:1`、`nativeSystem:2`；缺失或仅支持13方法的cap1都在导入内核前拒绝。新palette进入Worker初始化协议，协议16升17，防止旧Worker静默忽略颜色快照。产物hash、缓存key与PWA buildId仍由现行构建计算，不手工伪造版本。

`clHighlight`、`clBtnFace`、`clBtnShadow`、`clBtnText` 从以前的固定RGB恢复为原版 `0x8000000d/0f/10/12`。其余公开系统色保持原编号。固定默认颜色放入Web调色板，不能替代脚本常量的整数身份。

## Layer 调用边界

System和LayerTree共享同一 `SystemColors` 对象，只有以下标量入口解析：

| 入口                                                 | 解析行为                                           |
| ---------------------------------------------------- | -------------------------------------------------- |
| setMainPixel                                         | 主图存在且坐标通过clip后解析；只替换RGB，保留alpha |
| fillRect / dfOpaque且holdAlpha                       | 解析完整颜色值，保留目的alpha                      |
| fillRect / dfAlpha、dfAddAlpha、dfOpaque且!holdAlpha | 原始ARGB，不解释系统色                             |
| colorRect / dfAlpha                                  | 仅正opacity解析；零不改像素，负值只降低alpha       |
| colorRect / dfAddAlpha                               | 非负opacity解析；负值继续由原face合同拒绝          |
| colorRect / dfOpaque                                 | 解析完整颜色值，再走原混色路径                     |
| drawText                                             | 仅前景解析；shadowColor继续原始RGB路径             |

原版实测 `fillRect(...,clWindow)` 在dfAlpha/dfAddAlpha/dfOpaque&&!holdAlpha写RGB=5、alpha=128；dfOpaque&&holdAlpha写真实窗口色并保留alpha87。setMainPixel的01高字节值实际写 `030201` 并保留alpha87。mask与province仅取低8位；neutralColor及所有已经形成的图像像素仍是原始ARGB/RGB，不能再解释为系统色。

本切片不改变图像加载key；该合同由独立064处理。也不改变旧的空区域colorRect错误/touch、文字opacity=0提前返回和实际字体加载顺序。调色板读取是同步、无副作用的快照；新增resolver在空裁剪colorRect不运行。原版已观测的dfMask/colorRect布尔化为1属于既有独立差异，本阶段没有借系统色实现修改它，也没有删改其历史证据。

## 待执行验收定义

Node使用真实WASM/EngineSession，分别运行source与 `Scripts.compileStorage` 产出的真实bytecode；共用fixture以原版观测分类给出预期，不调用生产resolver生成“答案”。覆盖大整数窄化、全部公开常量、完整低8索引空间、四种入口使用方式、borrowed/null-bound、实参求值计数、Layer主图/ARGB/字节数据、只读快照与不同session隔离。旧System类/UUID/路径等测试只更新第14方法和能力版本的必要条件，原有断言意图保留。

浏览器定义覆盖实际应用CSS默认路径与单独Vite编译的真实public createPlayer/Worker嵌入入口、31项注入、修改原数组和多player隔离、页面color-scheme变化后快照不变，以及真实字体的前景/阴影颜色分界。独立期望采样器记录实际 computed CSS、透明画布上的原始RGBA、合成后的RGB与Canvas底色。另一组明确标注的四项CSS输入覆盖半透明角色、半透明Canvas及角色、全透明Canvas及角色、透明角色；这些使用真实样式解析和Canvas2D，却不是原生系统色观测，也不改写Worker/System返回值。原有双调色板注入和修改调用者数组仍严格核对session隔离。source/bytecode和现有运行后端分别执行；生产loader测试保留nativeClipboard要求，新增旧nativeSystem=1拒绝，并用完整cap2内核恢复后真实调用toActualColor。

修订后的定义等待GitHub-hosted Actions；本阶段未在本机执行。后续报告必须保留实际浏览器、case数量、source/bytecode、跳过、不支持、失败和完整日志。原版97×2记录、此前阶段测试、静态源码检查及此次组合运行中的其他通过项都不能替代本修订候选PASS。

## 36455312915 WebKit 启动失败与恢复边界

[完整回归 36455312915](https://github.com/fenghengzhi/krkr2-web/actions/runs/36455312915) 中，WebKit 的 `input/asyncify` 和 `pad/jspi/source` 两例在应用启动时记录 `Unable to get image data from canvas. Requested size was 1 x 1`，随后应用日志为 `The object is in an invalid state.`。这不是 TJS 输入或 Pad 脚本已经运行后的错误。原始 trace 的零基 `lineNumber:3,columnNumber:99311` 与该轮实际构建 `dist/assets/index-q3-oFTje.js`（SHA256 `9efeed39e38707ea0c939976efbe5f566d6de57a2ae7af3f32e263ef619cd560`）中的系统色 `getImageData(0,0,1,1)` 调用匹配；各例网络记录只有应用、样式、manifest 和 library Worker，没有 Session Worker。此同步采样早于音频通道与 SessionClient，因此与本轮另行修正的 Wave filter helper 名称解析无关。

同一页面显示的浏览器存储 `unknown transient reason` 来自 OPFS 目录初始化；不能据此断言 IndexedDB、内存不足或画布异常具有共同根因。现有证据也没有原始抛出异常的 name/stack，应用仅记录 message。上面两个消息可以来自同一次原生 readback 失败，不代表已观察到第二个清理异常。原始失败继续保留，画布 readback 的底层原因未得到证明。

静态审查另发现确定的恢复缺口：此前 App 在 `busy=true` 后先创建 Window/Pad 页面 host，再同步调用 `createPlayer`，但 `try/catch/finally` 只覆盖后续异步 `load`。采样失败会绕过 busy 复位与页面 host 清理。修订将这整个启动阶段纳入同一个保护范围：尚未返回 Player 时分别清理已经建立的 Pad、Window host 和未附加的初始 canvas；已返回 Player 时沿用现有 `stop`、`session.isDisposed` 与 generation 检查。原错误与独立清理错误分别进入日志。系统色临时采样 canvas 在成功和失败出口都明确归零释放 backing store，并保留原有临时 probe 清理、CSS alpha 合成、原始异常传播；没有默认色降级或自动重试，不能宣称这已解决 WebKit 的底层 readback 故障。

在现有 `player.spec.ts` 新增每后端一例、三个浏览器共六个待执行定义：只在明确的 1×1 系统色 `getImageData` 入口注入一次 `InvalidStateError`，保存临时 canvas/probe 引用，要求原错误可见、画布归零、probe 与部分游戏 DOM 清理、操作控件恢复且尚无 Session Worker；撤销 API 注入后，通过真实“重新开始”按钮使用同一脚本建立新的实际 Worker/VM，检查脚本日志和 Layer 像素，再停止并观察 Worker 关闭。故障注入只验证恢复合同，不冒充自然发生的 WebKit 故障复现。新增定义尚未执行，只允许后续 GitHub-hosted Actions 结果作为验证。

# 插件以外的实现进度

最新 [执行资源完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858757086) 通过 **398 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34859159783) 另通过 **78 项**。已限制执行深度和临时寄存器/参数载荷，修复退出帧残留值、部分原生类/Array 构造回滚；暂停/取消覆盖实际参数复制及深层宿主挂起。双后端 [1,063 次执行分配失败与 188 次字节码分配失败](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858195933) 全部通过。TJS ABI 5 增加 `executionBudgets: 1`，字体 ABI 2、协议 9 不变。范围见 [决策 037](decisions/037-execution-budgets.md)，完整非插件目标仍在进行。

此前 [字节码生命周期完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34849454871) 通过 **392 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34848253401) 另通过 **78 项**。常量池、上下文构造和链接支持暂停/取消、失败回滚和构造预算；六组生命周期检查及 36 条控制路径验证了显式实例清理后的资源释放。两种后端共 **188 次分配失败**和 **20 次 WebKit 冷离线重启**通过。TJS ABI 5 新增能力标记 `bytecodeLifecycle: 1`，详见 [决策 036](decisions/036-bytecode-lifetime.md)。

[最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34850540242)已绑定 554 份证据；矩阵 `out/verification/bytecode-lifetime-matrix.json` 的 SHA-256 为 `c3c5c665b1de52cc989edc0a3abad39001c0db1fc560baa49b1dfe63f798089b`。本轮可信冻结为 21,059.7 ms，没有计入历史额外冻结；此前各阶段矩阵和失败记录继续保留。

深层调用/try 栈预算及临时实例退出寄存器后的释放已由 [决策 037](decisions/037-execution-budgets.md) 接续。任意对象环回收、隐式终结器异常、其他原生分配/宿主对象路径和下表非插件条目仍未完成。历史 WebKit JSPI 页面崩溃在此前 20 次独立重启中未复现，原 KAG 异常成员名称也仍无确定根因；原始失败持续保留，目标保持进行中。

此前二进制脚本阶段的 [GitHub Actions 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34841387392)通过 **384 项 Node、639 项浏览器测试及 6 项直接运行时专项**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34840621607)另通过 **78 项**原 KAG 和跨 ABI 离线升级。新增 KBAD 资源、二进制文件偏移、字节码结构检查和反序列化暂停/取消；菜单更新保留节点，视频等待首帧并通过媒体时钟补充区间事件。TJS ABI **5**，能力标记为 `cooperativeCompilation: 1`、`binaryScripts: 1`；字体 ABI **2**、会话协议 **9**。范围与失败历史见 [二进制脚本](decisions/034-binary-scripts.md)及 [视频首帧](decisions/035-video-readiness.md)。

该阶段的 [最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34842156097)已通过，矩阵为 `out/verification/binary-scripts-matrix.json`，SHA-256 为 `b941be09c8d5803d19a8c1014fad9b8dfa1a78351a17734808133117cd1c3041`。报告绑定 496 份证据、12 条二进制控制路径、36 条编译控制路径、24 条页面控制检查和 6 份视频呈现/像素附件；可信冻结为 21,052.3 ms。此前矩阵和本轮所有失败继续保留。

一次 WebKit JSPI 原 KAG 启动出现异常成员名称，随后关闭/开启脚本调用栈各 20 次独立诊断均未复现；原失败仍保留，未宣称根因已解决。该二进制脚本阶段尚未覆盖构造失败所有权和原生分配统计；后续字节码生命周期阶段接续这些工作。深层调用/try 栈预算和其他非插件条目仍未完成。所有执行都在 GitHub 托管 runner 上进行。

此前长脚本编译阶段的 [完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829312486)通过 **371 项 Node、621 项浏览器测试及 6 项直接运行时专项**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34829383281)另通过 **78 项**。源码准备、解析/代码生成和导出共有三浏览器双后端 36 条暂停/取消控制路径，详情见 [长脚本编译](decisions/033-cooperative-compilation.md)。

此前的 [原生 Scripts 报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34825096969)继续保留在 `out/verification/native-scripts-matrix.json`，绑定 495 份证据，SHA-256 为 `1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d`。编译控制和二进制脚本各用独立矩阵，不覆盖历史记录。

编译阶段的 [最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34830361115)保留为 `out/verification/compiler-matrix.json`，SHA-256 为 `bd314e7bf7383553468685c6cea0db2d53998f265dd09b882d09733cdc7c55b9`。其中包含 495 份证据、36 条编译控制路径和 6 份视频呈现/像素附件；可信冻结为 21,053.2 ms。二进制资源与结构检查由新阶段接续，完整 VM 审计仍未完成，原生分配统计由后续字节码生命周期阶段接续。

上一轮完成的 [GitHub Actions 回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815634377)通过 **351 项 Node、609 项浏览器测试及 6 项直接运行时专项**，所选用例无失败、跳过或 flaky，未使用测试重试。[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814325349)另通过 72 项原 KAG 与跨 ABI 离线升级，输入时序另有 30 次三浏览器双后端复测通过。完整非插件目标仍未完成。

原生 `Scripts.getTraceString(limit=0)` 与“脚本调试”启动开关已接入，该已验证阶段 TJS ABI **4**、字体 ABI **2**、会话协议 **9**。调用栈在异步挂起、嵌套回调、字节码和取消时保留已验证的位置与顺序；其他 TVP 桥帧、原生错误界面和隐式回收路径仍需继续对齐。设计和失败分析见 [脚本调用栈](decisions/031-script-stack-traces.md)。[最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34816691294)保存为 `out/verification/stack-traces-matrix.json`，绑定 503 份证据，SHA-256 为 `9babc637693f500efb1a04399f246f037ee5f32ba16090d78d2ab6113ec0a9df`。

目标：完成架构规划中的非插件引擎与 Web 平台能力，不能以最小示例或部分测试通过替代完成。插件注册机制保留；原生 DLL、Emote/MotionPlayer 等插件实现不在当前目标内。

本文件记录完整范围和证据缺口。此前的首个实现属于实际进展，但远未证明当前目标完成。

VM 控制台阶段的 [最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812958010)已通过，标准矩阵为 `out/verification/vm-console-matrix.json`，绑定完整回归、66 项兼容性、3 次可信长冻结与 487 份证据。报告 SHA-256 为 `81beb0d8763cfc667c01b6e799d561ab80db8fb9944cba4c1e40408a9f18059d`；详细归档与执行方式见 [测试说明](testing.md)。

VM 控制台阶段已补原生 Console/Controller 类、编译警告与诊断回调、可挂起的 compile 和独立 Scripts.dump 文件。38 项 Node 专项、36 项浏览器面板/VM 检查、6 项直接运行时探测和 6 项冷离线检查通过；本地完整回归已按用户要求中止，后续验证改由 GitHub Actions 执行；新的完整回归已在 GitHub Actions 通过；另有 [GitHub Actions 兼容性运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812505215)通过全部 66 项原 KAG、菜单、异常恢复与 TJS/字体跨 ABI 离线升级检查。TJS ABI 升到 3，字体 ABI 2、会话协议 9 不变。范围见 [VM 控制台](decisions/029-vm-console.md)。

调试面板阶段已接通 Console/Controller 的只读对象、独立显示状态、暂停/失败中的页面操作和焦点恢复。新增 3 项 Node 和 18 项浏览器测试；完整 `npm run check` 通过 **331 项行为/集成与 579 项浏览器测试**（462 常规、57 游戏库、53 PWA、7 原生生命周期），无失败或跳过，原生 trusted 冻结为 **21,055.2 ms**。原 KAG 菜单/快捷键 6 项、综合场景 36 项，以及 TJS ABI、字体 ABI、协议 8→9 各 6 项离线升级检查通过。权威日志为 `out/verification/debug-panels/check.log`，最终证据见 `out/verification/debug-panels-matrix.json`。会话协议为 9，TJS/字体 ABI 均保持 2。范围见 [调试面板](decisions/028-debug-panels.md)。

Debug 日志阶段已接通历史/重要消息、文件输出开关、绑定闭包观察回调、主要异常保留和日志/游戏提交隔离。完整 `npm run check` 通过 **328 项行为/集成与 561 项浏览器测试**（444 常规、57 游戏库、53 PWA、7 原生生命周期），无失败、跳过或 flaky。另有 **96 组原 KRKR2 日志参考、36 项原 KAG 场景、6 项 KAG 异常日志与恢复、6 项 TJS 跨 ABI 和 6 项字体跨 ABI 离线升级检查**通过。范围见 [Debug 日志](decisions/027-debug-logging.md)。

Debug 阶段完整日志为 `out/verification/debug/check.log`，最终证据由 `out/verification/debug-matrix.json` 绑定并再次校验。原生 trusted 冻结实测 **21,054.8 ms**，110 份持久 context 记录保留独立的 30 秒准备/清理与 30 秒正文预算。TJS/字体 WASM ABI 均为 2、会话协议为 8，本阶段保持不变。主机重启前一次 WebKit 视频暂停位置异常未复现，原因仍未确认；失败、严格复测与媒体时钟记录全部保留，不能将它标记为已修复。

纵排阶段已补 Unicode 17 BMP 朝向、vert/vrt2 字形选择、呈现形式回退、文件字形变换、竖向装饰线及没有竖排度量表时的游戏家族路径。原 KAG 负责 ruby、纵中横和禁则，无需替换其排版脚本。完整 `npm run check` 通过 **308 项行为/集成与 537 项浏览器测试**（426 常规、57 游戏库、47 PWA、7 原生生命周期），所选案例无失败或跳过。最终构建另通过 **36 项原 KAG 场景、18 项文字排版场景、6 项 TJS 跨 ABI 与 6 项字体跨 ABI 离线升级检查**。实现边界见 [纵排文字](decisions/026-vertical-text.md)。

纵排阶段修复了升级后旧字体发布资源的离线查找，保留了修复前的失败日志和浏览器 trace。该阶段原生 trusted 冻结间隔为 **21,054.1 ms**。历史完整日志为 `out/verification/text-layout/check.log`；源码、测试、发布文件、原生参考与外部场景由 `out/verification/text-layout-matrix.json` 绑定。字体 ABI 为 2，TJS ABI 2、会话协议 8 保持不变。

字体选择阶段已加入 getList 筛选、游戏家族/样式绑定、HTML 选择与真实字形预览、点击触发的本机字体读取、取消/停止和过期结果隔离。完整 `npm run check` 通过 **301 项行为/集成与 522 项浏览器测试**（417 常规、57 游戏库、41 PWA、7 原生生命周期），所选案例无失败或跳过。新增 11 项 Node、27 项浏览器测试和 256 组原生筛选参考，6 个既有字体离线冷启动案例也验证了选择器。真实 Chromium API 另在隔离测试 context 中完成枚举、预览与选择。会话协议为 8，TJS/字体 WASM ABI 保持 2/1。设计与剩余范围见 [字体选择](decisions/025-font-selection.md)。

字体选择阶段构建另通过 **36 个外部 KAG 场景和 6 个跨 ABI 离线更新场景**。该阶段原生冻结间隔为 21,053.9 ms，事件均为 trusted。历史完整日志为 `out/verification/font-selection/check.log`；源码、配置、发布文件、原生参考与独立探测由 `out/verification/font-selection-matrix.json` 绑定。前一字体几何阶段的统计与矩阵在下文作为历史记录保留。

字体几何阶段已加入 Rect、getGlyphDrawRect 和独立 FreeType 文件字体后端。337 对矩形、25,200 组坐标和 512 组原生字形对照通过；缺字回退、损坏字体恢复、内存增长后的数据所有权、取消与释放均有检查。设计与边界见 [字体几何与后端](decisions/024-font-geometry.md)。

字体几何阶段完整 `npm run check` 通过 **290 项行为/集成和 495 项浏览器测试**（390 常规、57 游戏库、41 PWA、7 原生生命周期），包含 6 个字体离线冷启动案例。长冻结测试的准备阶段有独立的 30 秒 fixture 预算，正文仍为 30 秒，实际冻结仍须超过 21 秒。此前的 WebKit 停滞、主机重启中断和冻结测试失败分别保留证据；完整检查日志为 `out/verification/font-geometry/check.log`，外部场景与最终矩阵另行记录。完整非插件目标仍在进行。

字体几何阶段最终构建另通过 **36 个 KAG 场景、6 个跨 ABI 离线更新场景和 6 个实际字体画布组合**。该阶段原生冻结记录为 21,053.1 ms，事件均为 trusted。源码、测试、构建、字体/TJS WASM 与全部证据由 `out/verification/font-geometry-matrix.json` 绑定；历史失败与中断日志一并保留。

| 要求                                                                | 当前证据/下一步                                                                                                                                                                                                                                                                        | 状态   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TJS2 源码/字节码、值桥、回调、异步、调度、生命周期                  | 已有真实 WASM、长编译控制、KBAD/偏移、字节码结构校验、构造/链接回滚、执行深度/临时载荷预算及分配账本；继续任意对象环、隐式终结器异常与宿主对象回收，并追踪历史 WebKit 页面崩溃和原 KAG 成员名称错误                                                                                    | 进行中 |
| 文件集合、XP3/ZIP、文本编码、资源查找、补丁/auto-path               | 已修正 adlr/保护位解释，补限定归档路径、auto-path、文本编码与文件流；ZIP stored/deflate、ZIP64、Unicode、CRC 与 HTTP Range 已接入；嵌套包、其他归档变体及完整路径规则仍未完成                                                                                                          | 进行中 |
| KAGParser：标签、宏、条件、调用栈、保存恢复、宿主回调               | 已实现 TS parser + TJS 回调桥，通过原有 Conductor 的宏/等待/异步/call/return；继续扩大边界差分与完整 KAG 流程验证                                                                                                                                                                      | 进行中 |
| Timer/AsyncTrigger/事件、Window、完整输入与系统 API                 | 已补窗口、焦点/模态、鼠标/触摸捕获、脚本命中、键盘/提交文字和异步输入；已接入 System 事件/连续回调、异常处理与菜单门控；手势/完整 IME、多窗口、原生全屏和全部原生事件重入仍需补齐                                                                                                      | 未完成 |
| Debug 历史、文件输出、回调与调试界面                                | 日志历史、UTF-16LE 文件、异常观察与写入故障隔离已接通；Console/Controller 原生类、VM 控制台、脚本转储和可选原生栈追踪已接通；错误 UI 策略和其他异常/回收路径仍待实现                                                                                                                   | 进行中 |
| Layer/Bitmap：图像坐标、排序、裁剪、像素/命中、混合、转场           | 已补 26 种像素混合、矩形/缩放/仿射、类型转换/灰度/模糊、整图翻转、Gamma、组透明度、转场、onPaint、截图和 BMP；其他像素方法、完整 Bitmap 能力与严格几何/转场差分仍未完成                                                                                                                | 进行中 |
| 字体与文字：度量、布局、ruby、纵排、显示一致性                      | 已补 FreeType、Rect/边界、预渲染、选择/样式、Unicode/GSUB 纵排、装饰线及 KAG ruby/纵中横场景；Windows 字体替换/字符集、复杂 OpenType、集合多 face、缓存生命周期与全部最终混合仍待验证                                                                                                  | 未完成 |
| BGM/SE/语音、循环点、seek、fade、完成事件、流式 PCM                 | 已接通 Wave/MIDI、AudioWorklet 混音、SLI 标志/标签/循环、定位/淡出/完成事件，验证 WAV/Vorbis/MP3/MIDI；边解码边播放、完整 MIDI、CD 映射和精确滤波仍待完成                                                                                                                              | 进行中 |
| 视频、时间戳、逐帧合成、资源释放                                    | 已实现 VideoOverlay、MP4 显示时间索引、浏览器遮盖/双图层输出、定位/循环/事件及媒体声音；旧编码、其他容器帧索引、完整 mixer、流式读取与精确事件时序待完成                                                                                                                               | 进行中 |
| 游戏写入、文本/二进制流、存档事务、导出/导入、刷新恢复              | 原生文件流、IndexedDB、导出/导入已接通；KAG 普通存档、两种缩略图和刷新读档已有实测，复杂场景与媒体恢复待扩大验证                                                                                                                                                                       | 进行中 |
| IndexedDB/OPFS、HTTP Range、缓存预算、版本/中断处理                 | 已有 IndexedDB 存档/游戏目录事务、图像 LRU、HTTP Range 与 OPFS 完整资源副本、块校验/缓存和中断恢复；按块持久 HTTP 缓存、续传与统一预留仍待实现                                                                                                                                         | 进行中 |
| TLG 等非插件图像格式与专用算法                                      | TLG5/TLG6、SDS、PNG/GIF、索引 BMP、伴随平面、颜色键、PNG/TLG 写出和加载缓存/预加载已接入；有读取/运算对照和 192 个独立解码写出验证；其他变体与统一内存预留仍待实现                                                                                                                     | 进行中 |
| 产品：游戏库、导入/恢复、设置、错误诊断、浏览器能力适配             | 已补本地/远程资源持久保存、库中启动与入口/后端设置、容量提示、取消/失败恢复和跨标签页删除保护；身份迁移、包导出与其他设置仍待实现                                                                                                                                                      | 进行中 |
| GPU 丢失恢复、Worker/媒体清理、后台/前台策略、PWA/静态发布          | 已补 GPU 恢复、用户/图形/页面暂停协调、后台设置与输入/媒体门控；PWA 外壳及更新已验证；移动系统/BFCache、后台长请求、实体 GPU/驱动压力和性能等仍待验证                                                                                                                                  | 进行中 |
| 验证：参考 KAG 对话/选择/转场/声音/脚本存读档、三浏览器、差分与性能 | 当前云端 398 项 Node、639 项浏览器与 6 项直接运行时通过，1,063 次执行分配故障和 188 次字节码分配故障另行记录；原 KAG 36 项、菜单 6 项、异常恢复 6 项、五类跨 ABI 离线升级 30 项通过；此前 20 次冷重启及原生日志、字体、像素、18 项排版等参考按历史阶段保留，完整原生差分和性能仍待验证 | 未完成 |

WebGPU 是架构中的可选后端；应在正确性与性能证据支持时实施，不以它替代 WebGL2 的完整实现。PSB 若仅服务被排除的插件，跟随插件阶段；非插件资源格式需求仍属于当前目标。

纵排调试发现的 `Debug.logAsError()` 缺口已在日志阶段处理。Console/Controller 的原生类语义与 VM 控制台也已接入；Scripts.getTraceString 已接入；原生错误 UI 策略与其他异常/隐式析构路径仍待完成。

参考 `kag3_template.xp3` 已完成 KAGMainWindow 构造，并在浏览器显示 `first.ks` 的 “Hello, world!!”。本项目的场景由参考模板原有脚本处理：输入流程覆盖换行、历史层、翻页与文字选择；新增流程覆盖三种 trans/wt、变量/场景保存恢复、8 位/24 位缩略图和刷新读档。完整图形混合、复杂存档、媒体恢复及更复杂的输入/系统事件仍未证明完成。

原有 Conductor 的独立输出 `ABCD` 验证宏、定时等待、异步继续和调用返回顺序。浏览器报告与截图在 `out/verification/kag3_template-*-flow.*`、`*-save.*` 与 `*-transition.*`，通过 `tests/probes/kag-browser.ts` 重跑；无浏览器的 startup 探测因缺少字体后端不能替代画面验证。目标保持 active，所有尚未证明的条目仍未完成。输入设计与边界见 [输入决策](decisions/006-input-routing.md)。

2026-09-13 的 `out/verification/zip-matrix.json` 汇总了最近通过的完整检查、既有独立图形样本、16 个 ZIP 包的 90 次成员读取，以及 36 个 KAG 场景：XP3/ZIP × 三种浏览器 × 两种 WASM 后端 × 输入/存读档/转场。重打包保留原模板 30 个成员的全部字节，并由 Python 回读核对。所有 KAG 保存案例检查实际 BMP 字节与追加数据，再由原有 KAG 刷新恢复；PNG/TLG 另有浏览器备份/刷新回读案例。这些是选定案例的证据，不是完整商业游戏集合的证明。本轮完整日志、KAG 报告与截图保存在 `out/verification/zip/`；矩阵绑定实现、测试、构建、WASM 和资源哈希，此前阶段记录仍保留。

音频按源采样位置推进，由 TypeScript 混音器在 AudioWorklet 中执行；WAV/MIDI 在会话 Worker 解析，Vorbis 使用按需加载的独立 WASM 解码器消除已测得的浏览器长度差异。头尾标签、循环、淡出、暂停、错误和停止释放有自动验证。仍需流式背压与 seek、完整 MIDI 音色/控制器、CD/CUE 映射、平滑循环精确差分及声音对象隐式回收。详见 [音频决策](decisions/004-audio-clock.md)。

视频使用浏览器媒体元素解码；MP4Box 在 Worker 解析 CTS/edit list，图层帧以 RGBA 转移并通过确认限制在途数量。已验证带 B-frame 的 H.264、AAC 声音、双图层取样、seek/prepare、遮盖缩放、透明度、区间/周期事件与停止释放。WebCodecs/旧 MPEG-I/WMV 解码、长视频 Range、完整混合层/色彩控制、多流选择、严格原生事件顺序和无缝区间循环仍未完成。详见 [视频决策](decisions/005-video-presentation.md)。

图层显示对需要整体透明度的子树先做隔离合成，普通图层仍独立上传 WebGL；含基础或 Photoshop 混合的可见树在 CPU 使用共享整数运算，并与 piledCopy 共用结果。已开放全部 26 种图像类型，binder/effect/filter 仍是无图像节点。独立参考标量对照已扩展到 94,464 组像素，浏览器检查 23 种依赖背景的模式；这不等于完整原生 SIMD/像素或复杂组语义一致。矩阵/三顶点仿射、20 种采样枚举、clear、自复制和可暂停/取消采样已接入，仍需严格几何/采样差分、其他像素方法与性能工作。详见 [仿射决策](decisions/009-affine-rasterization.md)、[像素混合决策](decisions/008-pixel-blending.md) 和 [场景与图像存档决策](decisions/007-scene-transitions-snapshots.md)。浏览器 fullScreen 仍是页面内全屏。

仍需验证 Timer/AsyncTrigger 的隐式回收与所有权（目前已验证显式 invalidate 和整场销毁），System.eventDisabled、连续事件已有独立实现与参考轨迹验证，但完整立即异常、窗口更新尾部和宿主对象原生类型语义仍未完成；不能以当前事件测试通过认定全部生命周期已对齐。

图像处理新增 convertType/doGrayScale/doBoxBlur，并修正翻转应覆盖整图与 province 的行为。333 个数值对照案例使用 TVP 标量及修复了未初始化读取的旧 CPU 模糊参考；具体来源、范围和限制见 [图像处理决策](decisions/010-image-processing.md)。

TLG5/TLG6 解码与 TLG0 SDS 标签已使用纯 TypeScript 接入 loadImages 和规则图读取。310 个原生编码器样本逐字节通过，三浏览器双后端的颜色/透明度、Unicode 标签、转场与取消均通过；详见 [TLG 图像决策](decisions/011-tlg-images.md)。

伴随 mask/province、loadProvinceImage、四种颜色键及 PNG 位置/分辨率标签已接通。新增 TS PNG/GIF 和索引 BMP 解码，以保留隐藏 RGB 和调色板索引；110 个编码器样本与 12,288 个原生加载运算对照已通过。设计、格式/内存范围和有意不复现的原生异常见 [图像加载决策](decisions/012-image-loading.md)。

PNG、TLG5/TLG6 的 RGB/RGBA 写出已接入 saveLayerImage、IndexedDB 与备份恢复，192 个输出通过原生 TLG/Pillow 的独立解码；元数据、取消、原图与旧文件保留、模式和预算见 [图像写出决策](decisions/013-image-writing.md)。

解码图像缓存及 System.graphicCacheLimit/clearGraphicCache/touchImages 已实现，含 LRU 容量、独立副本、资源版本、并发去重、预加载优先级/预算/超时和取消。设计及原生策略差异见 [图像缓存决策](decisions/014-image-cache.md)。继续其他格式变体与像素方法、字体、系统事件及 Web 存储能力。

ZIP 中央目录、stored/deflate、ZIP64、文件名扩展、CRC 与浏览器导入已接通，16 个 Python 独立归档覆盖 90 次成员读取。另补 TJS 文件流写入路径预检，避免无效归档写入进入关闭后的待写队列。格式、预算、嵌套包/旧编码等限制见 [ZIP 资源决策](decisions/015-zip-storage.md)。

HTTP Range 来源、Worker 内身份准备与远程链接入口已接通。23 项来源边界和 4 项真实 HTTP/TJS 集成测试，以及三浏览器双后端的 36 项远程读取测试已通过；8 MiB 以上 XP3/ZIP 的启动流量低于文件的八分之一。版本变化、停机中断、完整下载降级及刷新存档均有验证。设计与限制见 [HTTP 来源决策](decisions/016-http-sources.md)，该阶段日志在 `out/verification/http/`。OPFS 和持久资源库随后已接入；流式媒体仍未完成。

HTTP 阶段完整 `npm run check` 已通过 193 项行为/集成和 243 项浏览器测试，无跳过；最新检查记录为 `out/verification/http/check.log`，来源/测试/构建哈希汇总为 `out/verification/http-matrix.json`。`zip-matrix.json` 保留 ZIP 阶段的 36 个原有 KAG 场景证据，本轮没有重跑该独立探测矩阵。

OPFS 游戏库已接通完整资源保存、按需分块校验、独立目录摘要、启动设置及跨标签页锁。原本 HTTP 阶段列为未完成的“OPFS/持久资源库”，已有上述实现进展；按块 HTTP 缓存、续传、身份迁移与其他未覆盖能力仍未完成。PWA 外壳随后独立接入。设计与验证范围见 [OPFS 游戏库决策](decisions/017-game-library.md)，本轮记录放在 `out/verification/library/`。

游戏库阶段的完整检查已通过 201 项行为/集成测试和 303 项浏览器测试，无跳过；常规 246 项与磁盘游戏库 57 项顺序执行，两组各用 2 个 worker，保留原来的用例和断言超时。新增确定性验证覆盖刷新恰好打断启动点击的竞态，并修复窄屏长名称溢出。权威日志是 `out/verification/library/check.log`，实现/测试/构建及配置哈希见 `out/verification/library-matrix.json`。HTTP 和 ZIP 阶段的矩阵作为历史证据保留，原 KAG 的 36 场景未在本轮重跑。

PWA 阶段已实现生产应用离线准备、完整发布文件校验、显式更新、旧标签页依赖保留和缓存驱逐修复。三浏览器均通过真实应用服务器关闭后的刷新、完整浏览器重启、OPFS 游戏/存档和离线声音/视频；存档提交失败阻止重新载入，库导入期间禁用更新重载。技术边界见 [离线应用决策](decisions/018-offline-app.md)。

本阶段完整 `npm run check` 通过 **209 项行为/集成和 338 项浏览器测试**：常规 246、磁盘游戏库 57、PWA 35。选中的案例无失败或跳过；额外的 WebKit 网络模拟案例因最小 Service Worker 对照也失败而显式排除，实际服务器关闭案例在三浏览器中保留。WebKit 磁盘测试的 trace 连续截图开销另经对照定位，只关闭连续截图，保留 DOM/网络 trace、失败截图、2 个 worker 和原有超时/断言。完整日志为 `out/verification/pwa/check.log`，最终源码/测试/配置/发布文件/WASM 哈希及中间失败诊断见 `out/verification/pwa-matrix.json`。原 KAG 的 36 个独立探测场景未在本阶段重跑；插件以外的整体目标仍未完成。

图形恢复阶段已实现 WebGL 上下文丢失时保留 VM/CPU 图像、用户与图形暂停协调、GPU 程序/纹理重建、首帧提交后继续、失败重试、停止取消和迟到通知隔离。另修复暂停期间 AudioWorklet 电平统计停更的问题；播放时钟保持冻结，统计按实际输出块继续报告。设计与限制见 [图形恢复决策](decisions/019-graphics-recovery.md)。

本阶段完整 `npm run check` 通过 **216 项行为/集成和 386 项浏览器测试**，其中常规浏览器 294、磁盘游戏库 57、PWA 35。新增 7 项 Node 测试和 48 项三浏览器双后端 GPU/媒体案例，选中案例无失败或跳过；既有 WebKit PWA 网络模拟排除项和 trace 配置保持不变。权威日志为 `out/verification/graphics/check.log`，源码/测试/配置/发布文件/WASM 哈希、逐项 GPU 案例和窄屏截图在 `out/verification/graphics-matrix.json`。本阶段未重跑外部 KAG 36 场景矩阵，也未进行物理显卡重置或长期显存压力测试。后台策略、流式媒体、字体与其余非插件接口仍未完成，整体目标继续保持进行中。

页面策略后的系统/输入工作已接入独立菜单与快捷键后台门控、排队 epoch、System.eventDisabled 与 add/removeContinuousHandler。当前鼠标/触摸/键盘包的 epoch 处理不能替代这些独立入口的检查；完整 IME、移动生命周期和 BFCache 仍需各自验证。事件禁用也不能简单复用页面暂停，否则可能阻塞脚本重新启用事件。

页面生命周期阶段已实现默认后台暂停/可选继续、freeze/pagehide 暂停、用户/GPU/页面状态组合、初始隐藏与停止重启、异步 TJS 成功/错误返回等待、旧 Timer/输入失效、主线程媒体控制及后台存档提交。另修复 WebKit 按钮被相同 textContent 更新打断点击的问题，用实际按住跨状态更新的案例验证。设计和边界见 [页面生命周期决策](decisions/020-page-lifecycle.md)。

完整 `npm run check` 通过 **230 项行为/集成与 438 项浏览器测试**：常规 339、磁盘游戏库 57、PWA 35、Chromium 原生生命周期 7，选中案例无失败或跳过。新增 14 项 Node 与 52 项浏览器案例；原生测试检查 isTrusted 的隐藏/冻结/恢复、双后端 VM 和媒体位置，并包含 21 秒冻结。三浏览器信号测试与原生测试分开记录，原有超时、并发、PWA 排除项及磁盘 trace 设置保留。权威日志为 `out/verification/activity/check.log`，源码/测试/配置/构建/WASM、原生事件、两次完整回归失败及其定位结果在 `out/verification/activity-matrix.json`。本阶段没有重跑外部 KAG 36 场景，也未证明移动强杀、BFCache、所有正在加载/seek 的请求排列或全部非插件接口，整体目标仍在进行。

System 阶段已补统一派发、连续注册和频率、异常闭包上下文、Timer 取队时容量、缓存替换、菜单与 popup 门控。30 项新增引擎/集成验证包括 10 组抽取原生函数的参考轨迹；设计与完整边界见 [System 事件决策](decisions/021-system-events.md)。完整 `npm run check` 已通过 260 项行为/集成与 462 项浏览器测试（363 常规、57 游戏库、35 PWA、7 原生生命周期），所选案例无失败或跳过。另有三浏览器双后端共 6 个 ABI 1 → 2 独立探测通过：真实关闭服务器后，旧标签页重建旧 Worker，新标签页启动新 Worker，两代发布资源各自保留。外部 KAG 的 36 个场景已全部重跑通过，覆盖 XP3/ZIP × 三浏览器 × 双后端 × 输入/存读档/转场。权威日志为 `out/verification/system-events/check.log`；源码、构建、WASM ABI 2、协议 6、原生参考、跨 ABI 和 KAG 结果的哈希见 `out/verification/system-events-matrix.json`，全部本轮材料保存在 `out/verification/system-events/`。整体目标保持进行中。

字体阶段已把物理光标观察从脚本事件队列分开，Layer.cursorX/cursorY 在事件禁用和输入等待期间也能读取新位置，后台观察按原策略忽略。此前文档将该接口误称为 Window 属性，已在字体决策中更正。字体文件加载与预渲染映射已接通；完整字体选择/枚举、复杂集合、缓存原生生命周期和所有字形一致性尚未完成。

字体与光标阶段的完整回归已通过 **276 项行为/集成和 474 项浏览器测试**，设计见 [字体决策](decisions/022-fonts.md)。原生提取对照覆盖 12 个字形和 30 组独立阴影参数；合成 TTF 的浏览器加载、字宽、位图存读及 1:1 画布像素已通过检查。既有媒体测试改为精确等待真实首帧回调，避免等待旧计数或误匹配脚本源码回显。回归中复现的 WebKit 图像加载停滞，经进程栈定位为私有流 releaseLock 与读取器 GC visitor 的内部锁等待，已调整清理方式；50 次原场景重复和 133 个真实流读取器的回收检查通过。原始失败、修复依据和完整日志保存在 `out/verification/fonts/`，详见 [私有流清理](decisions/023-private-stream-cleanup.md)。最终构建额外通过 36 个独立 KAG 场景、6 个跨 ABI 离线更新场景、6 个实际字体截图组合和 3,000 次隔离压缩/解压往返。`out/verification/fonts-matrix.json` 绑定本阶段源码、测试、截图、构建、WASM 和诊断证据；会话协议为 7，WASM ABI 2 与两种解释器产物未改变。完整非插件目标仍未完成。

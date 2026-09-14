# 当前实现范围

最新 [GitHub Actions 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823979389)通过 **362 项 Node、615 项浏览器测试及 6 项直接运行时专项**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34824129905)另通过 **78 项**原 KAG 和跨 ABI 离线升级。当前已接入原生 Scripts 类、compileStorage、反射/missing 和 textEncoding，修复字节码导出、编译重入/语法拒绝/元数据加载、字体预览布局与停止中导入游戏的竞态。TJS ABI **5**、字体 ABI **2**、会话协议 **9**。全部验证在 GitHub 托管 runner 执行；完整非插件目标仍未完成，设计和限制见 [原生 Scripts](../decisions/032-native-scripts.md)。

[最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34825096969)已通过，矩阵为 `out/verification/native-scripts-matrix.json`，绑定 495 份证据，SHA-256 为 `1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d`。原生可信冻结为 21,055.2 ms，未把先前阶段的额外冻结/输入复测计入当前结果。

上一轮完成的 [GitHub Actions 回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815634377)通过 **351 项 Node、609 项浏览器测试及 6 项直接运行时专项**，所选用例无失败、跳过或 flaky，未使用测试重试。[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814325349)另通过 72 项原 KAG 与跨 ABI 离线升级，输入时序另有 30 次三浏览器双后端复测通过。完整非插件目标仍未完成。

原生 `Scripts.getTraceString(limit=0)` 与“脚本调试”启动开关已接入，该已验证阶段 TJS ABI **4**、字体 ABI **2**、会话协议 **9**。调用栈在异步挂起、嵌套回调、字节码和取消时保留已验证的位置与顺序；其他 TVP 桥帧、原生错误界面和隐式回收路径仍需继续对齐。设计和失败分析见 [脚本调用栈](../decisions/031-script-stack-traces.md)。[最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34816691294)保存为 `out/verification/stack-traces-matrix.json`，绑定 503 份证据，SHA-256 为 `9babc637693f500efb1a04399f246f037ee5f32ba16090d78d2ab6113ec0a9df`。

当前实现包含独立 TJS2 VM、文件流、持久存档、部分 TVP 宿主、游戏库与离线应用。它可以运行内置示例、已验证的 KAG 流程和使用已实现 API 的脚本；尚未达到完整 KAG 或商业游戏兼容。

[此前 VM 控制台阶段报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812958010)绑定该阶段结果、应用/发布哈希和 487 份证据，保存在 `out/verification/vm-console-matrix.json`。历史失败和未覆盖范围继续保留，见 [测试说明](../testing.md)。

平台限制：当前渲染要求 Worker OffscreenCanvas WebGL2。Playwright 1.63 的 Linux GTK WebKit 在云端无法创建该上下文，暂不能运行播放器；WebKit 的完整场景使用 GitHub 托管 macOS 验证。Linux Chromium/Firefox 与不依赖渲染的 Linux WebKit WASM 探测分别保留，见 [测试说明](../testing.md)。

此前 VM 控制台阶段已将 Console/Controller 对齐为原生类对象，接入编译警告、异步 compile、异常代码输出及独立 `Scripts.dump()` 文件。38 项 Node 专项、36 项浏览器面板/VM 检查、6 项独立运行时探测和 6 项冷离线检查通过；后续完整回归改由 GitHub Actions 执行并通过，另有 [66 项原 KAG 与离线升级检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812505215)通过。该阶段使用 TJS ABI 3、字体 ABI 2、会话协议 9，范围见 [VM 控制台](../decisions/029-vm-console.md)。

调试面板已接入 `Debug.console/controller` 的只读对象与 `visible` 属性，脚本和页面按钮共用状态，暂停与失败时也可重新打开。原 KAG 菜单/快捷键 6 项已通过；完整回归通过 **331 项行为/集成与 579 项浏览器测试**，最终构建另通过 36 项 KAG 综合场景，以及 TJS ABI、字体 ABI、协议 8→9 各 6 项离线升级检查；完整证据见 `out/verification/debug-panels-matrix.json`。原生类身份/构造/静态成员语义已在后续 VM 控制台阶段对齐，范围见 [调试面板](../decisions/028-debug-panels.md)。TJS/字体 ABI 均保持 2。

Debug 已支持历史与重要消息、文件开关和目录、日志观察回调、错误自动写出及备份恢复。仅日志写入失败不会终止游戏，游戏存档事务仍保持严格失败语义；范围见 [Debug 日志](../decisions/027-debug-logging.md)。本阶段完整回归通过 **328 项行为/集成与 561 项浏览器测试**，无失败或跳过；另有 96 组原生日志参考、36 项原 KAG 场景、6 项 KAG 异常日志与恢复，以及 TJS/字体各 6 项跨 ABI 离线升级检查。最终证据见 `out/verification/debug-matrix.json`。该日志阶段之后已补 Console/Controller 页面对象、原生类语义和 VM 控制台入口。

纵排阶段完整回归通过 **308 项行为/集成与 537 项浏览器测试**，包含 6 个新离线纵排冷启动案例。游戏字体支持 vert/vrt2、Unicode 呈现形式回退、按索引旋转与装饰线；系统字体修正了汉字朝向。原 KAG 的 ruby、纵中横、禁则和复制恢复已通过三浏览器双后端共 18 项检查，既有 36 项 KAG 场景也已复核通过。修正旧字体资源的离线查找后，TJS 与字体 ABI 升级各 6 项检查通过；完整证据见 `out/verification/text-layout-matrix.json`。字体 ABI 为 2，TJS ABI 2、会话协议 8 保持不变。具体覆盖与限制见 [纵排文字](../decisions/026-vertical-text.md)。

字体枚举/筛选和选择已接入：游戏家族按样式绑定文件，HTML 窗口提供预览、确认/取消和停止；本机字体只能在支持的浏览器中由用户点击读取。256 组原生筛选参考、字体选择与离线冷启动案例继续保留。设计与该阶段历史证据见 [字体选择](../decisions/025-font-selection.md)。

前一字体几何阶段完整回归为 **290 项行为/集成与 495 项浏览器测试**，矩阵按其历史源码保留。文件字体使用独立 FreeType 2.14.3 WASM，系统字体和普通缺字回退使用 Canvas；337 对矩形、25,200 组坐标和 512 组字形度量/覆盖值已有对照。Windows 字体替换/字符集、集合多 face、旧编码字体、ruby/纵排的完整兼容及全部最终文字混合仍未完成。详见 [字体几何与后端](../decisions/024-font-geometry.md)。

| 模块 | 当前实现 |
| --- | --- |
| TJS2 | 源码、表达式、编译/执行字节码、类/属性/闭包、数组/字典、正则等抽取 VM 原有能力；已验证范围以测试为准 |
| 值桥 | void、null、int64、real、UTF-16 字符串、octet、带上下文的对象句柄；显式 Array/Dictionary 构造与有预算的纯数据复制 |
| 异步桥 | 读取资源后恢复脚本；在 WASM 内继续嵌套脚本与回调；错误带脚本位置；长循环预算让出与取消 |
| 会话 | 显式 Worker；来源准备、初始化、挂载、启动、暂停、恢复、停止、重新创建；过期消息与旧快照隔离 |
| 页面生命周期 | 默认后台暂停、可选择隐藏时继续；freeze/pagehide 暂停，与用户/GPU 状态独立；清理临时输入、控制媒体并尽力提交已写存档 |
| 文件 | File/Blob 与 HTTP Range；版本固定、块缓存、有预算的完整下载与取消；64 MiB 单次读取/解码预算 |
| XP3 | 独立 XP3 的 raw/zlib 索引、分段、连续索引链、adlr 元数据、可选 Adler-32 校验、按文件懒加载及 archive>entry 限定路径 |
| 资源查找 | 相对路径、明确的挂载顺序、精确匹配后大小写回退、目录/归档 auto-path（后注册优先）、basename 回退；冲突时报错 |
| 图像 | TS PNG/GIF/TLG5/TLG6 解码、PNG/TLG 标签和调色板索引；未压缩 BMP 1/4/8/24/32 位读取、8/24/32 位写入及 PNG/TLG 的 RGB/RGBA 写出；PNG zlib 使用 Web 压缩/解压；尺寸上限 4096 × 4096 |
| 图层 | 显示/图像尺寸与偏移、默认 32×32 图像、父子/相对与绝对顺序、重挂/销毁、ARGB 填色、clip、复制、26 种混合、mask/province 像素和命中 |
| 渲染 | Worker 中的 OffscreenCanvas + WebGL2；CPU 位图为像素权威，隔离合成需要整体透明度的子树与转场图像；按 revision 上传纹理 |
| 图形恢复 | 上下文丢失时保留 VM/CPU 像素并暂停；重建程序、uniform 和纹理后提交首帧；保留用户暂停意图，失败可重试显示/备份/停止 |
| 转场/截图 | 三种内置转场、脚本时钟/暂停、图层树交换与完成回调；onPaint、piledCopy、stretchCopy、BMP 图像存档 |
| 计时与触发 | Timer 的间隔/容量/启停、AsyncTrigger 的缓存/取消与优先级队列；暂停时冻结计时 |
| KAGParser | TypeScript 词法与状态机；标签、宏/参数转发、条件、emb、内嵌脚本、跳转/调用栈、store/restore/assign、回调与中断 |
| 菜单 | MenuItem 树、Window.menu、顺序、可见/禁用、单选组、onClick、页面菜单/快捷键、弹出选择/取消 |
| 系统 | createAppLock 使用按游戏分区的 Web Locks，停止释放；exit/terminate 取消执行并提交待写存档 |
| 窗口 | 单窗口的逻辑尺寸、缩放、显示偏移、外观、可见性、resize 通知、管理对象 add/remove、closeQuery/close；可退出的页面内全屏 |
| 输入 | 鼠标/触摸、捕获、键盘/提交文字、物理按键状态、focus chain、模态栈、onHitTest、异步 postInputEvent、光标与 hint |
| 字体 | 独立 FreeType 文件字体、Canvas 系统字体/缺字回退、预渲染版本 0/1 与共享映射、getGlyphDrawRect/Rect、样式与阴影；getList/doUserSelect；逻辑纵排家族、vert/vrt2、Unicode 朝向/呈现形式、按索引变换与竖向装饰线；普通文件路径保留原 FreeType 角度语义 |
| 声音 | Wave/MIDI 宿主、AudioWorklet 混音、WAV/Vorbis/MP3、SLI 循环/标志/标签、定位、音量/声像、淡入淡出、完成事件及静音 |
| 视频 | VideoOverlay 的 MP4 播放、显示时间帧索引、遮盖/双图层输出、seek/prepare、区间/周期事件、透明度、媒体声音及释放 |
| 文本与文件流 | TJS Array.load/save、Array/Dictionary 的结构化读写流；UTF-8、UTF-16、UTF-32 读取、c0/c1 简单编码、zlib 压缩文本 |
| 存档文件 | 写覆盖层、IndexedDB 事务、失败保留脏数据、备份导出/导入；已验证 KAG 变量/场景恢复、BMP 缩略图和刷新读档 |
| 页面 | 示例、本地文件/目录导入、后端选择、TJS 表达式、日志、暂停/停止/重新开始 |
| 游戏库 | OPFS 完整资源副本、校验块、IndexedDB 目录、启动设置、导入取消/恢复与跨标签页删除保护 |
| 离线应用 | 完整发布文件校验与缓存、显式更新、旧标签页依赖保留、缓存修复和子路径部署；生产环境启用 |

**已经提供的脚本 API**

- `Debug.console/controller`：只读对象，独立 `visible` 属性与页面控制同步；无全局 Console/Controller 构造器。
- `Debug.message/notice(...)`、`getLastLog`、`startLogToFile/logAsError`、`logLocation/logToFileOnError/clearLogFileOnError`、`addLoggingHandler/removeLoggingHandler`；另有 `System.inform(message)` 与 `System.getTickCount()`。
- `System.createAppLock(key)`、`System.exit(code)`、`System.terminate(code)`；浏览器不能终止宿主页，退出表现为停止游戏会话。
- `Scripts.dump()`：将原生上下文转储写入 `savedata/krkr2-web.dump.txt`，支持暂停/取消、导出和刷新恢复。`Scripts.getTraceString(limit=0)` 已接入原生调用栈，启动前启用“脚本调试”后返回文件、行号和上下文；默认返回空串。详见 [脚本调用栈](../decisions/031-script-stack-traces.md)。
- `Scripts.compileStorage(input, output, result=false, debug=false, expression=false)`、`getClassNames(object)`、`setCallMissing(object)`、`textEncoding`；原生类、编译输出和编码边界见 [原生 Scripts](../decisions/032-native-scripts.md)。
- `Scripts.execStorage/evalStorage(name, mode, context)` 和 `Scripts.exec/eval(source, name, lineOffset, context)`，支持嵌套执行、上下文和来源行偏移。
- `Storages.isExistentStorage(name)`、`Storages.addAutoPath/removeAutoPath(directory)`、`getPlacedPath`、路径提取函数。
- ZIP 支持 stored/deflate、ZIP64、UTF-8/CP437/Unicode Path、按需读取与 CRC 校验，提供普通名称和 `archive>entry` 地址。无效写入目标在 TJS 创建文本/二进制流时预检；原始归档保持只读。详见 [ZIP 资源决策](../decisions/015-zip-storage.md)。
- `Window`：尺寸/位置/显示偏移/缩放、外观属性、`add/remove` 管理对象、`onResize`、`onCloseQuery/close`、`menu`、`primaryLayer`。新窗口初始不可见，脚本需设置 `visible=true`。
- `Layer`：尺寸/图像尺寸与偏移、`setSizeToImageSize/setClip`、`fillRect/colorRect/copyRect/assignImages`、`loadImages`、`drawText`、像素访问、parent/children、order/absolute、moveBefore/moveBehind、翻转、命中及显式销毁。
- `Layer.focus/focusNext/focusPrev`、`setMode/removeMode`、`releaseCapture/releaseTouchCapture`、焦点/按键/鼠标/触摸事件、`onHitTest` 和四参数 `getLayerAt`；`Window.focusedLayer/currentModalLayer/postInputEvent`、`System.getKeyState`。输入法模式、手势和系统事件仍有未完成项。
- `Layer.adjustGamma`：独立 RGB 曲线与输出区间、裁剪、透明度保持及加算 Alpha 处理；图像加载支持常见浏览器格式的扩展名补全。
- `Layer.beginTransition/stopTransition`：crossfade/universal/scroll、withchildren、selfupdate、callback 与完成事件；`piledCopy/stretchCopy/saveLayerImage` 接通子树截图、缩放和 BMP 写入。
- `Layer.operateRect/operateStretch`：26 种图像运算、omAuto、目标 face/holdAlpha、裁剪及重叠自复制；旧式 `pileRect/blendRect/stretchPile/stretchBlend` 也已接入。基础与 Photoshop 类型参与场景合成和截图。
- `Layer.affineCopy/operateAffine/affinePile/affineBlend`：矩阵/三顶点变换、局部源坐标、旋转/镜像/剪切、滤波、clip、clear 和重叠自复制；耗时采样支持暂停/取消。基础与 Photoshop 运算在 mask/province face 下仍操作主图像。
- `Layer.convertType/doGrayScale/doBoxBlur`：整图 Alpha 表示转换、clip 内灰度和 Alpha 感知矩形模糊；模糊可暂停/取消。`flipLR/flipUD` 翻转整图及 province，不受 clip 影响。
- `Layer.loadImages` 支持 TLG5 RGB/RGBA、TLG6 灰度/RGB/RGBA，返回 TLG0 SDS 标签字典，无标签返回 null；解码可暂停/取消，灰度 TLG6 也可用作 universal 转场规则。
- `Layer.loadImages` 自动读取 `_m` mask 与 `_p` province，支持 RGB/adaptive/palette/AlphaMat 颜色键和 PNG 位置/分辨率标签；`loadProvinceImage` 仅替换索引平面，保留颜色、Alpha 与 clip。全部资源准备成功后提交图层。
- `Layer.saveLayerImage` 支持 BMP、PNG、TLG5/TLG6 的已列明模式，保存整幅主图，24 位模式丢弃 Alpha；TLG 自动写入图层 mode 标签。PNG/TLG 编码可暂停/取消，完整编码后才更新存档文件。
- `WaveSoundBuffer` / `MIDISoundBuffer`：`open/play/stop/fade/stopFade`、status/position/samplePosition/paused/looping/volume/volume2/pan/frequency、标签与完成回调。Wave 提供即时 indexed flags、labels、globalVolume/globalFocusMode，MIDI 提供基础 `midiOut` 合成。
- `VideoOverlay`：`open/play/stop/pause/close/rewind/prepare`，位置/尺寸/显示、MP4 的 position/frame/fps、layer1/layer2、setSegmentLoop/setPeriodEvent、默认音轨的音量/声像与关闭声音、帧/周期/状态回调。mode 支持 overlay/layer 和基础 mixer；完整 mixer 未完成。
- `System.getArgument(name)` / `setArgument(name,value)`：未提供的选项返回 void；宿主和脚本可提供字符串选项，Web 默认没有命令行参数。
- `System.graphicCacheLimit/clearGraphicCache/touchImages`：源图像 LRU、预加载容量/优先顺序/超时、资源版本失效和可暂停/取消。默认 32 MiB，上限 64 MiB；图层、颜色键和标签使用独立副本。详见 [图像缓存决策](../decisions/014-image-cache.md)。

上述 TVP API 仍是子集。`setSize` 缩小显示区域时保留图像，扩大显示区域会按需扩大图像；`setImageSize` 缩小到显示区域以下时会收缩显示区域；图像偏移必须使显示区域保持在图像之内。`fillRect` 颜色按 `0xAARRGGBB` 解释，原来示例中的第六个“透明度”参数已改正。子层默认不可见，主层可见且不允许移动/隐藏。`face` 区分 main、mask、province 与两种 alpha 表示；`colorRect` 使用 TVP 的定点规则。

仍未完成其他 Bitmap/像素方法、全部几何/混合/采样分支的精确差分、转场的全部原生重入/系统事件边界、字体兼容、完整 ruby/纵排验证和原生窗口事件全集。游戏文件字体使用独立 FreeType WASM；系统字体名称映射和普通缺字回退依赖浏览器，不能保证与原生系统字体一致。预渲染映射、Rect/边界查询、角度的后端差异及已测范围见 [字体几何与后端](../decisions/024-font-geometry.md)。当前全屏占满页面视口，支持按钮/Escape 退出，未调用原生 Fullscreen API。主窗口的外部位置是逻辑值，不会移动浏览器窗口；多窗口尚未支持。

**尚未实现**

KAG 完整画面和复杂游戏流程、流式音频/完整 MIDI/CD 映射、旧视频编码/完整混合层与色彩控制、完整系统/立即事件异常策略、复杂场景/媒体状态的完整存读档验证、按块持久 HTTP 缓存/续传、嵌套包与根目录发现、其他 ZIP 压缩/加密及多卷变体、统一内存预留及其他图像编码变体、PSB、Emote/MotionPlayer 和其他插件、嵌入 EXE 的 XP3、XP3 提取过滤器/加密、完整虚拟路径/patch 自动发现规则、多窗口、移动系统强杀/BFCache 与后台长请求的完整验证。`Plugins.link` 返回带插件名的明确错误。

没有解析游戏专用补丁命名规则。页面的源文件顺序就是挂载顺序；后挂载的同名资源覆盖前者。目录选择保留目录内的相对路径。不同大小写文件可各自存在，但歧义回退会报错。XP3 的保护位是提取保护标志，不等于内容加密；adlr 也不保证是内容校验和。两者作为元数据保留，不再阻止普通读取。游戏专用提取过滤器仍未接入。

**对象与停止语义**

传给宿主的临时对象句柄在宿主返回后释放；需要持有时必须 `retain`。释放标记立即生效，底层引用在下一次 VM 执行入口或宿主返回的原生边界回收，使可能发生的 TJS finalizer 保持在可挂起的 WASM 栈内。VM 或其他对象仍持有引用时，释放一个宿主句柄不保证立即析构该对象。

运行期间显式 `invalidate` 可以执行异步 finalizer。整场会话停止先取消执行，再清理 VM；最终整体销毁阶段跳过用户脚本 finalizer，防止已经停止的会话再发起宿主操作。这是有意定义的平台边界，不能用于代替游戏自己的保存/退出流程。当前通过原生文件流持久化游戏写出的文件，不提供任意 VM 内存快照。

预算检查每 2048 条 VM 指令检查一次时间，时间片目标 8 ms，然后让回浏览器事件循环。解析、编译、复杂正则、解码等非指令循环并没有统一的抢占保证；停止在 2 秒内未完成时客户端终止 Worker。恢复会创建新的 Worker、VM 和 canvas，不尝试复用已销毁的 RPC client。

**验证**

- `npm test`：真实 Asyncify WASM 的语言/异步/句柄测试，XP3/字节视图/路径案例，以及 TJS → TVP → 像素/输入的集成测试。
- `npm run test:browser`：Chromium、Firefox、WebKit 上的 Asyncify/JSPI 示例运行、画面变化、暂停/重启、缺失入口与长循环停止。
- 三套页面/Worker/纯引擎 TypeScript 配置分别检查环境边界；`npm run build` 验证生产 Worker 与哈希 WASM 发布产物。

自动测试使用本项目编写的场景。另以本地参考 `kag3_template.xp3` 的原有 Conductor 验证了宏、计时等待、异步继续和 call/return；模板已在真实浏览器显示 `first.ks` 的 “Hello, world!!”。原有 KAG 系统配合本项目输入场景，已在 Chromium、Firefox、WebKit 的 Asyncify/JSPI 六种组合中验证点击换行、历史层模态显示/Escape 关闭、回车翻页和文字链接跳转。没有运行参考项目的商业游戏集合，也没有完成原引擎全 API 差分验证。报告与截图在 `out/verification/`，可通过 `tests/probes/kag-browser.ts` 重跑。

**存档与事件的已验证边界**

本地游戏 ID 由所选文件的路径（反斜杠转正斜杠）、大小及首尾采样内容确定，同一文件集合的选择顺序不改变身份。它不是全包内容哈希；文件集合或版本变化可能形成新的存档命名空间。远程身份另使用固定 URL 和版本，见文末远程来源边界。备份记录 game ID 与各原始文件的字节内容，跨身份导入会拒绝。游戏库中的身份合并/迁移仍需后续实现。

原生流关闭时将数据复制到宿主队列；下一次宿主读之前应用写覆盖层，脚本调用结束后等待 IndexedDB 提交，之后才报告保存完成。失败时保留可导出的覆盖层并允许重试停止。事务完成语义依据 [IndexedDB transaction](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)。

Timer 间隔按 1/65536 ms 取整，默认容量为 6；容量 0 在当前调度器中限制为 65535 个积压事件。初始间隔沿用本地参考实现的固定点初值 1000 / 65536 ms，使用方应显式设置间隔。AsyncTrigger.cached 合并未派发事件，变更 cached/mode 会取消待派发事件。实现参考 [Timer.interval](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Timer_interval.html)、[Timer.capacity](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Timer_capacity.html) 与 [AsyncTrigger.cached](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_AsyncTrigger_cached.html)。System.eventDisabled、连续回调、优先级、嵌套 generation 和异常处理已接通，详细范围见 [System 事件](../decisions/021-system-events.md)。完整窗口更新尾部、立即异常和隐式所有权仍未覆盖。

浏览器测试针对生产构建运行，避免开发服务器热重载影响执行上下文，覆盖三种浏览器上的两种 WASM 后端。2026-09-13 的 ZIP 阶段 `npm run check` 通过 **230 项行为/集成测试和 438 项浏览器测试**（339 项常规上下文、57 项磁盘游戏库、35 项 PWA、7 项 Chromium 原生生命周期），包含 94,464 组标量混合对照、333 个图像处理对照、310 个 TLG 原生编码器样本、110 个 PNG/GIF/BMP 样本、12,288 个加载运算对照、192 个独立解码写出验证、16 个独立 ZIP 包的 90 次成员读取，以及图形/场景、声音、视频、输入、KAG、菜单、锁、存档、HTTP、OPFS、离线应用更新和停止回归。该结果不证明全部非插件引擎功能完成。

场景与图像存档的实现边界见 [场景合成、转场与图像存档](../decisions/007-scene-transitions-snapshots.md)。当前合成缓存保留上限为 64 MiB，普通图层保持独立 WebGL 纹理，需要隔离的子树及包含特殊混合模式的主图层树在 CPU 合成。GPU 组渲染优化、极端采样参数及严格原生像素差分仍未完成。

26 种像素混合通过 94,464 组本地参考标量对照。基准按单像素函数调用生成，不覆盖参考项目中按地址对齐/8 像素块切换的差异；AddAlpha→Alpha 采用明确记录的数学路径，未声称原生差分通过。普通 GPU/浮点合成与整数绘图的全部舍入也未统一。来源、可重跑探测和例外见 [像素混合决策](../decisions/008-pixel-blending.md)。仿射采用浮点几何和采样，尚未完成旧原生 16.16 与现代三角形路径的全部差分；细节见 [仿射决策](../decisions/009-affine-rasterization.md)。

类型转换、灰度和矩形模糊通过 333 个独立图像对照案例。模糊参考取自保留的旧 CPU 分支，并明确修复其较矮 clip 的未初始化缓存读取；这不是对现代 OpenCV/OGL 或所有原生实现的等同声明。算法、整数舍入、整图/clip/province 范围及修复详情见 [图像处理决策](../decisions/010-image-processing.md)。

TLG 解码通过 310 个独立原生编码器样本的 222,986 个 RGBA 像素对照，覆盖全部 32 种 TLG6 滤波/预测组合。浏览器检查 Unicode 标签、Alpha、BMP 回读、灰度规则图转场和 4096×4096 图像解码中途停止。原生编码器适配的三项修复、解码内存预算与严格格式检查见 [TLG 图像决策](../decisions/011-tlg-images.md)。

图像加载新增 110 个 PNG/GIF/BMP 编码器样本和 12,288 个原生 key/mask/matte 像素对照，覆盖调色板索引、Adam7、16 位透明色、PNG 五种滤波、GIF LZW/隔行与 BMP 位顺序。mask 替换 Alpha，province 保留索引并可平铺，失败保持原图。与旧参考异常选择/错误 tRNS 参数的差异、静态 PNG/GIF 范围及展开内存上限见 [图像加载决策](../decisions/012-image-loading.md)。

图像写出新增 192 个独立解码验证：128 个本项目生成的 TLG 由原生加载器逐像素验证，64 个 PNG 由 Pillow 检查；并在三浏览器双后端验证显示、导出、刷新恢复及大图取消。保存模式、元数据差异、原生分配器的填充处理及内存边界见 [图像写出决策](../decisions/013-image-writing.md)。

本地参考 KAG 的输入、存读档、转场三组场景在原 XP3 和保留全部成员字节的 ZIP 中均已通过，覆盖三种浏览器、两套后端，共 36 个案例。保存验证包含 8 位/24 位 BMP 的头、像素与追加脚本数据，以及刷新后变量和场景恢复。该阶段汇总见 `out/verification/zip-matrix.json`，历史日志和截图在 `out/verification/zip/`。求值结果按请求标记匹配，截图等待会话/尺寸就绪，KAG 历史检查等待排队的输入完成；另验证延迟自动播放拒绝及恢复。实现、测试、构建和 WASM 哈希均在矩阵中。

**输入的已验证边界**

脚本在 onBeforeFocus 中可重定向目标；onBlur/onFocus 内再次切换会报错。隐藏、禁用或分离当前焦点层会寻找有效目标，模态层限制输入范围。禁用层的像素命中会挡住下层，opacity 为零不意味着事件穿透；onHitTest 可进一步否决像素命中。独立触摸捕获和兼容单指点击均有测试。

浏览器的透明 textarea 接收已提交的文字，菜单快捷键仍可使用。composition 测试构造浏览器事件，尚未覆盖实际操作系统输入法组合。手势、精确 IME 模式、光标资源、全部场景变动的悬停重算、任意回调重入及隐式对象回收仍待验证。详见 [输入与焦点决策](../decisions/006-input-routing.md)。

**声音的已验证边界**

WAV PCM 与 MIDI 由 TypeScript 解析，Vorbis 在会话 Worker 中使用独立 WASM 解码；其他支持的编码委托浏览器。Vorbis 测试覆盖完整源长度与尾部标签；MP3/Opus 的精确编码延迟、尾部裁剪和全部编码参数尚未差分验证。SLI 条件链接不受 EOF looping 开关限制，flags 为 16 个 0..9999 的值；labels 保持字典身份，并提供 name、samplePosition、position。

独立声音 paused 保持 play 状态与采样位置，fade 沿 60 ms 时钟继续；会话暂停冻结两者。页面静音不改变脚本音量。Wave 全局音量只影响 Wave，焦点模式映射到页面可见性/焦点。当前 MIDI 为基础程序合成音色，并非完整 GM 音库；CDDASoundBuffer 只接受导入的音频资源，不能打开物理 CD 曲目。当前会准备完整 PCM 后播放，混音器保留 PCM 上限 128 MiB，解码有额外瞬时内存；没有流式背压或低内存长音轨路径。平滑循环近似交叉淡化、滤波、多声道细节和隐式回收仍需扩大验证。见 [音频时钟与解码边界](../decisions/004-audio-clock.md)。

**视频的已验证边界**

视频声音连接现有 Web Audio 输出，页面静音会同时作用于视频和声音缓冲。自动播放被拒绝时显示“播放视频”，脚本加载可继续；会话暂停保持逻辑 play 状态并暂停媒体元素。图层模式传入真实 RGBA，并随视频调整目标图层尺寸；每个视频最多一帧在途。停止/失败取消待加载媒体、撤销 Blob URL 并断开声音连接。

当前验证使用自行生成并明确标注 BT.709 的 H.264/AAC MP4。绝对帧索引仅覆盖 MP4 路径，其他容器的帧操作明确拒绝；没有证明全部 MP4 edit/fragment 情况。完整 `setMixingLayer`、原生颜色控制、备用音视频流、MFEVR、旧 MPEG-I/WMV 解码及 WebCodecs 后端未实现。prepare/暂停时 seek 的事件顺序、区间循环边界与原生实现仍需差分；媒体元素不能保证无缝循环。视频文件目前整段读取，受单资源 64 MiB、视频合计 128 MiB 预算限制；长视频流式读取、HDR/未标记色彩与 GPU 回读性能尚待验证。详见 [视频呈现与生命周期](../decisions/005-video-presentation.md)。

**KAG 与菜单的边界**

KAG 表达式在原 TJS2 中以 parser 实例为上下文执行；标签字典复用，宏参数保留可变字典及单独的属性顺序。`assign` 复制精确位置，`restore` 遵循所检查原实现的标签恢复行为，call/return 保留调用行并检查返回位置是否因脚本变化而失效。接口依据 [KAGParser](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_KAGParser.html)，本地参考实现的特殊边界仍需扩大差分验证。

数据复制只接受原生 Array/Dictionary，不执行脚本属性，拒绝循环/任意脚本对象，限制深度 64、成员 100,000；常规 TJS 对象继续使用句柄，不自动序列化。KAG 宏定义/展开限制 8 MiB，宏/调用栈深度限制 4096。

`MenuItem.popup` 挂起调用者直到选择/取消，关闭后恢复 TJS 并按 flags 决定派发 onClick。当前 VM 队列在弹出期间不会执行其他计时回调，尚未覆盖原文档允许的弹出期间异步事件重入；原生窗口句柄、菜单动画和全部 Win32 布局标志未实现。参见 [popup](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_MenuItem_popup.html)。Web Locks 的范围是同一站点存储分区，并按 game ID 加前缀，不能检测另一站点或原生程序的同名锁。参见 [Web Locks](https://w3c.github.io/web-locks/)。

**远程来源的已验证边界**

页面可载入单个远程文件链接，XP3/ZIP 按签名识别。HTTP Range 使用强 ETag 与 If-Match 固定版本、256 KiB 块/32 MiB 会话缓存、最多 4 个并发请求；完整下载快照合计不超过 64 MiB。请求错误、版本变化、CORS 和停止有明确处理。已测来源偏移超过 4 GiB，但单个展开资源仍受 64 MiB 限制；这不代表音视频已经实现流式解码。

远程游戏 ID 使用逻辑路径、大小、URL/最终 URL 和固定版本，刷新同版本保留存档；URL、文件名或版本变化可能创建新命名空间。本地文件沿用此前的采样哈希，以保留旧存档。当前可以主动完整保存到 OPFS 游戏库；身份迁移、按块持久 HTTP 缓存、远程目录清单和登录资源配置仍未实现。服务器要求、网络/内存预算、测试范围见 [HTTP 来源决策](../decisions/016-http-sources.md)。

HTTP 阶段的完整检查通过 193 项行为/集成和 243 项浏览器测试，无跳过。最新构建与测试哈希见 `out/verification/http-matrix.json`，完整日志见 `out/verification/http/check.log`；原有 KAG 的 36 个独立场景仍引用此前 ZIP 阶段矩阵。

**OPFS 游戏库的已验证边界**

游戏库支持完整保存本地文件和固定版本的远程来源，并在刷新或重开浏览器后从 OPFS 启动；资源服务器断开后仍能访问之前未使用的成员。名称、启动入口及执行后端保存在独立目录中，原有存档身份保持兼容。

导入逐块写入、校验、flush/close 后才提交游戏记录，取消或失败清理未发布目录。运行/暂停的库游戏持有共享锁，其他标签页移除时会报占用。库资源可删除，游戏存档保留。清单升级、配额/写入/flush/提交失败、停止无响应 Worker 后恢复、未使用块损坏及跨标签页操作均有真实浏览器测试。

列表只读取小型目录摘要；启动才读取目标清单和按需校验块。游戏库最多 256 个条目，单条目最多 10,000 个来源、64 GiB、65,536 个 1 MiB 校验块；单资源解码预算仍然有效。三浏览器的持久能力使用隔离磁盘 profile 验证，另测试存储被拒绝时的临时载入。规则、内存预算、WebKit 临时上下文限制与未完成项见 [OPFS 游戏库决策](../decisions/017-game-library.md)。应用外壳的 PWA 离线加载现已接入；按块持久 HTTP 缓存仍待实现。

游戏库阶段最新的完整验证为 201 项行为/集成和 303 项浏览器测试，无跳过。源码、测试配置、WASM 与产物哈希在 `out/verification/library-matrix.json`；日志在 `out/verification/library/check.log`。HTTP/ZIP 矩阵保留各自阶段的构建记录，不表示已在本轮重新执行独立 KAG 探测。

**PWA 离线应用的已验证边界**

生产构建可主动保存全部应用组件和许可证，完成后重新载入进入离线版本。新版本完整下载并校验后才可激活，损坏部署保留旧版本。更新先停止当前会话并提交存档，提交失败保留待写数据供导出；游戏库导入期间禁止应用重新载入。

其他标签页不会自动刷新。新 Worker 保留旧文档需要的哈希脚本与 WASM 清单；仅在当前版本独占作用域且没有安装/等待版本时清理旧缓存。应用缓存不收纳游戏文件、存档、Range、非 GET 或未知响应，缓存丢失可联网修复。单版本最多 32 MiB，最多保留 8 代/64 MiB。

三浏览器均验证真实服务器关闭后的刷新和完整浏览器重启，以及 OPFS/存档、两套 TJS 后端、Vorbis/AudioWorklet/MP4 和 A/B 更新。额外的网络模拟用例只在 Chromium/Firefox 运行；WebKit 的模拟限制有最小 Service Worker 对照，显式记录在测试配置中。原生操作系统安装未验证。详细协议、部署和证据范围见 [离线应用决策](../decisions/018-offline-app.md)。


PWA 阶段完整回归通过 209 项行为/集成和 338 项浏览器测试，选中案例无失败或跳过；上述 WebKit 网络模拟排除项单独列出。最终汇总为 `out/verification/pwa-matrix.json`，完整日志为 `out/verification/pwa/check.log`。中间曾发生的 WebKit 双标签页测试超时、trace 连续截图对照和最终配置均保留在报告中，原有测试断言与超时未放宽。


**图形恢复的已验证边界**

WebGL 上下文失效时保留 VM、CPU 图像和存档，并暂停脚本、计时器、转场与媒体。程序和纹理重新创建后提交首帧，再根据用户暂停意图继续；未变化的静态画面也会重新上传。构造阶段或纹理上传中途失效、重复恢复、资源分配失败/重试及停止重建均有三浏览器双后端验证。

GPU 丢失/恢复使用浏览器的 WEBGL_lose_context 扩展触发真实资源失效；没有执行物理显卡重置或穷举驱动行为。自动暂停保留 Timer 剩余期限和转场时间，System.getTickCount 继续保留宿主单调时钟语义。Wave/VideoOverlay 的播放位置与音频静音输出有独立验证；AudioWorklet 统计已修复为暂停期间继续报告零电平。实现、暂停协调、该阶段协议版本 4（后续升到 5）和平台限制见 [图形恢复决策](../decisions/019-graphics-recovery.md)。


图形恢复阶段完整验证为 216 项行为/集成与 386 项浏览器测试；新增的 48 项 GPU/媒体案例覆盖三浏览器和两种 WASM 后端。当前日志见 `out/verification/graphics/check.log`，源码、测试、配置、发布文件、WASM 和截图的哈希见 `out/verification/graphics-matrix.json`。PWA 的既有模拟排除项保持单独记录，原有外部 KAG 36 场景没有在本阶段重跑。


**页面生命周期的已验证边界**

默认隐藏页面会暂停；可关闭后台暂停，但 freeze/pagehide 仍暂停。返回前台保留原 VM，用户主动暂停和 GPU 未恢复仍能阻止继续。主线程立即清理输入和控制媒体；Worker 在挂起点阻止脚本，异步资源成功/错误返回也遵守暂停。Timer 不补发暂停期间的旧 tick，System.getTickCount 继续使用宿主单调时钟。

后台尝试提交已经进入覆盖层的存档字节，不重入暂停 VM 关闭原生流；失败保留可导出的数据。该行为不能保证操作系统终止前提交完成，也不保存整个 VM 堆。三浏览器的应用信号测试与 Chromium 的真实隐藏/冻结测试分开记录；移动强杀、BFCache、全部加载/seek 中断排列和 Firefox/WebKit 原生冻结未验证。协议 5、输入法处理及测试方式见 [页面生命周期](../decisions/020-page-lifecycle.md)。

页面策略阶段完整 `npm run check` 已通过 **230 项行为/集成与 438 项浏览器测试**；选中案例无失败或跳过，既有 WebKit PWA 网络模拟排除项保持单独记录。新增 14 项 Node 与 52 项浏览器案例，覆盖暂停的异步结果/错误、Timer 与输入、媒体、存档、设置，以及原生隐藏/冻结和按钮按住期间的更新。日志为 `out/verification/activity/check.log`，最终源码/测试/配置/构建/WASM、原生可信事件与中间失败证据见 `out/verification/activity-matrix.json`。外部 KAG 36 场景矩阵未在本阶段重跑。


System 事件使用独立 TypeScript 队列，`eventDisabled` 不暂停 VM 或媒体时钟。支持 add/removeContinuousHandler、精确绑定闭包去重、活列表增删、`-contfreq`、事件异常处理和重新启用时的同步派发。菜单/快捷键检查页面可见性及 epoch，禁用时 popup 仍可返回但不通知 onClick。System 阶段使用 TJS WASM ABI 3、会话协议 9；当前版本与待验证状态见文首。

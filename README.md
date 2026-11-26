# krkr2-web

使用 TypeScript、Web API 与独立 TJS2 WASM 实现的浏览器 KiriKiri2 兼容运行时。

目标是让原版 KRKR2 游戏在浏览器里完成启动、游玩、存读档和退出，当前优先实现插件以外的功能。各项改动按较大批次提交到 GitHub-hosted Actions，下一批取回结果。已通过的场景、待验证的实现和仍需处理的失败记录在[实现进度](docs/non-plugin-progress.md)。

当前已跑通真实 TJS 脚本、异步资源读取、XP3/ZIP、图层/像素、浏览器文字、KAGParser、输入/焦点/模态、计时调度、菜单、Wave/MIDI 声音和 MP4 视频。图形部分包含 26 种像素运算、子树透明度、三种内置转场、截图/缩放/仿射、BMP/PNG/TLG 存档与图像缓存；原有 KAG 已跑通对话/选择、历史记录、转场、缩略图保存和刷新读档。**完整图形与系统 API、流式媒体、旧视频编码及商业游戏兼容仍未完成。** 详细行为与限制见 [当前兼容范围](docs/compatibility/current.md)。

第 176 批接入可擦写 UDF 游戏盘和分段存放的大过场，新增从文件夹拖入游戏及游戏脚本释放 Wave 播放缓冲的支持。新增行为等待托管验证。[176 实现与托管证据](docs/decisions/176-rewritable-discs-and-game-imports.md)

第 175 批为两种旧 AVI 过场接入解码，修订触屏跨控件拖动的点击坐标，并让游戏库在连接失败后可重试导入。新增行为等待托管验证。[175 实现与托管证据](docs/decisions/175-avi-touch-and-library.md)

第 174 批为带预加重标记的 CD 配乐加入播放支持，并修订旧过场转换时的声音起点。新增行为等待托管验证。[174 实现与托管证据](docs/decisions/174-story-history-and-disc-audio.md)

第 173 批让触屏玩家能直接点选鼠标驱动的章节菜单，并修订了首个可播放画面晚于零秒时的影片定位。原版游戏和影片用例等待托管验证。[173 实现与托管证据](docs/decisions/173-touch-choices-and-movie-start.md)

第 172 批支持游戏配置的全屏铺满、完整显示和原尺寸显示，修订 WAVE 循环接缝，并支持与游戏一起导入外置设置文件。第 170 批的生产构建和 UDF 独立制盘均已通过。[172 实现与托管证据](docs/decisions/172-fullscreen-options-story-input-and-wave-loops.md)

第 171 批为原版游戏增加注册表设置读取、KAG 菜单键盘操作，以及 MIDI 乐谱主音量。游戏库可记住玩家选定的游戏设置文件，新增行为等待托管验收。[171 实现与托管证据](docs/decisions/171-game-registry-menu-keys-and-midi-volume.md)

第 170 批为使用 UDF 物理分区的游戏 DVD 接入启动、查盘和文件读取，并修复离线发布清单遗漏补丁文件 MIME 类型的问题。新验收覆盖从 DVD 打开原版 KAG、进入章节、存档及刷新后的读档。[170 实现与托管证据](docs/decisions/170-udf-game-dvds-and-offline-release.md)

第 169 批支持在游戏运行中弹出或更换 ISO、CUE 光盘，包括游戏要求插入下一张盘时从设备选取文件。另修正了原版 Introduction 第二条路线在显示描边对白时会中断的问题。新增行为等待托管验收。[169 实现与托管证据](docs/decisions/169-live-disc-changes-and-kag-outlines.md)

第 168 批支持游戏 ZIP 与单独发行的剧情光盘一起导入。游戏可从配套光盘加载章节和播放 CD 音轨，本批也修订了 KAG 控制标签读取宏属性的顺序，以及普通 WAVE 播放完毕时回调可见的位置。新增行为等待托管结果。[168 实现与托管证据](docs/decisions/168-companion-game-discs-and-story-callbacks.md)

第 167 批让自动识别可以直接启动 ZIP 内的游戏光盘，并保存到游戏库。日文明朝字体的选择和多声道 WAVE 对白的左右声像也在本批修订。新增行为待托管验证。[167 实现与托管证据](docs/decisions/167-packaged-game-discs-fonts-and-speakers.md)

第 166 批支持从单个 ISO 或 CUE 光盘组直接启动原版游戏，并将存档写入独立目录。同批修订影片提示帧的触发时机，以及此前阻断网页构建的两处错误。[166 实现与托管证据](docs/decisions/166-bootable-game-discs-and-movie-cues.md)

第 165 批加入数据光盘文件读取。游戏可以按卷标找到导入的 ISO 或 CUE，从盘中加载剧情和立绘。此批也处理分段 MP4 切换音轨时的时长判断。结果等待托管验证。[165 实现与托管证据](docs/decisions/165-disc-files-and-fragmented-movies.md)

第 164 批让多盘游戏按卷标找到配乐光盘，切轨时继续当前淡出，并处理预渲染字幕选错字体、WebKit 在过场首帧前停住的问题。新增行为等待托管验收。[164 实现与托管证据](docs/decisions/164-disc-volumes-fades-and-game-rendering.md)

第 163 批接入 MPEG-2 和 Xvid AVI 过场，修正长 Ogg 配乐跳转后的一段静音，并使原版存档读回能独立完成验收。本批结果待托管验证。[163 实现与托管证据](docs/decisions/163-movie-playback-music-and-save-verification.md)

第 162 批修正了剧情宏选章时的属性读取与裸 MPEG-1 过场的帧时序，并按第 160 批的游戏库失败记录修订了启动和读档验收。[162 实现与托管证据](docs/decisions/162-game-routes-and-movie-timing.md)

第 161 批让玩家为多盘游戏指定 CUE 盘符，支持从 AIFF 配乐选轨，并修正旧 WAVE 读取与 KAG 转发参数后的赋值。新增行为等待托管验收。[161 实现与验证](docs/decisions/161-disc-music-wave-and-kag-setters.md)

第 160 批支持从带说明文件的 ZIP 发行包启动、从桌面备份 ZIP 选取存档目录，修正剧情宏读取动态属性和配乐重置分支标志的行为。新增行为等待托管验收。[160 实现与验证](docs/decisions/160-save-folders-kag-parameters-and-wave-flags.md)

第 159 批接入 Deflate64 压缩的游戏及存档 ZIP，改进长 Ogg 配乐定位，并按原版的 65 级字形覆盖度绘制预渲染字幕。新增行为等待托管验证。[159 实现与验证](docs/decisions/159-deflate64-games-vorbis-seek-and-text.md)

第 158 批接入 ZIP 格式自解压游戏和 WMV 7／8 过场，并按原版行为修正游戏脚本丢弃文字尺寸返回值时的对白排版。新增行为等待托管验证。[158 实现与验证](docs/decisions/158-executable-zip-windows-media-and-font-calls.md)

第 157 批让玩家在更新后的游戏中复制同一浏览器里的旧版存档，同时修正影片帧标记回调和空对白行的高度。新增行为等待托管验证。[157 实现与验证](docs/decisions/157-game-version-saves-and-playback.md)

第 156 批支持导入分卷 ZIP 和 XP3，修正游戏未指定字体时的对白字号，并支持 MIDI 配乐切换单音与复音。新增行为等待托管验证。[156 实现与验证](docs/decisions/156-split-game-archives-default-font-and-midi.md)

第 155 批让游戏能选用字体合集中的不同家族和字重，并修复嵌套剧情读档和 MIDI 配乐复位后的声像。新增行为等待托管验证。[155 实现与验证](docs/decisions/155-font-collections-conditional-saves-and-midi.md)

第 154 批补上远程游戏保存到库时的断点续传，并修复动态剧情选项、后台音乐音量与原版的差异。新增功能等待 GitHub-hosted 验证。[154 实现与验证](docs/decisions/154-remote-downloads-script-cursor-and-background-audio.md)

第 153 批修复依赖标签属性生成选项的剧情，补上游戏控制过场画面颜色和 WAVE 单声道输出的路径，并修正会意外删除菜单位图的赋值行为。新增功能等待托管验证。[153 游戏兼容与验证](docs/decisions/153-live-tag-attributes-and-media-controls.md)

第 152 批接入部分旧 MPEG／AVI 过场影片的浏览器内转换，并修正 ZIP 发行包按自定义入口启动及从游戏库重开的路径。这些新增行为尚待 GitHub-hosted 验证；已取回的 143–145 批原版对照不代表本批应用已通过。[152 功能、限制与验收](docs/decisions/152-legacy-movies-and-zip-entry.md)

[完整回归 35001345784](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001345784)在精确提交 `34367abda6a4519d54fa1ff8daae3b7776b20cb8` 通过 **1,756 项 Node、1,146 项浏览器和 6 组直接运行时**，14 个作业全部成功，零失败、取消、跳过或重试。浏览器包含 1,023 项常规、57 项游戏库、59 项 PWA 和 7 项可信生命周期。 [兼容检查 34997605307](https://github.com/fenghengzhi/krkr2-web/actions/runs/34997605307)在 `6678d6e` 使用构建 `34997020864` 通过 **78 项原 KAG／旧 ABI 检查**。从该提交到 `34367ab` 只修改测试与文档，应用及内核源码相同；这是同源码的另一构建证据，不冒充最终回归的同次构建。

## 运行

```sh
npm ci
npm run build:wasm
npm run dev
```

打开终端显示的本地地址，点击“运行示例”。画面由 `examples/minimal/` 中的 TJS 脚本与 PNG 驱动。也可以选择该目录，或导入自己的 `startup.tjs` 及其资源。页面支持暂停、停止、重新开始、TJS 表达式求值及存档文件备份。含声音的脚本可使用 WAV、Vorbis、MP3 或 MIDI 资源；浏览器阻止自动播放时，点击“开启声音”。

HTTPS 或 localhost 静态托管即可运行，无需 SharedArrayBuffer 或跨源隔离响应头。默认检测 JSPI，缺少支持时选择 Asyncify；两套产物共用同一份 TJS 源码。当前渲染要求 Worker 中支持 OffscreenCanvas + WebGL2。

游戏可通过 `Layer.font.getList` 枚举字体，通过 `doUserSelect` 打开带预览的选择窗口。默认提供游戏字体和通用家族；支持的浏览器还可在用户点击后读取本机字体。文件字体使用独立 FreeType WASM，枚举与交互使用 TypeScript/Web API。范围见 [字体选择](docs/decisions/025-font-selection.md)。

`@` 字体家族支持纵排朝向与 OpenType 纵排替代字形，原 KAG 的 ruby、纵中横、禁则换列和复制恢复已有固定字体场景验证。文件字体的选择逻辑使用 TypeScript，轮廓栅格化使用独立字体 ABI 2；系统字体仍受浏览器能力限制。详见 [纵排文字](docs/decisions/026-vertical-text.md)。

Debug 已支持历史与重要消息、同步日志回调、UTF-16LE 文件输出和异常记录；文件可随存档备份导出并在刷新后读取。日志故障与游戏写入分开处理，原 KAG 的异常日志和场景恢复已有专项验证。详见 [Debug 日志](docs/decisions/027-debug-logging.md)。

`Debug.console.visible` 和 `Debug.controller.visible` 已接入页面的运行记录与调试控制区。隐藏后可从画面下方重新打开，暂停或脚本长循环时也能操作。原 KAG 的调试菜单与快捷键使用同一套状态，详见 [调试面板](docs/decisions/028-debug-panels.md)。

调试对象现使用原生类语义；VM 编译警告和异常诊断也会进入 Debug。`Scripts.dump()` 可生成随备份导出的 UTF-16LE 转储文件。当前源码 TJS ABI 为 5，直接使用运行时 API 时须等待异步 `compile()`；范围见 [VM 控制台与转储](docs/decisions/029-vm-console.md)。

启动前勾选“脚本调试”，`Scripts.getTraceString()` 可返回当前调用的文件、行号和函数名称；参数可限制深度。默认关闭，修改开关在下一次启动/重新开始时生效。原生调用栈已支持 Asyncify/JSPI 挂起，详见 [脚本调用栈](docs/decisions/031-script-stack-traces.md)。

`Scripts` 已接入原生类，新增 `compileStorage`、`getClassNames`、`setCallMissing` 和 `textEncoding`。本轮通过 GitHub Actions 的完整回归与跨版本离线升级检查；完整非插件兼容仍在实现。详情见 [原生 Scripts](docs/decisions/032-native-scripts.md)。

长脚本编译现支持源码准备、解析和导出期间的暂停、继续与取消，Asyncify/JSPI 共用会话控制。启动尚未结束时停止游戏，也会统一清理 Worker、输入和媒体。检查点与响应时间限制见 [长脚本编译](docs/decisions/033-cooperative-compilation.md)。

`Scripts` 和启动入口支持 KBAD 二进制值，字节码与二进制数据可从指定文件偏移读取。加载前检查结构、引用、指令边界与输入预算，大集合读取也可暂停或取消。格式语义和限制见 [二进制脚本资源](docs/decisions/034-binary-scripts.md)。

字节码加载采用分阶段所有权和失败回滚，支持常量池、上下文构造及链接期间的暂停/取消，并限制重复名字等原生结构的展开预算。实现及故障注入验证范围见 [字节码生命周期](docs/decisions/036-bytecode-lifetime.md)。

执行阶段增加函数/try/超类与宿主嵌套调用的深度限制，以及寄存器和参数的临时内存预算。超限返回可捕获的脚本错误；退出帧清空寄存器，停止请求穿过脚本 catch 完成清理。参数复制支持暂停/取消，构造失败回收由独立故障注入验证。范围见 [执行资源预算](docs/decisions/037-execution-budgets.md)。

对象终结器抛错时仍完成引用释放，并保留原有执行或构造异常。深层 Array/Dictionary 链通过有界释放队列清理；显式失效重试、对象保留自身、断环、暂停/取消和清理分配失败已有专项验证。TJS2 使用引用计数，任意循环引用仍需由脚本显式断开。范围见 [对象终结](docs/decisions/038-object-finalization.md)。

宿主句柄支持异常和重入清理。Timer/AsyncTrigger 与声音对象使用原生弱观察，排队事件独立持有实例直到投递结束；基础 finalize 不提前关闭资源，子类无需调用 super 即可回收。声音关闭会等待异步操作，flags/labels 随声音失效，外部 filters 数组继续有效。该阶段通过 710 项 Node、651 项浏览器、6 项直接运行时和 78 项兼容性检查；Window、VideoOverlay、MenuItem 和 Layer 的后续生命周期进展见[实现进度](docs/non-plugin-progress.md)。详见 [声音生命周期](docs/decisions/040-sound-object-lifetime.md)。

Layer 与 Font 已分开管理原生生命周期：图层树使用弱关系，children 缓存、焦点／捕获／模态和转场各自保留所需引用；终结器错误可重试，失效会按顺序完成转场与资源清理。实现和限制见[图层生命周期](docs/decisions/044-layer-object-lifetime.md)。完整非插件功能仍未完成。

`Layer.update()` 与矩形重绘会触发默认或自定义 onPaint；同次绘制前的请求合并，回调继续请求时安排后续帧。各图层保留独立截止时间，异步调用、暂停和事件禁用不会丢失请求。真实像素、自主连续重绘及原 KAG 已由云端验证，详见[重绘链路](docs/decisions/045-layer-redraw.md)。

`Layer.neutralColor` 已支持每实例的可写 32 位 ARGB，供图像扩容、重新分配和仿射清除使用。无主图的 opaque 图层按该颜色显示并参与祖先快照；`piledCopy` 会在 onPaint 前拒绝缺少主图的来源或目标。详见[中性颜色](docs/decisions/046-layer-neutral-color.md)。

`Window.mainWindow` 已返回实际主窗口实例或 null；`piledCopy` 的空目标区域会在 onPaint 前返回，并保留待绘制状态。图像保存取消新增浏览器按钮调用顺序和编码器内部检查点验证，三项已随 050 完整回归通过，见 [Window 查询](docs/decisions/047-window-main-instance.md)、[空矩形复制](docs/decisions/049-piled-copy-empty-region.md)及[保存取消](docs/decisions/050-image-save-cancellation.md)。同一会话现支持多个页面内 Window，各自拥有画布、图层输入、菜单和视频平面；共享一个 Worker 与 TJS VM。单窗嵌入布局、浮动窗口、主窗退出和画布恢复见[多窗口实现](docs/decisions/051-multiwindow.md)。图层裁剪、copyRect 空写入和 assignImages 目标字体保留已随 055 组合验证，参见[裁剪](docs/decisions/053-layer-clip.md)、[复制](docs/decisions/054-layer-copy-rect.md)和[图像赋值](docs/decisions/055-layer-assign-images.md)。

`Window.showModal()` 已接入协作式事件循环：保留调用者栈，继续处理子窗口输入、计时器和关闭查询，退出时恢复合格的原窗口。输入接收确认与完成分开，原生释放和窗口更新使用各自的检查点；暂停、隐藏页面及 Stop 的边界已由 Actions 验证。实现和旧 VCL 推断限制见[决策 052](docs/decisions/052-modal-scopes.md)。`MenuItem.popup` 现已接通嵌套菜单、Timer 与子 Window 模态，选择结果和返回后的通知分别处理。原版 SDK 校准了 N／R 标志与隐藏关闭查询，见同一决策中的后续记录。

`Layer.drawText`／Font 已校准参数数量、无主图检查、空操作及 holdAlpha 路由，见 [056](docs/decisions/056-layer-text-semantics.md)。crossfade／universal 的 opaque 路径已采用原版定点核并保留原始 mask，见 [057](docs/decisions/057-opaque-transition-kernels.md)；Alpha／AddAlpha 核和全部时钟顺序仍有待校准。

菜单更新保留仍存在的项目节点，避免更新打断展开或点击。视频打开等待真实首帧，周期和区间事件使用媒体时钟补充呈现回调；错误历史和精度边界见 [视频首帧与时钟](docs/decisions/035-video-readiness.md)。

页面现在也支持“远程文件链接”。支持 Range 和强 ETag 的 XP3/ZIP 服务器可按需读取；小文件可在预算内完整下载。跨域配置、版本与存档身份见 [HTTP 来源](docs/decisions/016-http-sources.md)。

远程游戏分成主包、补丁和散装文件时，在“远程来源”选择“游戏目录清单（JSON）”，输入发布者提供的清单链接。下面这份 UTF-8 清单列出三个文件。

```json
{
  "version": 1,
  "files": ["data.xp3", { "path": "patch.xp3", "url": "packages/update.bin" }, "声音/主题曲.ogg"]
}
```

这里游戏看到的补丁文件名是 `patch.xp3`，服务器实际提供 `packages/update.bin`。相对链接从清单最终所在的目录解析。点击“保存当前游戏”后，游戏库会复制列出的文件，之后可从库中离线启动。[远程目录格式与验收](docs/decisions/148-remote-games-layer-options-and-midi-reset.md)

将远程游戏保存到游戏库时，如果中途断线，可重新打开页面并点游戏库里的“继续下载”。服务器需支持 Range 和强 ETag。播放器会确认文件版本，校验磁盘上已保存的块，再下载剩余部分。含本地文件的游戏需重新选择同组文件后再保存。[下载恢复与版本校验](docs/decisions/154-remote-downloads-script-cursor-and-background-audio.md)

打开含 XP3、补丁和散装资源的 ZIP 发行包时，先在“游戏位置”选择“自动识别游戏目录或 ZIP 发行包”，再选择单个 ZIP 或填写远程链接。游戏库会记住包内的游戏目录。[ZIP 发行包的使用范围与验收](docs/decisions/134-zip-distributions-midi-and-game-playback.md)

如果发行包分成 `release.zip.001`、`release.zip.002` 等文件，选中全部编号卷即可。如果文件名是 `release.z01`、`release.z02` 等，还要一起选择最后的 `release.zip`。远程来源可在同一份游戏清单中列出各卷。游戏目录内的 `data.xp3.001` 等编号主包或补丁也按同样方式读取。[分卷游戏与存档](docs/decisions/156-split-game-archives-default-font-and-midi.md)

游戏使用 `boot.tjs` 等自定义入口时，在导入前填写“入口脚本”。ZIP 自动识别会使用该入口定位游戏，避免选中发行包附带工具的 `startup.tjs`。也可以显式填写 `release.zip>目录/boot.tjs`，继续按原归档地址读取。已经存入游戏库的目录和入口优先于下次导入时的界面设置。[自定义 ZIP 入口](docs/decisions/152-legacy-movies-and-zip-entry.md)

选择本地文件夹或远程游戏清单时，即使游戏装在 `合集/Novel/` 这样的子目录，也可以将“程序所在目录”留空。若同一批文件包含两款并列的游戏，填写其中一款的程序目录，或输入能唯一识别它的程序名。自动识别与手动选择同一目录可继续使用原来的存档。[发行目录与存档](docs/decisions/149-wrapped-directories-paint-and-midi.md)

旧日文 ZIP 若显示乱码或找不到章节，在导入前将“未标记的 ZIP 文件名编码”选为“日文（Shift_JIS）”。中文发行包也可选择 GBK 或 Big5。游戏库会记住这次选择。另行导入原版存档 ZIP 时，如果来源不同，可在“存档 ZIP 文件名编码”单独选择。[旧 ZIP 文件名与存档](docs/decisions/145-zip-file-names-video-prepare-and-text.md)

如果文件名正确，但启动脚本报文字转换错误或游戏对白显示乱码，在载入前选择“无 BOM 的脚本与剧情编码”。旧汉化版常用 GBK 或 Big5，西欧语言版本可选择 Windows-1252。默认自动模式先尝试 UTF-8，再尝试 Shift_JIS。加入游戏库时会保存本次选择。

导入游戏时，把游戏 EXE、随附的 `.cf` 和原有存档目录一起选入。播放器会读取 EXE 内嵌的默认设置，再应用外部配置。资源合并在游戏 EXE 里时，即使旁边还有安装器，自动模式也能按内嵌 XP3 找到游戏。若有多个内嵌游戏，或需要为散装游戏指定哪个 EXE 的配置生效，在“游戏程序名”填入平时启动的文件名。存档目录里的同名 `.cfu` 在下次启动时生效。[原版启动配置](docs/decisions/138-game-startup-configuration.md) · [内嵌设置与旧脚本模式](docs/decisions/139-embedded-game-options-and-script-modes.md) · [多程序发行包](docs/decisions/144-combined-games-macro-values-and-audio-cues.md)

从桌面版继续游玩时，载入对应游戏，暂停后在“存档与备份”选择“原版游戏存档”，导入存档文件、目录或 ZIP，再用游戏自己的读档菜单恢复。要带回桌面版，可导出 `savedata.zip` 并解压到该游戏的存档目录。[原版存档迁移](docs/decisions/136-native-saves-scenario-loading-and-video-cues.md)

载入后可点击“保存当前游戏”，将资源保存在浏览器游戏库中。刷新或重开浏览器后，可直接从库中启动并继续使用原存档；也可修改启动设置、移除资源或取消正在进行的导入。远程来源会完整保存，之后读取游戏资源不再依赖原服务器。设计与存储限制见 [OPFS 游戏库](docs/decisions/017-game-library.md)。

生产预览或静态部署中，点击“准备离线启动”，完成后重新载入应用。应用组件与已保存的游戏库都就绪后，可在断网时重新打开并继续游戏。有新版本时会提示重新载入，当前会话先停止并提交存档；其他标签页继续运行。开发服务器不启用离线缓存。更新、子路径部署与浏览器验证边界见 [离线应用](docs/decisions/018-offline-app.md)。

显示上下文丢失时会暂时暂停游戏，恢复后重建 GPU 资源并继续；用户主动暂停的状态保留。重建失败可点击“重试显示”，也可导出存档或停止。实现和测试边界见 [图形恢复](docs/decisions/019-graphics-recovery.md)。

默认开启“切到后台时暂停”：隐藏页面时冻结脚本、计时器和媒体，返回后继续原会话。可关闭该选项以允许后台运行；浏览器冻结页面、用户主动暂停或 GPU 尚未恢复时仍保持暂停。输入清理、存档提交与实际浏览器验证见 [页面生命周期](docs/decisions/020-page-lifecycle.md)。

脚本可使用 `System.eventDisabled`、连续回调和异常处理函数；事件禁用时保留 VM，媒体时钟继续推进。队列顺序、回调身份、菜单门控和限制见 [System 事件](docs/decisions/021-system-events.md)。

`Layer.font` 已支持预渲染字形映射、字体文件、`getGlyphDrawRect` 和 `Rect` 值对象。游戏自带字体由独立 FreeType WASM 测量和栅格化，系统字体使用 Canvas；排版、映射、阴影和最终合成仍由 TypeScript/WebGL 管理。设计与兼容边界见 [字体几何与后端](docs/decisions/024-font-geometry.md)。

## 构建依赖

- Node.js `^20.19.0 || >=22.12.0`。
- Emscripten **6.0.9**：先激活 emsdk，或设置 `EMSDK`。
- CMake 3.25+、Ninja、Bison 3.8.2+、Python 3.10+。
- 可通过 `BISON_EXECUTABLE` 和 `EMSDK_PYTHON` 指定工具路径；`KRKR_BUILD_JOBS` 控制编译并发，默认 4。

构建脚本在本机还会尝试探测 `../toolchains/krkr2/` 下的工具链。其他机器应显式配置上述环境变量。TJS2、fmt、Oniguruma 与必要的 Boost 头文件已随项目固定保存；构建不依赖相邻的 kirikiroid2-web 仓库，也不要求安装 vcpkg。

完整构建为 TJS、FreeType、PNG/zlib、JPEG 和旧影片转换器分别生成带哈希的资源和清单，位于 `.generated/wasm/`、`.generated/fonts/`、`.generated/image-zlib/`、`.generated/image-jpeg/` 和 `.generated/legacy-media/`。首次构建从固定来源获取依赖，许可证随应用发布。托管工作流让专项验收和播放器使用同一组编译产物。[构建与验证](docs/testing.md)

```sh
npm run build:wasm -- asyncify  # 仅构建一种变体
npm run build:wasm -- jspi
npm run build:fonts            # 仅重建独立字体内核
npm run build                 # 检查类型并生成 dist/
npm run preview               # 预览生产构建
```

## 项目结构

```text
src/app/          页面、导入与运行记录
src/player/       播放器门面、会话装配与 RPC client
src/protocol/     跨线程协议
src/pwa/          应用缓存、版本更新与 Service Worker
src/engine/       脚本契约、KAGParser、调度、TVP、图层/菜单与资源语义
src/formats/      字节读取、XP3、PNG/GIF/BMP/TLG、WAV、MIDI、SLI 等格式
src/backends/     TJS WASM、文件、WebGL2、Canvas/FreeType 字体、音频解码、AudioWorklet 与视频宿主
src/workers/      显式会话 Worker 入口
native/           TJS WASM 桥与独立 FreeType 字体内核
third_party/      固定版本源码、原始哈希及许可证
examples/minimal/ 可直接导入的最小示例
scripts/          WASM/应用构建、发布完整性检查与测试发布包
tests/            行为、集成和真实浏览器测试
docs/             架构、已验证决策与兼容范围
```

[完整架构规划](docs/architecture.md)包含后续模块；[TJS 宿主边界决策](docs/decisions/001-tjs-host-boundary.md)说明异步调用、对象引用和停止语义。

[KAG 回调边界](docs/decisions/002-kag-effects.md)和[Layer 坐标模型](docs/decisions/003-layer-spaces.md)记录已经落地的接口设计及剩余限制。

[音频时钟与解码边界](docs/decisions/004-audio-clock.md)说明 TypeScript 混音、声音回调、按需 Vorbis WASM 及浏览器解码差异。

影片可以使用 MP4 帧索引、双图层输出、遮盖模式和媒体声音。第 142 批接入大体积本地影片的文件切片和多轨播放，游戏库文件在播放前会校验相应数据块。新增路径等待托管验证。[视频呈现与生命周期](docs/decisions/005-video-presentation.md) · [大过场影片的来源和大小限制](docs/decisions/142-large-game-movies.md)

第 152 批为 `.mpg/.mpeg`、`.mpv/.m1v` 和部分 `.avi` 增加兼容转换：支持 MPEG-1、MJPEG、Cinepak 画面及所列 MP2／PCM 音轨，在打开时转换为浏览器可播放的 H.264/AAC MP4。转换完成前需要等待，输入和输出各限 128 MiB，单次最多五分钟，可以停止。转换采用有损编码；MPEG-2、WMV 和其他 AVI 编码尚未接入。普通 MP4/WebM 沿用现有路径；新增转换与离线验收尚待托管运行。[旧影片范围](docs/decisions/152-legacy-movies-and-zip-entry.md)

[输入与焦点](docs/decisions/006-input-routing.md)说明浏览器事件、TJS 回调、图层命中/捕获、模态状态与文字输入之间的边界。

[场景与图像存档](docs/decisions/007-scene-transitions-snapshots.md)说明子树合成、内置转场、对象交换、截图、缩放、BMP 和 KAG 存读档验证。

[图像加载](docs/decisions/012-image-loading.md)说明纯 TypeScript PNG/GIF、调色板索引、伴随 mask/province、颜色键和 PNG 标签；[TLG 解码](docs/decisions/011-tlg-images.md)记录 TLG5/TLG6 与 SDS 支持。PNG 的 zlib 压缩流由 Web DecompressionStream 处理，专用格式与像素语义保留在引擎中。

[图像写出](docs/decisions/013-image-writing.md)说明 PNG/TLG5/TLG6 保存、TLG 图层类型标签、Web CompressionStream、可取消编码与独立原生/Pillow 验证。输出通过现有存档事务、备份导出和刷新恢复。

游戏启动时图像缓存关闭。脚本写入 `System.graphicCacheLimit=gcsAuto` 后使用游戏配置的上限，Web 自动档为 64 MiB。不同图层和颜色键仍使用独立的像素副本。[缓存与预加载](docs/decisions/014-image-cache.md) · [启动设置与实际容量](docs/decisions/140-game-graphics-cache.md)

[ZIP 资源](docs/decisions/015-zip-storage.md)说明 TypeScript 索引、Web 按需解压、ZIP64、Unicode 文件名、CRC 校验及 `archive>entry` 地址。文件导入支持 ZIP，游戏写入继续进入存档覆盖层。

## 验证

[完整回归 34989855109](https://github.com/fenghengzhi/krkr2-web/actions/runs/34989855109)在精确提交 `2683b304fa32e409941c84b723d80d53b5d6ac8d` 通过 **1,646 项 Node、1,095 项浏览器和 6 组直接运行时**，14 个作业全部成功；浏览器包含 972 项常规、57 项游戏库、59 项 PWA、7 项可信生命周期，零失败、取消、跳过或 flaky。[兼容检查 34991339560](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991339560)使用同一提交、同次完整回归构建，通过 **78 项原 KAG／旧 ABI 检查**。

该版本的输入 ACK、协作式原生检查点和 Window.showModal 已在 `5e54ceb` 合入 main；合入提交使用 `[skip ci]`，不另计一次验证。相比已测提交，仅增加原版 SDK 参考工作流及其夹具，已测应用和内核不变。Menu.popup 新业务、其余图形／系统 API、流式媒体与旧视频编码仍未完成；旧 VCL 二进制行为的未知项也未因 Web 测试通过而解决。历史失败与未报告证据持续保留，全部可执行验证只在 GitHub-hosted Actions 进行。

以下保留 055 阶段当时的状态与验证来源，当前结论以上文为准。

[完整回归 34955337265](https://github.com/fenghengzhi/krkr2-web/actions/runs/34955337265)在 `cf564282` 通过 **1,431 项 Node、1,041 项浏览器和 6 组直接运行时**，14个作业全部成功；浏览器包含918常规、57游戏库、59 PWA、7可信生命周期，零失败、取消、跳过或flaky。[兼容检查 34954688171](https://github.com/fenghengzhi/krkr2-web/actions/runs/34954688171)在 `c35ac758` 复用构建34952630856通过 **78 项原 KAG／旧 ABI 检查**；到当前提交，应用及内核源码不变，仅文档与runner诊断改变，两个构建的来源分别保留。

052的输入ACK、原生检查点与Window.showModal仍在独立分支验收，尚未纳入这里的已验证版本。菜单嵌套、其他图形／系统API、流式媒体与旧视频编码仍未完成。此前V8、WebKit及Xvfb故障证据保留；本次全绿不证明其根因已修复。全部可执行验证只在GitHub-hosted Actions进行。

以下保留051及更早阶段的验证历史。

[完整回归 34945014092](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945014092)在 `3ef7f09` 通过 **1,317 项 Node、1,041 项浏览器和 6 组直接运行时**；浏览器包含 918 项常规、57 项游戏库、59 项 PWA、7 项可信生命周期。[兼容检查 34945755032](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945755032)使用同一提交、同次构建通过 **78 项原 KAG／旧 ABI 检查**，三浏览器各 26 项。

各轮失败与未报告案例继续保留；本轮通过不证明历史 V8 断言或 WebGL context loss 的根因已修复。Window.showModal、菜单嵌套事件循环、其余图形／系统 API、流式媒体及旧视频编码仍在实现，完整非插件目标尚未完成。 详细记录见[051](docs/decisions/051-multiwindow.md)。全部可执行验证仅在 GitHub-hosted Actions 进行。

以下保留此前阶段验证记录。

测试统一由 GitHub-hosted [GitHub Actions](.github/workflows/test.yml) 执行，不在本机运行测试。阶段 050 的[完整回归 34931803098](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931803098)在 `f1f6a3d` 通过全部 14 个作业：1,118 项 Node、846 项浏览器测试（723 项常规、57 项游戏库、59 项 PWA、7 项原生生命周期）及 6 项直接运行时专项；失败、取消、跳过、flaky 和重试均为 0，最大重试次数为 0。该轮同时验证 047、049 和 050；总数已包含 18 项观察器内调用 Stop 的浏览器场景，以及 32 项编码器内部取消检查点的 Node 场景。

[KAG／旧 ABI 兼容检查 34931188627](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931188627)另通过 78 项，每种浏览器 26 项，使用 `54ecd16` 的[构建 34931093453](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931093453)。`54ecd16` 到 `f1f6a3d` 没有应用路径差异，因此这是相同应用源码的兼容证据，并非最终完整回归的同次构建。

历史失败继续保留。046 [首次完整回归 34929264074](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929264074)有 19 项浏览器失败：18 项旧夹具依赖 primary 默认颜色，另 1 项 PNG 停止点击晚于编码完成；050 分别验证按钮调用顺序与编码器取消，不把后续绿色重跑当作原时序已修复的证明。047 [完整回归 34930203580](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930203580)为 821／822 项浏览器通过，另 1 项 WebKit JSPI 启动报 `Page crashed`。[诊断 34931403366](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931403366)在 `9f4bdc4` 复用该失败轮的精确构建，原 player 用例重复 20 次均通过；原生报告清单为 `reports: []`、`errors: []`，没有确定或修复崩溃根因。

049 [完整回归 34931093453](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931093453)最终失败：Node 已报告 1,068 项通过，1 个文件 SIGTRAP 失败，另 19 项未报告；浏览器为 842／846，失败涉及 Chromium 复制正对照，以及 WebKit 暂停视频 1.228 ms 漂移、player 重启和 Scripts JSPI 初始化 SyntaxError；直接运行时 6 项通过。050 [首轮完整回归 34931476851](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931476851)在 `65c7e16` 为 845／846 项浏览器通过，旧复制正对照的 Asyncify 字节码场景期望 `1,0`、实际 `0,1`。包含修正后正对照的 `f1f6a3d` 完整通过；完整失败记录分别保存在 [047](docs/decisions/047-window-main-instance.md)、[049](docs/decisions/049-piled-copy-empty-region.md)和 [050](docs/decisions/050-image-save-cancellation.md) 决策中。

[046 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930172005)的 1,043 项 Node、786 项浏览器和 6 项直接运行时，以及[相同应用源码的 78 项兼容检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929350970)继续保留。[045 完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927280464)的 1,019 项 Node、750 项浏览器和 6 项直接运行时，以及同次构建的 [78 项兼容检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34927347461)也作为历史证据保留。[此前双后端分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34895417115)通过 1,061 次执行、188 次字节码、20 次对象清理、600 次观察/升级/销毁及 24 次从属对象分配失败；历史失败与未定位问题继续保留。推送代码、更新 PR 或手动触发 Tests 工作流后，云端构建两种 TJS WASM 和字体内核，并运行 Node、三浏览器、游戏库、PWA、原生生命周期及直接运行时探测。

Tests 工作流各测试作业使用同次构建产物，独立兼容检查使用上文注明的构建。日志、JSON 报告、失败截图与 trace 可从 Actions 下载。操作方式、原 KAG/旧 ABI 专项与历史记录见 [测试说明](docs/testing.md)。

## 来源

参考了 kirikiroid2-web 的 TJS2 和引擎接口，将引擎语义与 Web 平台后端重新划分。第三方版本、修改记录和许可证见 [third_party/README.md](third_party/README.md)。当前测试未覆盖原引擎全 API 或商业游戏集合。

当前完整非插件实现目标及未完成项见 [实现进度](docs/non-plugin-progress.md)。

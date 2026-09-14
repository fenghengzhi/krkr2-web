# 字体枚举与选择

`Layer.font.getList(flags)` 枚举游戏文件字体、已授权的本机字体和浏览器通用家族。`doUserSelect(flags, caption, prompt, sample)` 打开主线程 HTML 对话框，挂起当前 TJS 调用；确定返回 true，取消返回 false。确定只改变 face 并清除 faceIsFileName，保留高度、字重、斜体、装饰线与角度。两个接口分别要求至少 1 和 4 个参数，flags 按无符号 32 位转换。

参考接口见 [getList](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font_getList.html) 和 [doUserSelect](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font_doUserSelect.html)。参考移植仓库的选择调用目前被禁用，不能把固定返回值当作完整实现。原 Windows 路径把 Font.Face 以引用传入选择器，作为只修改家族的依据。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `formats/font/metadata.ts` | 有界读取 SFNT name/post/OS2/head/cmap，识别家族、样式和筛选元数据 |
| `engine/graphics/font-catalog.ts` | 资源发现、缓存、家族绑定、筛选和去重 |
| `engine/graphics/font-selection.ts` | 请求身份、候选快照、确认/取消与过期结果检查 |
| `engine/graphics/fonts.ts` | 选择物理文件，管理面缓存，顺序执行度量/绘制/边界查询 |
| `engine/ports/fonts.ts` | 与浏览器无关的字体描述、选择请求和预览像素 |
| `backends/text/browser/local-fonts.ts` | 点击触发 Local Font Access，读取元数据和处理取消 |
| `app/game-fonts.ts` | HTML dialog、键盘交互、预览、本机字体入口与停止按钮 |

枚举、筛选、交互和资源选择采用 TypeScript/Web API。游戏字形仍由独立 FreeType WASM 生成，系统字形由 Canvas 生成。TJS ABI **2**、字体 ABI **1** 不变，会话协议升到 **8**，增加字体请求、候选刷新与预览 RPC。

## 筛选与家族绑定

FixedPitch 要求已知等宽，SameCharSet 按当前字体字符集匹配，NoVertical 排除纵排名称，TrueTypeOnly 接受 TrueType/OpenType 轮廓，IgnoreSymbol 排除符号字符集。先筛选，再按家族名称去重，保留发现顺序。UseFontFace 不影响 getList；对话框中它让列表名称使用对应字体绘制。游戏字体列表项与样本文字都使用真实引擎字形像素。

游戏目录发现 ttf/otf/ttc；当前 faceIsFileName 指定的资源也加入，即使扩展名不同。归档限定名称和普通名称按不可变资源身份去重，普通名称优先，避免旧归档别名覆盖补丁。家族可绑定普通、粗体、斜体和粗斜体文件；优先匹配斜体，再匹配字重。使用物理粗体/斜体时不重复施加对应的合成样式；直接按文件名加载保留此前文件路径语义。

枚举返回的游戏家族名可以赋给 face 使用。家族绑定在枚举或选择准备时建立，不代表任意未枚举游戏家族都已自动注册。混合游戏/系统字体的逗号回退列表尚未完整解析。

通用 sans-serif、serif、monospace 是逻辑 Unicode 家族，不能据此认定底层物理字体格式，所以不通过 TrueTypeOnly；monospace 通过等宽筛选。CSS 通用名保持不加引号，普通名称转义后引用，避免把 monospace 意外变成不存在的普通家族。

字符集由 OS/2 code-page bits 与 cmap 平台编码推导。Unicode cmap 额外记录 unicode 标记，纯符号字体除外；当前文件字体优先使用推导出的首个数字字符集。该策略不等于 Windows EnumFontFamiliesEx 对任意字体/区域设置返回的首个字符集。无法确认的等宽、轮廓或字符集属性保持未知。

## 浏览器交互与生命周期

本机枚举只在用户点击“读取本机字体”时调用 Window 的 queryLocalFonts，受安全上下文、用户激活和浏览器权限限制；不可用时继续提供游戏字体和通用家族。依据见 [Local Font Access](https://wicg.github.io/local-font-access/)。字体字节只在主线程读取元数据，不上传，也不传入 Worker；已授权描述保存在当前页面内存，刷新后不自动重新枚举。

权限拒绝可以重试；关闭或停止会取消等待，迟到的权限结果和预览不能更新新对话框。请求 id 加 revision 支持候选更新；引擎拒绝旧 id 或候选外名称。脚本标题、提示和名称使用 textContent，不解释 HTML。对话框支持方向键、Home/End、Enter、Escape，使用 HTML 模态焦点约束，关闭后恢复焦点。选择期间游戏输入和菜单快捷键均被门控。

启动脚本在 Window 尚不可见时也可选择字体；对话框内的“停止游戏”能结束挂起的 VM。页面隐藏时不接受确认；取消可以关闭 UI，但 TJS 继续执行仍等待原有暂停门控。停止取消正在等待的资源/字形加载并释放面对象。

预览 RPC 不进入正等待用户选择的 TJS 队列，否则会互相等待。字体服务另有顺序执行队列，覆盖完整的度量、字形生成与边界查询：即使旧预览尚在完成，脚本文字操作也不会同时加载或淘汰其正在使用的面。

当前选择调用挂起期间，其他 TJS 回调继续受会话队列约束；本阶段没有复刻 Windows 原生模态消息循环中的全部回调重入行为。

## 预算与范围

游戏目录最多发现 128 个不同字体资源，单资源不超过 16 MiB；元数据按资源身份缓存，损坏的非必需字体跳过并只记录一次。资源端口返回完整文件，所以游戏目录的首次发现仍需读取这些文件。本机 Blob 元数据解析按区间读取，不扫描轮廓；元数据累计读取上限 1 MiB，容器上限 64 MiB，name 表上限 256 KiB，目录项/名称记录/编码记录均有边界限制。

本机接口最多接受 16,384 个面和 2,048 个家族，常规样式优先作为筛选元数据来源。样本显示前 256 个 UTF-16 单元，预览字高最多 64，样本画布宽 640；标题、提示和样本输入各最多 8,192 单元。原有字体缓存、WASM 内存与文字组合预算仍生效。

支持 Unicode name 记录和 Mac Roman 名称；TTC 只读取第一个 face，与当前文件加载保持一致。多 face 选择、variable font 轴、旧 charmap 转换、全部 name 语言记录、原生字体缓存生命周期和 Windows 字体替换仍未完成。带 @ 的家族可枚举，但它本身不证明完整纵排或 ruby 布局。

## 验证

`font-selection-native.py` 抽取原 TVPFSFEnumFontsProc，以 ASan/UBSan 编译并输入受控 Win32 元数据，生成 256 组 flags × charset 参考结果。它验证筛选顺序、TrueType/OpenType、符号字体、纵排和筛选后去重，不验证真实 GDI 枚举或 Web 字符集推导。固定结果随 Node 测试运行，普通测试不依赖参考仓库或 Clang。

项目自有 fixture 包括常规、粗体、等宽、符号、Mac Roman、未知 pitch 和双面集合。粗体 A 的步进特意设为 900/1000 em，20px 下应为 18px；常规体为 10px，能够区分错误文件匹配与重复合成加粗。浏览器测试检查实际像素、宽度、两套 TJS 后端、取消/停止、权限拒绝与迟到结果、窄屏及快捷键隔离。现有 6 个字体离线冷启动案例还在服务器关闭、新浏览器进程中打开选择器并确认游戏家族。

独立 Chromium 原生 Local Font Access 探测在隔离 context 中授予 local-fonts 权限，实际枚举到 170 个符合条件的家族，并完成预览与选择。报告只保留数量和结果，不保留字体清单或字节；它不验证人工权限提示框。拒绝、重试与迟到结果由三浏览器受控接口测试覆盖。

完整 `npm run check` 通过 **301 项行为/集成与 522 项浏览器测试**：417 常规、57 游戏库、41 PWA、7 原生生命周期。新增 11 项 Node 和 27 项浏览器测试，既有 6 个字体离线冷启动案例增加选择器检查。所选案例无失败或跳过，既有并发、超时、PWA 排除项与 trace 配置保持不变；真实冻结持续时间仍须超过 21 秒。

本轮原生 freeze/resume 事件均为 trusted，测得间隔为 21,053.9 ms。上一阶段修正的 fixture 准备预算与正文预算继续保留。

同一构建另通过 **36 个外部 KAG 场景**（XP3/ZIP × 三浏览器 × 两后端 × 对话/存读档/转场）和 **6 个跨 ABI 离线更新场景**，检查旧、新 Worker 在服务器关闭后分别重建并运行。原 TJS 与字体 WASM 产物保持不变。

阶段材料存放在 `out/verification/font-selection/`，源码、测试、文档、配置、发布产物与证据哈希由 `out/verification/font-selection-matrix.json` 汇总。前一阶段 `font-geometry-matrix.json` 保留其原始源码和发布身份。完整非插件目标仍在进行。

元数据依据：[name](https://learn.microsoft.com/en-us/typography/opentype/spec/name)、[post](https://learn.microsoft.com/en-us/typography/opentype/spec/post)、[OS/2](https://learn.microsoft.com/en-us/typography/opentype/spec/os2)、[cmap](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap)、[Mac Roman](https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/ROMAN.TXT)。

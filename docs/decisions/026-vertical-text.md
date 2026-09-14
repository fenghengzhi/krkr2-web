# 纵排字形、ruby 与纵中横

原 KAG MessageLayer 已处理 ruby 的位置、字距、禁则、换列和纵中横。运行时需要正确提供字体度量与字形；不能再把 `@` 家族当成普通家族直接旋转全部文字。本阶段保留原 KAG 排版代码，补齐 Web 字体后端的纵排路径。

## 字形选择与朝向

`@` 前缀表示纵排家族，`angle=2700` 表示从上到下推进。Unicode 17.0.0 的 BMP Vertical_Orientation 数据决定没有替代字形时的朝向：U/Tu 保持直立，R/Tr 侧向；可用的纵排替代字形保持直立。仍按 KRKR 的 UTF-16 单元处理文字，没有把脚本控制的逐字绘制替换成整段 HarfBuzz 排版。

游戏文件字体由 TypeScript 读取 GSUB，优先选择 FeatureList 中首个 vrt2，否则使用首个 vert，保持 GDI 路径的家族级选择方式。支持单字形替换的两种格式、两种 coverage，以及指向单字形替换的 extension lookup；每个 lookup 使用第一个匹配的 subtable，再继续后续 lookup。不存在 GSUB 替换时，若字体提供对应 Unicode 纵排呈现字形，则使用它；否则采用朝向数据的回退规则。

选中的 GSUB lookup 若使用尚未支持的 flags（不影响单字形替换的 RTL 位除外）、上下文替换或 mark filtering，请求纵排时明确报错，普通横排仍可使用该字体。variable font 的条件替换未读取，当前只使用默认 feature 数据。不能将当前覆盖视为完整 OpenType shaping 或原生 GDI 的全部行为。

系统 Canvas 字体保留汉字直立、拉丁字母侧向，并使用 Unicode 纵排呈现形式作为标点回退。浏览器没有向 Canvas 暴露任意系统字体的 GSUB 与竖排度量，此路径无法等同于指定 Windows 字体的原生竖排结果；其字形和度量仍受浏览器与系统影响。游戏文件字体使用可检验的实际字形索引和 FreeType 度量。

## 实现边界

| 路径 | 职责 |
| --- | --- |
| `formats/font/vertical-data.ts` | 从 Unicode 数据生成的 163 段 BMP 朝向区间和 28 个呈现形式回退 |
| `formats/font/vertical-substitutions.ts` | 有界读取 SFNT/TTC 的 GSUB，编译为独立的字形索引数组 |
| `engine/graphics/vertical.ts` | 逻辑纵排家族、Unicode 朝向和呈现形式选择 |
| `backends/text/freetype/face.ts` | 按索引选择字形、建立竖排坐标、旋转与装饰线计划 |
| `native/fonts/font.c` | 按索引读取度量，将轮廓及装饰矩形变换后栅格化，复制输出覆盖值 |
| `backends/text/browser/graphics.ts` | 系统字体朝向与回退、文件缺字回退、多字形 Canvas 合成 |

没有加入 HarfBuzz 运行时依赖；它仅用于独立参考数据生成。字体原生内核仍是独立 FreeType 模块。新增按索引查询和变换接口使**字体 ABI 从 1 升至 2**；TJS ABI **2**、会话协议 **8** 保持不变。

家族绑定转换成内部字体句柄时保留逻辑纵排属性。即使元数据没有 vhea/vmtx，显式 `@` 家族也能找到相应游戏文件字体，并使用 FreeType 合成的竖排度量。字体选择窗口的预览明确采用横排，不受名称前缀影响。

普通文件名路径的角度行为继续遵循此前验证的 FreeType 路径；预渲染字形也保留其已有位图与位移。新的纵排逻辑只处理逻辑纵排家族，不会再次旋转预渲染覆盖值。边界查询仍忽略 angle，但保留纵排家族本身的字形形态和朝向。

## 坐标、所有权与预算

竖排字形使用竖向 bearing/advance；侧向字形使用水平 advance。vrt2 已旋转的拉丁字形不会再被旋转一次。TypeScript 生成 16.16 单位旋转矩阵、26.6 平移与最多两个装饰矩形，FreeType 对实际轮廓变换后栅格化。下划线和删除线跟随文字推进方向，支持单色与抗锯齿。

GSUB 最大 2 MiB，最多 128 个选中 lookup、每个 64 个 subtable、累计 256 个 subtable 和 262,144 个 coverage 条目。编译对象只保留复制后的索引数组，不通过闭包保留原字体 ArrayBuffer。损坏的竖排布局不会阻止已经可用的横排字体。

变换命令验证单位旋转矩阵、整数范围、矩形方向和数量；平移与装饰矩形限制在 16,384 像素内，字形仍受 4096×4096 与坐标预算限制。原有单字体 16 MiB、32 个上层驻留文件/32 MiB 文件字节、64 个底层面与 128 MiB WASM 堆限制继续有效。FreeType 内部内存与浏览器内存的统一预留仍未完成。

Unicode 原始数据和许可保存在 `third_party/unicode/`，许可随应用放入 `public/licenses/unicode/`。生成脚本为 `generate-vertical-data.py`；这些纯 TS 数据不属于 TJS 二进制输入，`build:wasm` 的源码身份计算排除了该目录。

## 验证范围

项目自有七个不对称字体覆盖 vert、vrt2、无 GSUB、extension、连续 coverage、多个 subtable 和无竖排度量表。独立 uharfbuzz **0.56.1** / HarfBuzz **14.4.0** 生成 **56** 组选择结果，分别记录纯 GSUB 与完整竖排回退结果；它不提供 KRKR 的坐标锚点，也不能证明 Windows GDI 像素一致。

Node 检查全部 65,536 个 BMP 朝向、替代字形、形态选择、字距、下划线/删除线、四个主方向、非法布局隔离与无竖排度量的游戏家族。旧的 512 组独立 FreeType 度量/覆盖参考继续验证普通字体路径。

生产 C 内核另外在本机以 ASan/UBSan 编译，使用有/无竖排度量的字体完成 **33,792** 组字形、样式、角度、空字形和装饰矩形检查，并验证非法命令后的恢复。链接的独立 FreeType 库本身没有 sanitizer 插桩；该压力检查也不是独立渲染 oracle。

浏览器专项检查已通过三浏览器的文件字体原点/标点、系统字体朝向与既有字体选择案例；6 个新 PWA 案例在关闭服务器并重启整个浏览器后首次加载竖排字体。原 KAG 探测记录绘制参数、导出位图与截图，检查横排 ruby、纵排 ruby、纵中横、禁则换列和复制恢复；复制恢复要求 BMP 全部字节一致。修正旧字体离线缓存路由后，完整 `npm run check` 再次通过 **308 项行为/集成与 537 项浏览器测试**（426 常规、57 游戏库、47 PWA、7 原生生命周期），无失败、跳过或重试通过。原生 freeze/resume 均为 trusted，实际冻结 **21,054.1 ms**。最终构建另通过 **36 项原 KAG 场景、18 项文字排版场景、6 项 TJS ABI 1→2 和 6 项字体 ABI 1→2 离线升级检查**。跨 ABI 探测在服务器关闭后分别重建旧、新 Worker，字体探测还检查实际内核请求和字形像素；每次启动使用独立完成标记。完整日志、源码、构建及独立参考的哈希汇总在 `out/verification/text-layout-matrix.json`。

## 诊断记录与未完成项

最初的系统字体测试证实 `@` 被丢弃后汉字整体旋转；修正后直立汉字的覆盖与横排一致。拉丁字形的 Canvas 旋转 hinting 并不是横排位图的简单转置，因此其参考使用同一浏览器实际旋转的普通家族，逐字节比较覆盖，未放宽像素容差。

HarfBuzz 参考还指出了无 GSUB 时可用的呈现形式回退，已补入文件路径。KAG 换列首次测试的固定预期忽略了 `initLineLayer/resetLineSize` 把初始保留的 24px 行尺寸缩为当前 20px 的行为；修正后的列坐标按原脚本公式核实，仍做精确比较。

字体 ABI 1→2 的独立离线升级探测发现，Service Worker 查找旧完整缓存时只考虑 `assets/` 和 `wasm/`，遗漏了 `fonts/`。旧标签页重建 Worker 会因此无法读取已缓存的旧字体清单。已将字体发布文件纳入旧版本依赖查找，并扩展缓存回归检查旧字体清单、模块和 WASM；资源仍须存在于完整发布清单中，游戏字体及未知请求继续交给原请求路径。修复前的失败日志和浏览器 trace 保存在 `out/verification/text-layout/before-cache-fix/`。

探测脚本的修正包括 TJS 不捕获外层局部变量、Blob Worker 的模块 URL 必须完整，以及使用真实 `Conductor.stop()`。Prettier 3.9.6 的 TypeScript parser 在该探测文件中重复输出尾部代码，已保留最小输入/输出证据，并对该文件配置 babel-ts parser；这不涉及引擎运行时变更。

调试异常路径还发现 `Debug.logAsError()` 未实现。它是文件日志输出开关，不能以错误等级消息别名或空方法代替，需由后续完整日志模块处理。Windows 字体替换和所有 GDI 度量/栅格差分、复杂 GSUB/variable fonts、完整字体集合、多码元组合、全部字符集与所有文字混合组合仍未完成，完整非插件目标继续进行。

依据：[KRKR Font.angle](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font_angle.html)、[KAG 标签](https://krkrz.github.io/krkr2doc/kag3doc/contents/Tags.html#ruby)、[Unicode UAX #50](https://www.unicode.org/reports/tr50/)、[OpenType 竖排功能](https://learn.microsoft.com/en-us/typography/opentype/spec/features_uz)、[HarfBuzz](https://harfbuzz.github.io/glyphs-and-rendering.html)。GDI 风格 feature 选择的参考实现及哈希保存在验证目录中的 Wine 源码副本；本项目未使用 Wine 代码作为运行时实现。

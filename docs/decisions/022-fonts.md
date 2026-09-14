# 预渲染字体与 Worker 字体文件

本文记录首次字体接入阶段。后续实测发现浏览器字体边界与原生结果不同，生产字体文件路径已由 [024：字体几何与后端](024-font-geometry.md) 中的独立 FreeType WASM 替代；下文的 Worker FontFace、未新增 WASM 和待实现 Rect 描述属于当时状态。映射、阴影与光标观察的设计继续有效。

字体能力继续按 Web 优先实现：TypeScript 解析预渲染字形、管理映射与排版，Worker 的 CSS Font Loading API 加载字体文件，现有 WebGL2 管线呈现最终像素。没有新增字体 WASM 或加载字体插件。

## 接口与职责

- `formats/font/prerendered.ts` 解析 KRKR 预渲染版本 0/1、UTF-16 字符索引、20 字节字形记录和 65 级覆盖值。
- `engine/graphics/fonts.ts` 管理会话共享映射、不可变资源身份、字体文件驻留、字宽和逐字形绘制计划。
- `engine/graphics/glyph.ts` 完成覆盖值着色及整数权重阴影；阴影先于所有前景字形绘制，沿用图层的 drawFace、opacity 和 holdAlpha。
- `backends/text/browser/graphics.ts` 用 `FontFace` 加载资源字节并注册到 Worker 的 `fonts`。内部 CSS 家族名独立分配，测量和栅格画布复用，停止或淘汰时删除注册。
- `Layer.font` 增加 `mapPrerenderedFont(storage)`、`unmapPrerenderedFont()` 和参考移植中的 `faceIsFileName`。高度赋值取绝对值，角度归一到 0–3599，样式标志转为布尔值。

`Font` 在 KRKR2 文档中是由 Layer.font 提供的对象，不开放普通 Font 构造函数。字体加载通过 `font.face="fonts/name.ttf";font.faceIsFileName=true;` 在测量/绘制前完成；没有把 addFont.dll 纳入非插件范围。

## 映射和字形

映射键包括名称、高度、角度和全部字体标志。映射作用于会话中所有设置相同的图层；修改设置会选择另一映射，恢复设置可重新使用原映射。显式解除映射也对其他匹配图层生效。读取或解析新映射失败时保留旧映射。

文件头签名由 `TVP pre-rendered font` 与 0x1a 组成，共 22 字节，不包含 C 字符串尾零；紧接版本和字符宽度。版本 0 使用 0x41 加长度重复前一个像素，版本 1 使用大于等于 0x41 的单字节运行长度。覆盖值 0–64 放大四倍，64 饱和为 255。索引、重复字符、表格重叠、数据范围、首像素运行和跨位图运行均检查后使用。

测量使用文件的标量 Inc，绘制使用 IncX/IncY，不能用测量宽度替代绘制位移。字形原点结合后端字体 ascent 和绘制角度计算；预渲染位图已经对应映射设置，不再旋转一次。IncY 符号按原生半圈规则调整，缺字逐个交给后端字体。预渲染覆盖值在 aa=false 时仍保留，与所读取的原生路径一致。

普通字体也按 UTF-16 字符单元累加整数字宽并逐字形绘制，避免把浏览器整串 kerning/shaping 的字宽和原生逐字符位移混用。浏览器栅格化、hinting、默认字体和 ascent 仍可能与原生系统字体不同，不能因此声称所有字体像素一致。

## 生命周期与预算

字体映射用解析完成的字形快照。当前资源版本由不可变资源身份区分；显式重映射新版本会读取新字节。原生按路径和延迟引用释放的缓存生命周期还有差分工作，尚未覆盖全部修改源文件/多个旧图层持有字体的排列。

字体文件加载在异步宿主调用中完成，返回 TJS 前仍经过原有暂停门。停止会取消等待；晚到或恰好同时完成的字体加载只释放一次，不重新进入脚本。缓存按资源身份去重，以最近使用顺序淘汰；完整会话停止清除所有注册和映射。

取消使用可移除的等待者，不让已完成的结果挂在共享的未决 Promise 上。独立 V8 GC 探测确认，64 次合成字体加载后，已淘汰的 32 个对象在会话停止前可回收，仍驻留的 32 个对象保持存活；这验证 JavaScript 引用所有权，不测量浏览器字体解析器的内部内存。

预算分别为：预渲染文件 32 MiB、解码覆盖与索引估算 64 MiB（每个字形另计 128 字节）、最多 4096 个映射；单个浏览器字体文件 16 MiB、驻留文件字节 32 MiB/最多 32 项；单次文字 8192 个 UTF-16 单元、栅格 64 MiB、组合与单字形阴影各最多约 6400 万像素操作。字形最大 2048×2048；字体高度仍为 1–256，阴影半径最多 64。浏览器 FontFace 内部的解码内存不等同于这些资源字节预算，统一内存预留仍未完成。

解析、字形着色、阴影和多字形提交包含合作式让出点。单个浏览器字体解析和单次基础位图组合仍不是逐指令可抢占；停止的 Worker 兜底机制保留。

## 光标观察修复

物理位置通过独立 `pointerState` RPC 通知 Worker，不排在等待 TJS 的输入包后面；脚本事件包稍后派发时也不覆盖已观察到的新位置。`Layer.cursorX/cursorY` 再按当前窗口缩放、图层偏移和层级转换坐标。隐藏、暂停或已停止的会话不接受新物理位置，触摸的鼠标兼容位置使用原有主触点合成包。脚本 postInputEvent 不改变物理位置。

上一阶段文档把这项查询误写为 Window.cursorX/cursorY，实际接口属于 Layer。此次跨线程协议升级为 **7**；WASM ABI 仍为 **2**，没有重编译解释器。

## 验证依据与未完成项

`generate-font-fixtures.py` 用独立 Python 编码器和 FontTools 生成两种预渲染版本及两套不同字宽的合成 TTF，不复制外部字体字形。`fonts-native.py` 抽取参考 Find、Retrieve、覆盖值扩展和整数阴影函数，以 ASan/UBSan 编译：12 个字形解码和 60 组阴影输出（30 个独立参数组合）作为逐字节对照。该驱动仅提供头部指针和合成输入，不代表完整原生字体系统。

引擎测试覆盖共享/解除/设置恢复、失败替换、原点/位移/旋转、缺字、AA、字体身份和版本、缓存淘汰、大小检查和取消竞态。三浏览器双后端检查实际 Worker 字体加载、字宽、预渲染绘制、BMP 回读和被阻塞输入旁的物理位置；独立画布探测在 1:1 CSS 尺寸下采样实际截图像素，排除页面放大对单像素字形的重采样。完整回归和外部 KAG 的结果由本阶段验证矩阵记录。

尚未完成字体选择对话框、系统字体的完整枚举和筛选、getGlyphDrawRect/Rect 的完整对象语义、字体缓存全部原生生命周期、复杂字体集合/多 face 选择、完整 KAG ruby/纵排及所有原生字体栅格差分。已验证的覆盖值和阴影不能代替最终文字混合在所有 drawFace/opacity/holdAlpha 组合下的原生对照；任意角度的浮点取整边界也还需要独立几何对照。流式媒体、其他窗口/IME 与剩余非插件功能继续进行。

依据：[KRKR2 Font](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font.html)、[全图层预渲染映射](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font_mapPrerenderedFont.html)、[CSS Font Loading](https://drafts.csswg.org/css-font-loading/#font-face-source)。具体参考源文件及抽取哈希保存在 `tests/fixtures/font/native.json`，包括 PrerenderedFont、LayerBitmapImpl、CharacterData 和标量混合函数相关实现；仅抽取到的函数进入 oracle。

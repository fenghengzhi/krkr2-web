# Rect、字体几何与独立 FreeType 后端

游戏文件字体现在使用独立 FreeType WASM；系统字体仍由 Canvas 提供。TypeScript 保留资源、缓存、UTF-16 排版、预渲染映射、阴影、装饰线和图层合成。这落实了架构中“测得度量差异时增加精确字体后端”的边界，没有把原生窗口或整个旧引擎带入浏览器。

## 实测依据

相同合成 TTF、20px 高度下，`AV` 的 Canvas TextMetrics 在 Chromium、Firefox、WebKit 分别给出不同的外框；扫描实际字形像素又出现原生 FreeType 没有的边缘覆盖值。原始结果保存在 `out/verification/font-geometry/browser-glyphs.json`。这些差异会改变脚本查询结果，不能仅用截图容差掩盖。

`native/fonts/font.c` 只处理 FreeType 面对象、度量和灰度覆盖。独立 ABI 为 **1**，当前使用 Emscripten **6.0.9** 的 FreeType **2.14.3** 端口；TJS WASM ABI **2** 和会话协议 **7** 保持不变。模块首次使用文件字体时加载，所有文件字体共享该会话的内核实例。

端口提供的 FreeType Project License、上游许可说明及署名一同复制到 `public/licenses/freetype/`，并包含在离线发布中。`build:wasm` 会继续构建字体模块，`build:fonts` 可单独重建；两者的源码哈希与资源清单分离，字体改动不改变 TJS 二进制身份。字体清单、模块和 WASM 均使用哈希文件名，构建验证文件长度/SHA-256，运行时再次校验 WASM。部署时应保留完整 `dist/`。

## 脚本接口

`Rect` 实现构造、复制、LTRB/宽高属性，以及 `clear/set/setSize/setOffset/addOffset/clip/union/intersects/included/includedPos/equal/isEmpty`。失败的裁剪保留原矩形；`union` 对空或倒置输入仍取端点极值；`included` 判断当前矩形是否包含在参数矩形中。坐标按有符号 32 位整数转换。对象参数的空值、错误类型和参数个数分别处理。

这是 TJS 值对象，内部脚本字段仍可见，并不提供 NativeInstanceSupport 身份或不透明原生存储。`nativeArray` 明确报告需要原生插件指针 ABI；插件指针桥仍在当前范围之外。

`Layer.font.getGlyphDrawRect(text)` 返回新的 Rect。该查询不使用预渲染映射，也不按 `angle` 旋转；按 UTF-16 单元水平累积后端度量，包括嵌入 NUL。首个字符的矩形即使为空也保留其锚点，之后的空矩形不参与并集。测宽与绘制各自保留原有终止和步进规则，不能把三个操作统一成浏览器整串 `measureText`。

## 字形与回退

文件字体的普通/粗体/斜体、抗锯齿和单色覆盖使用 FreeType；下划线、删除线按参考 CharacterData 行扩展语义在 TypeScript 中生成。边界查询使用原生度量公式，因此不保证边界恰好等于最终非零像素外框。

角度公式按参考原表达式计算，再向零截断；先前代数等价写法在 25,200 组输入中的 20 组产生了整数边界偏差，已修正。预渲染位图使用 ascent X/Y 偏移。文件字体按参考 **FreeType** 路径保持字形位图朝向，只改变水平 ascent 偏移和字符步进向量；这不等于 Windows GDI 的旋转字体行为，也不证明完整纵排。

自带字体缺少普通 BMP 字符时，绘制交给浏览器 sans-serif；空白、代理码元及非字符继续使用文件字体的默认空格/首字形。代理码元和非字符的浏览器回退限制用于避免生成替代字形，并未复刻任意原生 fallback 字库中的特殊映射。边界查询采用文件字体默认字形，测宽的缺字分支保留高度回退，所以缺字的测量、边界和绘制位移可能不同。系统 fallback 的字形、基线和 hinting 依赖浏览器与系统，不宣称跨平台精确一致。

## 所有权、取消和预算

内核保存字体字节副本；返回覆盖值立即复制到 JS，不持有 WASM scratch buffer 或内存增长前的旧视图。字体家族身份独立分配；淘汰释放面对象，停止释放所有面、scratch buffer 和 FreeType 库。等待加载期间停止时，不再注册迟到字体，内核只释放一次；独立 Canvas 后端也管理自己的 FontFace 注册。

字体网络加载关联会话取消信号；失败后可重试。WASM 实例化和单次 FreeType 栅格化本身不提供逐指令取消，保留 Worker 停止兜底。实例最大内存 128 MiB、最多 64 个底层面；上层仍限制 32 个驻留文件/32 MiB 文件字节、单文件 16 MiB。字高 1–256，原生文件字形最大 4096×4096（预渲染字形仍为 2048×2048），原点/位移限于约 1600 万，绘制与查询保留每次 8192 单元及扫描/组合预算。FreeType 内部内存与浏览器原生内存尚未纳入统一预留。

## 验证与复现

`font-geometry-native.py` 抽取原生矩形和坐标函数，产生 337 对矩形、25,200 组坐标，以 ASan/UBSan 编译运行；后者也在三个浏览器 Worker 中检查。脚本对象参数/生命周期由真正的 TJS 会话测试，不能把纯矩形算术覆盖误作完整原生对象覆盖。

`generate-font-geometry-fixtures.py` 创建项目自有曲线、斜线、负伸出和正 bearing 的 TTF。`freetype-native.py` 抽取 KRKR 的槽加载、度量、字形转换、CharacterData 构造和装饰线函数，链接独立本机 FreeType，生成 **512** 组高度 × 样式 × AA × 字符组合。生产 WASM 的度量、步进、位图原点和每个覆盖字节逐项对照；原生驱动启用 ASan/UBSan，预编译库本身不受该驱动的 sanitizer 覆盖。

独立库使用与生产端口相同的 2.14.3 源码，用本机 CMake/Clang 编译。初期使用的 2.13.2 在 512 组中的 68 组单色覆盖值上不同，度量和位图尺寸相同；原始结果与差异记录保留于验证目录。这不能作为任意 FreeType 版本像素一致的证据。固定 fixture 可直接随 `npm test` 运行，不要求普通测试用户具备参考仓库、Python FontTools 或本机 FreeType。重新生成时须配置参考库路径 `KRKR_REFERENCE_FREETYPE` 与头文件路径 `KRKR_FREETYPE_INCLUDE`，参考源文件路径/哈希和库哈希写入 fixture。

浏览器检查还覆盖真实 Worker 文件字体加载、缺字回退、加载失败重试、多字体身份、迟到释放与 Canvas 字体注册；PWA 用例在保存游戏后关闭整个浏览器和服务器，在新浏览器进程中首次加载字体模块并验证脚本边界和图层像素。完整检查及独立 KAG/跨 ABI/画布结果以本阶段最终验证矩阵为准。

最终完整检查通过 290 项行为/集成与 495 项浏览器测试；同一发布构建另通过 36 个 KAG 场景、6 个跨 ABI 离线更新和 6 个字体画布像素组合。汇总为 `out/verification/font-geometry-matrix.json`，日志、截图和失败诊断保存在 `out/verification/font-geometry/`。这些结果不代表下述未完成能力已经实现。

重新编译本机参考库的示例（先激活同版 emsdk，执行过 `build:fonts`，并准备相邻参考源码）：

```sh
font_reference_source="$(em-config PORTS)/freetype/freetype-VER-2-14-3"
cmake -S "$font_reference_source" -B out/verification/font-geometry/freetype-build \
  -DBUILD_SHARED_LIBS=OFF -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON \
  -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON
cmake --build out/verification/font-geometry/freetype-build --parallel 4
KRKR_FREETYPE_INCLUDE="$font_reference_source/include" python3 tests/probes/freetype-native.py
```

完整回归的首次运行还记录了两处 WebKit 停滞：HTTP 用例未能完成浏览器 context 创建，GPU 恢复用例已验证恢复与像素后停在页面点击。两条 trace 均没有字体资源请求；原进程退出前未取得有效栈，不能据此声称找到了根因或修复了浏览器故障。失败 trace、后续重复检查和新的完整回归日志分别保存，不通过增加超时、重试或排除用例来隐藏失败。

第二次完整检查因主机重启而中断，进程与日志最终状态已核实；该轮不计作通过。部分日志与重启观察记录保存在 `interrupted-check.log`、`host-interruption.json`，最终矩阵只读取随后完成的检查结果。

长冻结测试还暴露了准备时间与正文共用预算的问题：一次浏览器/媒体初始化占用约 9.5 秒，原 30 秒总预算在预定 21.05 秒等待完成前耗尽。修正后，原生浏览器和媒体准备各使用独立的 30 秒 fixture 预算，正文仍为 30 秒，真实 freeze/resume 事件差仍必须超过 21 秒；没有降低持续时间断言。该测试调整、失败时间线和后续结果分别保留。

尚未完成系统字体完整枚举/筛选和选择对话框、字体集合的多 face 选择、旧编码 charmap 转换、所有缓存原生生命周期、ruby/纵排、GDI 差分，以及最终文字在全部 drawFace/opacity/holdAlpha 组合中的原生对照。单个合成 Unicode TTF 的覆盖不能代替复杂字体格式或真实游戏兼容验证。完整非插件目标继续进行。

依据：[KRKR2 Font](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font.html)、[字体角度](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Font_angle.html)、[FreeType 2.14.3](https://github.com/freetype/freetype/tree/VER-2-14-3)。抽取来源及哈希见 `tests/fixtures/font-geometry/reference.json` 与 `freetype.json`。

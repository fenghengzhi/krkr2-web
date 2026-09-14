# 像素混合与图层显示

状态：已实现选定接口；不表示完整图形 API 或原生像素一致性完成。

## 决策

图像混合由纯 TypeScript `graphics/blend.ts` 实现，不扩张 TJS2 WASM，也不依赖 Canvas/CSS 混合公式。`Bitmap.operate` 负责裁剪、同位图重叠时的源快照、透明度范围和 revision；算法只读写 RGBA 字节。支持 26 种图像运算：Opaque、Alpha、AddAlpha、7 种基础混合以及 16 种 Photoshop 变体。Binder/Effect/Filter 仍是无图像节点。

`operateRect/operateStretch` 的 omAuto 取源 Layer.type。Copy/Alpha/AddAlpha 根据目标有效 face 选择格式，基础与 Photoshop 运算独立于 face，即使 face 是 mask/province 也操作主图像。源 face 不影响选择。旧式 `pileRect/stretchPile` 固定使用源 Alpha，`blendRect/stretchBlend` 忽略源 Alpha，且只允许目标 dfAlpha/dfOpaque。目标 holdAlpha 按各运算的原生规则处理，不能统一解释为“所有模式保持 Alpha”。缩放沿用已有采样器；先采样后混合，尚未证明与原生组合采样内核逐位相同。

基础与 Photoshop 混合依赖背景像素。因此含这些模式的可见树在 CPU 按父子关系合成，保留原始图像格式，最后转换成 WebGL 预乘纹理。子图层先在父图层的格式中混合，再将结果以父图层的 type/opacity 混入祖先。无图像且完全不透明的 binder 只传递坐标和裁剪，不阻断子图层对背景的读取。截图和该显示路径共用缓存；顺序、位置、裁剪、类型、透明度、转场相位和位图 revision 都参与失效。

只有普通 Opaque/Alpha/AddAlpha 的场景保留独立 WebGL 纹理与既有预乘组路径。这条路径使用 GPU/浮点舍入，尚未与所有原生整数分支逐位对齐。包含特殊模式时选择整棵主图层树的 CPU 合成保证背景可见；进一步缩小重绘区域或在 GPU 上实现这些运算属于后续性能工作。合成缓存仍为 64 MiB，递归计算存在额外瞬时内存。

## 对照与已知差异

`tests/probes/blend-oracle.cpp` 仅在显式运行探测脚本时链接相邻参考项目的 tvpgl.cpp 和 gl/blend_function.cpp。调用 TVPInitTVPGL 后的真实函数指针，每次一个像素，覆盖 26 种模式、有效目标 face、holdAlpha 开关、6 档透明度及 64 对边界/固定种子像素。最初的 59,136 组现已扩展为 94,464 组，新增基础/Photoshop 运算在 mask/province face 下的行为。缺失的 AddAlpha→Alpha 路径被明确排除。参考输出保存在 `tests/fixtures/blend-reference.bin`，JSON 记录输出、适配器和参考源文件 SHA-256。普通测试不需要 C++ 编译器或相邻仓库。

重新生成：

```sh
node --import tsx tests/probes/blend-reference.ts ../kirikiroid2-web
```

这是一份本地参考项目的标量尾部基准，不能等同于所有 krkr2 版本。该项目还包含按地址对齐/8 像素块切换的优化分支；其全透明、全不透明快捷路径与单像素尾部可产生不同结果。本实现固定选择可复现的逐像素规则，尚未复刻这些布局相关差异。

保留了参考标量中可观测的特殊行为，包括：普通 Screen 在部分透明度且不保持 Alpha 时返回补数乘积；Copy→AddAlpha 的部分透明度分支不预乘源 RGB；PsDifference5 保留目标 Alpha。Overlay/HardLight 使用参考编译单元实际启用的查表版本。此处没有将 CSS、Photoshop 软件或其他引擎版本的公式当作替代标准。

参考可移植内核缺少 AddAlpha→Alpha 实现。本项目在预乘空间合成，再转为普通 Alpha 并钳制 RGB；普通 Alpha 无法表示超出覆盖率的发光分量。该路径有独立数学案例，但没有声称原生差分通过。

除像素基准外，测试覆盖脚本调用、omAuto、neutralColor/自动 face、裁剪、自复制、零强度、非法参数、binder 背景和缓存更新；浏览器检查 23 种依赖背景的模式实际颜色，以及 BMP 截图读回后的颜色。

2026-09-13 最终 `npm run check` 通过 94 项行为/集成与 87 项浏览器测试，无跳过项；原有 KAG 输入、存读档和转场在三种浏览器 × 两种 WASM 后端的 18 个案例全部通过。最新汇总为 `out/verification/blend-matrix.json`。

后续 [仿射绘图](009-affine-rasterization.md) 已接入四个 affine 方法。仍需继续：其他像素方法、完整 Bitmap 能力、精确采样差分、半透明 binder 与复杂嵌套组的原生差分、所有转场与特殊模式组合、性能和 GPU 恢复。已有滚动转场同时修正 ststStayDest=1 / ststStaySrc=2 的反转，并添加区分两者的条纹像素测试。

## 来源

- [Layer.type](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_type.html)：图像显示模式和适合的 face。
- [operateRect](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_operateRect.html)、[operateStretch](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_operateStretch.html)、[stretchPile](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_stretchPile.html)：脚本接口。历史文档中部分运算标注未实现；本项目范围以代码和测试为准。
- 本地参考的 LayerIntf.cpp / LayerBitmapIntf.cpp：绘图方式和 Alpha 保持的分派。operateRect 的历史说明与实现对 face 的表述不完全一致，此处采用所检查的实现分派。
- 原始版权及许可随 `public/licenses/graphics-notices.txt` 分发；本项目使用 TypeScript 重写算法，原生探测代码不进入发布包。

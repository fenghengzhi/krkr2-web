# Layer 的显示空间与图像空间

状态：基础模型已实现，完整混合、转场与字体兼容仍待完成。

Layer 不直接等于一张纹理。`scene/layers.ts` 保存显示位置、显示大小、父子关系、顺序与输入状态；`graphics/bitmap.ts` 保存 RGBA、可选 8 位 province、绘图裁剪与内容版本。`tvp/layer.ts` 负责 TJS 对象引用和原 API 绑定。

显示区域与图像区域分别处理：

- 初始图像/显示大小为 32×32；子层不可见，主层可见且不允许移动或隐藏。
- 缩小显示区域保留图像内容，扩大显示区域会在必要时扩展图像。
- 缩小图像至显示区域以下时，同时收缩显示区域，并调整图像偏移。
- imageLeft/imageTop 为非正偏移，必须让显示区域位于图像内。绘图/像素接口使用图像坐标，输入事件使用图层显示坐标。
- drawing clip 限制位图写入；父层显示区域限制子层显示和命中。二者不是同一种裁剪。

`FrameLayer.source` 明确指定纹理内的取样区域，WebGL2 根据它计算 UV，避免把大图缩放进小显示区域。窗口的显示偏移和缩放应用到显示坐标；输入时使用逆变换恢复图层局部坐标。位图内容版本为全局递增序号，替换图像也不会与旧纹理缓存版本碰撞。

`fillRect` 使用 ARGB 高位透明度，draw face 选择 RGB、alpha、province 或二者。`colorRect` 采用检查过的 TVP scalar 定点规则；不把 CSS source-over 当作原生整数计算的依据。图像复制先处理裁剪与重叠源快照。排序支持相对与绝对模式，重挂拒绝循环；销毁父层会分离子层。

`adjustGamma` 在 CPU 位图上对 RGB 分别使用查表曲线，遵循裁剪区并保留 alpha；完全透明像素不改写。dfAddAlpha 将加算成分保留，对 alpha 合成成分做 Gamma 变换。参数支持独立输出上下限与反转，Gamma 为 0 时保留端点行为。当前测试覆盖这些行为和小数 Gamma；尚未完成所有原生优化后端的逐值差分。依据 [Layer.adjustGamma](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_adjustGamma.html)。

图像加载单独处理省略扩展名的情况，依次尝试 PNG、JPG、JPEG、BMP、WebP、GIF，再沿用原有 auto-path 和大小写匹配。普通 `Storages.isExistentStorage` 不扩展文件名。多种同名格式并存时的优先级尚未与原生注册表逐项对齐；TLG 解码、自动 `_m` mask / `_p` province 伴随图像与图像元信息仍需实现。

后续的 [场景合成与图像存档](007-scene-transitions-snapshots.md) 已加入隔离的子树透明度、piledCopy、stretchCopy、BMP 和内置转场。当前限制仍包括无主图像的独立 province、全部 blend/operate、转换、仿射等。CPU 组图像缓存还需要 GPU 与性能优化。浏览器字体使用实际 Canvas 度量与栅格化，其字体回退和像素结果仍与原引擎存在平台差异。

依据：[Layer.setSize](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_setSize.html)、[Layer.setImageSize](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_setImageSize.html)、[Layer.drawText](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_drawText.html)，以及本地参考 `LayerIntf.cpp`、`tvpgl.cpp` 和 `tvpgl.h`。验证见 `tests/conformance/graphics.test.ts`、`tests/integration/window-layers.test.ts` 和 `tests/browser/graphics.spec.ts`。

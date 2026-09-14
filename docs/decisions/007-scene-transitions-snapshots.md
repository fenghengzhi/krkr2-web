# 场景合成、转场与图像存档

`scene/layers.ts` 继续保存图层树和位图所有权。`scene/composer.ts` 负责显示列表、需要隔离的子树合成和截图；`scene/transitions.ts` 负责转场时钟与结束操作。格式编码位于 `formats/image/`，缩放采样位于 `engine/graphics/`。这些部分均使用 TypeScript，不扩大 TJS WASM 的职责。

## 合成与截图

普通图层继续作为单独纹理交给 WebGL2。父层透明度小于 255 且有可见子层时，先合成子树，再对合成结果应用父层透明度。这样，子层互相重叠时不会重复受到父层透明度影响。转场需要的图像也经同一个合成器取得。

内部合成使用预乘 RGBA，最终显示仍由 WebGL2 完成；位图操作的权威数据仍在 CPU。合成结果按位图 revision、几何、可见子树和转场阶段缓存，保留的合成缓存上限为 64 MiB，与图层位图的预算分开。当前方案优先保持截图与显示之间一致的语义，尚未完成 GPU 离屏组渲染和帧耗时优化。

`piledCopy` 读取源图层显示坐标中的矩形，包括可见子层，并按目标图像坐标写入。它忽略源与目标的 face，也忽略源根节点自身的 visible/opacity；子层的 visible/opacity 仍参与合成。没有可见子层且显示范围等于整张位图时，直接保留原始 RGB/mask 字节，避免低 alpha 颜色在预乘往返中丢失。待处理的 onPaint 在截图前执行，并在调用前清除 callOnPaint 标志。

## 三种内置转场

`Layer.beginTransition` 提供 crossfade、universal、scroll；`stopTransition` 提前完成当前转场，无活动转场时不产生完成事件。接口依据 [beginTransition](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_beginTransition.html) 和 [内置转场说明](https://krkrz.github.io/krkr2doc/kr2doc/contents/Transition.html)。

- crossfade 按时间混合两个输入图像。
- universal 使用灰度规则图，按需平铺规则图，支持 vague；彩色规则按参考实现的灰度系数转换。
- scroll 支持四个方向，以及两层都移动、保持来源层或保持目标层的选项。

默认由会话时钟推进，暂停时冻结经过时间。selfupdate 不注册自动更新；脚本更新图层时推进。callback 可以返回自定义 tick，支持回退和快进。回调通过现有 TJS effect trampoline 执行，宿主导入不从 JavaScript 重入 VM。

结束时先移除活动转场，再交换图层在树中的位置。withchildren 为真时移动子树；为假时只交换节点，子层留在相应树位置。随后同步 TJS 对象中的 parent/children/primaryLayer 引用、处理焦点与模态状态，最后向原目标对象发送 onTransitionCompleted。完成回调可以开始另一个转场，旧转场不会清理新状态。手动结束、自动完成、会话暂停/停止以及源对象释放都有单独路径。

## 缩放与 BMP

`stretchCopy` 使用独立的可分离采样器。它支持最近邻、线性、三次、Lanczos、Spline、区域平均、Gaussian 和 Blackman-Sinc，以及对应 fast 类型的入口；支持目标裁剪、反转和 stRefNoClip。自我复制先完成采样再写回，holdAlpha 只在 dfOpaque 时保留目标 mask。采样行缓存上限为 8 MiB。

fast 入口目前使用相同滤波核的浮点实现，没有声称与原生 SIMD/定点优化逐像素等价。滤波边界、极端参数和全部原生回退条件仍需要差分测试。已验证的范围包括常量归一化、明确的线性采样结果、区域平均、裁剪映射、反向复制和参考边缘选项。

`saveLayerImage` 输出 bmp/bmp32、bmp24 或 bmp8。BMP 使用 40 字节 BITMAPINFOHEADER、倒序行与四字节行对齐。bmp8 使用参考实现的 252 色固定调色板与 4×4 有序抖动；bmp32 保留 mask 字节。独立 BMP 解码器读取这些无压缩格式，避免浏览器丢弃 32 位 BMP 的 mask。其他 BMP 变体仍交给浏览器，未证明所有变体等价。格式依据 [BITMAPINFOHEADER](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader) 与 [saveLayerImage](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_saveLayerImage.html)。

图像文件进入已有 SaveOverlay。KAG 随后通过带 offset 的 Dictionary.saveStruct 将游戏数据追加到 BMP 后面，保留图像头中的 BMP 长度。脚本调用完成前等待 IndexedDB 提交。测试同时检查 BMP 头、像素、调色板、追加数据、变量恢复和刷新后的脚本读档。

## 证据与剩余范围

`tests/conformance/composition.test.ts`、`image.test.ts` 验证合成/采样/格式；`tests/integration/transitions.test.ts`、`images.test.ts` 通过真实 TJS 检查回调、图层对象身份、时钟、暂停、截图和文件流；`tests/browser/scene.spec.ts` 检查实际 WebGL 像素以及 BMP mask 往返。

本地 KAG 探测增加 save 和 transition 两种模式，运行参考模板原有的存读档和 trans/wt 实现。自己的测试场景放在 `tests/fixtures/kag-save.ks`、`kag-transition.ks`。save 模式生成 8 位/24 位缩略图、检查导出字节并在刷新后读档；transition 模式依次执行三种内置转场，验证 KAG 前后页对象与目标颜色。

2026-09-13 的完整检查通过 86 项行为/集成测试和 81 项浏览器测试。Chromium、Firefox、WebKit 的 Asyncify/JSPI 六种组合各运行 input flow、save、transition，合计 18 个参考 KAG 场景全部通过。缩略图均为 133×99；8 位 BMP 长度为 14542 字节，24 位为 39654 字节，文件后面还包含 KAG 数据。汇总为 `out/verification/scene-matrix.json`，各场景保留日志、状态和截图。

后续 [像素混合决策](008-pixel-blending.md) 已补充 26 种混合、operateRect/operateStretch、旧式 pile/blend 及特殊模式的场景合成，并修正滚动转场 stay 常量的解释；[仿射决策](009-affine-rasterization.md) 接入四个 affine 方法。仍未完成其他 Bitmap/像素方法、图像元信息与伴随 mask/province 文件、完整 TLG、所有布局与字体、复杂游戏存档恢复、System.eventDisabled 对完成通知的抑制，以及所有嵌套转场和销毁顺序的原生差分。缓存预算只限制保留项，计算中的临时图像会增加峰值内存。当前结果不代表完成整个非插件目标。

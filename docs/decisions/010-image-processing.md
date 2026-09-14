# 图像处理与平面范围

状态：类型转换、灰度、矩形模糊已接通，翻转的整图/province 行为已修正；其余图形能力与完整兼容验证继续进行。

## 接口行为

`Layer.convertType(from)` 根据目标有效 face 转换整个图像，支持 dfAlpha→dfAddAlpha 和反向转换。它不改变 type/face，也不受 clip、holdAlpha 影响。RGB 采用所检查 TVP 标量的整数公式，Alpha 与 province 保留：转入 AddAlpha 为 `RGB*A >> 8`，转出为 `min(255, floor(RGB*255/A))`，A=0 时 RGB 清零。转出会损失无法用普通 Alpha 表示的发光分量，往返也不是无损操作；这包括全不透明输入转入时可能降低一个色阶的标量行为。

`Layer.doGrayScale()` 只处理 clip 内主图像，按 `(54R+183G+19B)>>8` 得到灰度，保留 mask/province。face 与 holdAlpha 不改变这项操作。

`Layer.flipLR/flipUD()` 翻转整个主图像、mask 和已分配的 province，不受 clip、face、holdAlpha 影响。此前只翻转 clip 内 RGBA 的行为已修正；命中平面因此与图像位置一致。

`Layer.doBoxBlur(xblur=1,yblur=1)` 处理 clip 内 RGBA，省略参数默认各 1，负半径按绝对值处理。它读取 clip 周围的原图；位图外不补重复像素，而是按实际可用邻域求平均。仅有效 face 为 dfAlpha 时采用 Alpha 感知路径，其他 face 均平均原始 RGBA；province 保持不变，holdAlpha 不阻止模糊 mask。两个半径均为零时无操作。沿用原 CPU 分支的限制：名义窗口面积必须小于 2²⁴。

## 算法与调度

类型转换和灰度位于 `graphics/processing.ts`。矩形模糊采用滑动列和与行和，每个源像素只参与常数次增减，运行成本随实际图像区域增长，不会随巨大的半径平方增长。累计颜色先转成原 CPU 采用的整数预乘表示，再按窗口大小选择 16 位倒数或 32 位除法求平均，最后按平均 Alpha 还原颜色。该处理使全透明像素的隐藏 RGB 不会染入 dfAlpha 的可见颜色。

模糊结果写入独立临时图像后才提交，处理过程中保留原图，省去原生就地写入使用的环形缓存。生成器每 4096 次像素更新让出一批，复用 EngineSession 的 8 ms 调度与暂停/取消。临时 RGBA 最多 64 MiB，列累计约 64 KiB；这些是位图预算之外的瞬时内存。最终提交、灰度、转换与翻转仍是同步操作，没有给所有图形操作定义统一的抢占延迟。

## 对照范围

`tests/probes/processing-reference.ts` 可显式从本地参考生成独立 C++ 对照。它调用 TVP 的类型转换/灰度函数，并提取 LayerBitmapIntf.cpp 保留的原 CPU DoBoxBlurLoop。没有采用该参考项目后来的 OpenCV 路径、未启用 OpenCV 时的复制占位，或 OGL 九点近似；本项目实现实际矩形平均及 Alpha 感知语义。

参考生成时有明确记录的修复：旧循环在 clip 高度小于环形缓存长度时会读取未写入的行，因此将缓存长度限制为 clip 高度；额外的列累计哨兵初始化为零，避免最后一个输出像素之后读取未初始化值。另补 C++17 要求的 dependent typename。源像素选择与平均公式没有修改。修复记录、原始源码/提取代码/适配器/输入/输出哈希保存在 `tests/fixtures/processing-reference.json`；因此不能把全部结果描述为“未修改原生程序的输出”。

当前基准为 333 个案例、280,032 个像素。转换覆盖每个 Alpha 与通道取值；灰度覆盖不同颜色组合；模糊覆盖窄图像、不同 clip、零/负半径、大小窗口、16/32 位平均和透明颜色。较矮 clip 与单像素图还用明确的数学结果单独验证。

```sh
node --import tsx tests/probes/processing-reference.ts ../kirikiroid2-web
```

普通测试只读取已记录的数据，不需要 C++ 编译器或相邻仓库。浏览器用真实 TJS 验证颜色、类型转换前后的显示、BMP mask 读回和 province 翻转，并在 4096×4096 模糊过程中验证停止无需 Worker 超时兜底。

这些证据不覆盖所有原生 SIMD/图形后端、所有参数与完整商业游戏。其他图像方法、图像元数据、伴随 mask/province 资源、TLG 等格式、精确字体与性能工作仍属于未完成范围。

2026-09-13 的 `npm run check` 通过 110 项行为/集成与 111 项浏览器测试，无跳过项。原有 KAG 输入、存读档、转场在三种浏览器 × 两种 WASM 后端的 18 个场景也全部通过。最新记录为 `out/verification/processing-matrix.json`。

## 来源

- [convertType](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_convertType.html)：支持方向、目标 face 与整图范围。
- [doBoxBlur](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_doBoxBlur.html)：半径、矩形窗口和 Alpha 路径。
- [doGrayScale](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_doGrayScale.html)、[flipLR](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_flipLR.html)：脚本接口及翻转范围。
- 本地参考 LayerIntf.cpp、LayerBitmapIntf.cpp、argb.h/.cpp、tvpgl.cpp/.h 和 gl/blend_function.cpp。原始版权许可随 `public/licenses/graphics-notices.txt` 分发。

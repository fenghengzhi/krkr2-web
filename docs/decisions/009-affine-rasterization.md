# 仿射绘图

状态：四个脚本接口和 Web 实现已接通；严格原生差分及性能优化继续进行。

## 坐标与覆盖

`Layer.affineCopy/operateAffine/affinePile/affineBlend` 支持矩阵与三个顶点两种参数形式。矩阵作用于源矩形内部的局部像素中心：`x'=a*x+c*y+tx`、`y'=b*x+d*y+ty`。源矩形偏移只用于最终资源取样，不再次加到变换后的目标位置。像素中心为整数，边界在两侧的 0.5 处；三个顶点对应源矩形的左上、右上、左下边界。

`graphics/affine.ts` 先求目标包围框与逐行覆盖，再逆变换到源坐标。每行以一对起止位置记录真正覆盖的区间。`Bitmap.affine` 只写这些区间，不把包围框内的空白角当作透明图像覆盖。几何覆盖与像素 Alpha 分离，所以 affineCopy 仍会复制覆盖区内的全透明像素。

源矩形宽或高非正时无操作。非空源矩形超出位图时抛错，源 Layer 的绘图 clip 不限制此次取样。只有目标 clip 限制写入；`stRefNoClip` 允许滤波读取源矩形外、位图内的邻居，不扩大变换本身的覆盖。非有限数值或计算溢出报错，零行列式产生空覆盖。

`affineCopy(clear=true)` 将目标 clip 内未覆盖部分清为目标 neutralColor。它对有效但完全不相交/退化的变换同样生效；空源矩形不清空。普通 Alpha/AddAlpha face 复制主图像和 mask；Opaque face 根据 holdAlpha 决定是否保留 mask。province 平面保持不变。

## 采样与提交

缩放与仿射共用 `graphics/filters.ts`。支持最近邻、线性、Cubic、Lanczos、Spline、AreaAvg、Gaussian 与 Blackman 对应的 0..19 枚举。Fast 与普通变体沿用当前浮点核，没有声称复刻原生低精度分支。除 FastLinear 外，分离滤波根据逆变换尺度扩大采样范围；极端缩小时范围受有限源尺寸约束。

AreaAvg 将目标像素逆变换为平行四边形，按其与源像素方格的相交面积加权。它不会把这个平行四边形替换成更大的轴对齐矩形；坐标归一化减少大面积乘积的溢出。其他核仍为源坐标轴上的分离采样，并非完整椭圆滤波。

所有采样先写临时 RGBA，再提交到目标。这保证自复制和 clear 不会污染尚未读取的源像素，采样中报错/取消也不留下部分图像。临时图像最多 4096×4096，逐行覆盖只占少量索引；它是已有位图预算之外的瞬时内存。

采样生成器每约 1024 次像素/采样操作让出一批工作。EngineSession 按 8 ms 时间片安排宿主事件循环，并处理暂停与取消。当前最终位图提交和其他同步图像算法并没有统一的可抢占保证，不能将本次取消测试推论为所有图形操作的延迟上限。

`operateAffine` 复用已验证的整数混合；omAuto 取源 type。Copy/Alpha/AddAlpha 运算按目标 face 选择表示；基础与 Photoshop 运算的原生分派独立于 face，因此即使 face 是 mask/province，它们仍操作主图像。旧式 affinePile/affineBlend 保留仅允许 dfAlpha/dfOpaque 的限制。该修正同步应用到 operateRect/operateStretch。

Layer.type 设置为自身现在是无操作，不会重新分配被 hasImage=false 释放的图像，也不会标记 imageModified；与所检查的 SetType 分支一致。

## 验证与边界

几何测试以独立的预期像素位置检查非零源偏移、矩阵/顶点等价、90° 旋转、镜像、剪切、裁剪、clear、mask 保留、退化变换和重叠自复制。AreaAvg 用旋转方形与像素方格的解析交面积检查结果；所有采样枚举都有恒定图像不变性检查。另有真实 TJS 参数/face/omAuto、暂停和取消测试。

浏览器检查变换后的实际画布、BMP mask 读回，以及 2048×2048 Gaussian 采样期间停止无需触发 Worker 超时终止。单像素彩色样本使用整数倍像素网格取样，排除页面 CSS 平滑缩放与截图边界取整；没有为通过测试改变产品的默认缩放方式。

像素混合的独立标量基准扩展到 94,464 组，新增基础/Photoshop 模式对 mask/province face 的覆盖。该基准验证混合核，不验证仿射的所有坐标舍入。当前仿射使用双精度几何与浮点采样；本地参考包含旧 16.16 扫描线分支和现代三角形渲染路径，本轮没有运行它们的完整图像差分。任意角度的边界取整、极端条件数、所有采样/混合组合、强烈缩小质量与实时性能仍需验证。

2026-09-13 最终 `npm run check` 通过 104 项行为/集成与 99 项浏览器测试，无跳过项。原有 KAG 输入、存读档、转场在三种浏览器 × 两种 WASM 后端的 18 个案例也全部通过。汇总、实现哈希和具体报告见 `out/verification/affine-matrix.json`。

## 来源

- [affineCopy](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_affineCopy.html)：参数、局部坐标、半像素边界、clear 与 mask 行为。
- [operateAffine](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_operateAffine.html)、[affinePile](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_affinePile.html)：自动模式和旧式接口。
- 本地参考 LayerIntf.cpp 的 AffineCopy/OperateAffine、GetBltMethodFromOperationModeAndDrawFace、SetType，以及 LayerBitmapIntf.cpp 的 AffineBlt/InternalAffineBlt。

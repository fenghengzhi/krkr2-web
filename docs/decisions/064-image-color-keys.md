# 064: 图像加载 key 的 uint32 边界

状态：2026-09-16，实现与回归案例已编写，**尚未执行验证**。本切片基于 `25913c1`；没有在本地运行测试、构建、类型检查、WASM、浏览器或原版 SDK。后续验证必须使用 GitHub-hosted Actions。本文不是通过记录，也不表示完整非插件目标已经完成。

## 原版依据

固定参考为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/`，沿用已归档的 system-colors 源码合同第 5 节。本次读取原文静态确认：

- [`LayerIntf.cpp:6899–6906`](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L6899) 的 `loadImages` 先执行 `AsInteger()`，再转换为 `tjs_uint32`；省略 key 或显式 `void` 使用 `clNone`。
- [`GraphicsLoaderIntf.cpp:1873–1884`](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/GraphicsLoaderIntf.cpp#L1873) 只在 `(ColorKey & 0xff000000) == 0` 时通过 RGB 生成 alpha。
- 同文件 `2344–2376` 保留原始 key，并分别识别完整值 `clAdapt`、高字节 `03` 的 `clPalIdx` 和高字节 `04` 的 `clAlphaMat`。未知非零高字节不抛非法 key，也不进入 RGB key 分支；`2380–2485` 的同伴资源查找、mask 替换和 matte 处理继续执行。

这些路径没有调用 `TVPToActualColor`。因此 `0x80000005` 虽是系统色的编码，在这里仍是图像加载 key：保留原图 alpha，然后继续处理同伴资源，不能先转换成桌面或 Web 调色板 RGB。

## 实现

`Layer.image` 复用现有 `clipInteger`，在 BigInt 域内截取低 32 位，再通过 `>>> 0` 传入 loader。`loadImages` 的 TJS 包装仍先执行 `int(...)`；参数数量、省略/void、转换时序及结果处理不变。这样超过 `Number.MAX_SAFE_INTEGER` 的 TJS 整数不会先转成有精度损失的 Number。

`validateColorKey` 继续要求有限范围内的 uint32 整数，但允许所有高字节。`applyImageKey` 仅为普通 RGB、完整 `clAdapt` 和存在索引的 `clPalIdx` 进入相应 keying 路径，其余非零高字节直接保留解码 alpha。保留现有 None、Adapt、PalIdx、AlphaMat 算法及 loader 的 key → mask → matte → province 流程。

此切片没有加入系统色 resolver，没有改变 native bridge、运行时 ABI、协议、颜色常量或图像解码器。其他图像格式/算法和系统色兼容缺口仍属于原有工作范围。

## 待运行的回归案例

新增三个共享情景，计划由真实 WASM source 和 `Scripts.compileStorage` 字节码分别运行，共 **6 个 Node 测试**。浏览器使用真实页面、Worker 和脚本存储链路，每个情景分别运行 Asyncify/JSPI 与 source/bytecode，共 **12 个浏览器定义，三浏览器展开为 36 个案例**。JSPI 若不可用必须记为跳过，不能算通过；这些数字只是静态测试清单，当前没有执行结果。

1. `0x80000005`、低 24 位恰好等于像素的 `0x80c86432`、接近 Adapt 的未知值、其他非零高字节和 `-1` 均保留原始 alpha。索引 PNG 的原透明索引也保持不变；带 mask/province 的加载仍替换 alpha、保留省图和元数据。
2. 相邻大整数 `0x20000000c86432` / `0x20000000c86433` 直接保存在 TJS 源码中，加载两种相邻 RGB 的实际 BMP，分别使不同像素透明。覆盖负数的大整数对、接近 int64 上界、正负 2³² 回绕，以及大整数的系统色/未知高位编码。
3. 省略、void、None、RGB、Adapt、PalIdx 和 AlphaMat 路径，以及特殊 key 的大整数别名。特意使 RGB key 的 alpha 为 `[255,0]`，随后同伴 mask 替换为 `[0,128]`，以区分正确顺序与错误相乘/再次 keying；matte 必须在 mask 之后，province 继续保持 `[0,1]`。

复用已提交的 `image-reference.bin/json` 中 main/mask/palette PNG，仅在测试执行时编码一个 2×1 相邻 RGB 的 BMP。所有情景通过 TJS 的主图、mask、省图 getter 和 PNG 元数据获取实际结果。浏览器还截取真实 Canvas，并保存 PNG 与实际像素 JSON；预期画面使用现有 WebGL 的显示混合约定，不把它当成原版标量合成的额外证明。每次 Stop 检查资源释放或页面空闲。

GitHub Actions 尚未运行；类型检查、测试数量、像素预期和完整检查均等待 hosted 结果确认。既有运行的成功、失败、取消或未执行证据继续保留，不会被本文件覆盖。

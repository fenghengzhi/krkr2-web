# TLG 图像与标签

状态：TLG5 RGB/RGBA、TLG6 灰度/RGB/RGBA 和 TLG0 SDS 标签已接入资源加载。后续的伴随平面与加载选项见 [图像加载](012-image-loading.md)，PNG/TLG 保存见 [图像写出](013-image-writing.md)；本文件保留解码阶段的设计与验证记录。

## 模块与边界

`src/formats/image/tlg/` 是无 DOM、无原生依赖的 TypeScript 解码模块。滑动字典、Golomb 位流、两代像素预测与 SDS 容器分别实现；它们只读取有边界检查的字节视图并产生 RGBA。TLG5 使用共享 4 KiB 字典、水平/垂直差分和颜色差分；TLG6 使用按 8 行分组的残差、16 种颜色滤波与 MED/AVG 预测。文件中的 BGR 顺序在此转换为引擎 RGBA。

EngineSession 在调用浏览器解码器前识别 TLG，因此相同解码路径也能用于无界面测试和 universal 转场规则图。压缩输出每约 4096 字节/残差、像素每行让出一批，复用会话 8 ms 调度、暂停与取消。完成全部像素与标签解析后才提交图层；失败不会留下半幅新图像。字节读取、最终图层复制和现有颜色键处理仍有同步阶段。

`DecodedImage` 在像素之外携带可选标签 Map；`Layer.loadImages` 将其转换为 TJS Dictionary，没有标签则返回 null。标签保持原始字符串，支持 UTF-8、空键/值、分隔符和跨标签块的重复项，重复键以最后一个值为准。标签不自动改变图层位置或混合类型，原始 Alpha 字节也不因 `mode=addalpha` 标签而被重算。原有 KAG 可读取标签决定自己的行为。未写扩展名时也会尝试 `.tlg`、`.tlg5`、`.tlg6`。

## 数据预算与拒绝条件

尺寸延续项目的 4096×4096 上限，输出最多 64 MiB。TLG5 最坏需要额外 64 MiB 解压平面；TLG6 只保留当前行组的最多 128 KiB 残差和最多 256 KiB 滤波表。输入资源仍受现有 64 MiB 单次读取限制。这些解码暂存是图层预算之外的瞬时内存；尚未形成所有格式共用的内存预留机制。

SDS 标签总字节上限 1 MiB，最多 4096 个不同键；未知块按长度跳过。对截断、长度溢出、无效 UTF-8、越界字典输出、超长残差运行、无效滤波代码、错误块大小和多余原始数据明确报错，不回退成浏览器图像。

TLG5 目前接受 3/4 通道及 0/1 压缩标记；不实现旧参考加载器本身拒绝的单通道 TLG5。TLG6 支持内建 Golomb 表及 method 0，保留/未实现的熵方法和外部表明确拒绝。单通道 TLG6 输出一致的灰度 RGB 和不透明 Alpha，不复现旧解码器未初始化其他通道的行为。某些原生加载器忽略的错误长度在这里会被拒绝。

## 独立验证

`tests/probes/tlg-reference.ts` 在临时目录编译相邻参考的 SaveTLG5/SaveTLG6，输入本项目生成的像素，记录压缩文件及哈希。常规测试只读取已提交的 334,655 字节数据，不需要 C++ 编译器或相邻仓库。

310 个样本、222,986 个像素覆盖灰度/RGB/RGBA、透明与噪声、窄图、奇数行组、不完整块、跨行组字典，以及全部 32 种 TLG6 滤波/预测组合。期望值是编码器的原始输入像素，不由本项目解码器生成。对强制组合只覆盖编码器的选择结果，不替换预测、颜色滤波或熵编码公式。

参考适配明确修复三个与编码算术无关的问题：SlideCompressor 初始清零多写一个字节、未初始化的计时累计，以及灰度路径对空颜色缓冲的指针运算。源码、提取内容、输入、适配器和生成数据的哈希与修复记录位于 `tests/fixtures/tlg-reference.json`。版权声明沿用 `public/licenses/graphics-notices.txt`。

```sh
node --import tsx tests/probes/tlg-reference.ts ../kirikiroid2-web
```

额外测试检查字典重叠/环绕、Golomb 逃逸码、所有截断前缀、SDS Unicode/长度和加载失败的原图保留。真实 TJS 测试覆盖扩展名、标签、颜色键、BMP mask 读回、解码暂停/取消；浏览器覆盖图像显示、灰度规则转场和 4096×4096 解码中途停止。

2026-09-13 完整检查通过 118 项行为/集成和 123 项浏览器测试，无跳过项；原有 KAG 的三浏览器双后端输入、存读档与转场共 18 个场景全部通过。汇总见 `out/verification/tlg-matrix.json`。参考 KAG 的 600×176 `messageframe.tlg` 另已验证可读取并返回 `mode=addalpha`，该观察不代替完整 KAG intro 流程测试。

这些案例不证明所有第三方编码器、非标准文件或完整商业游戏兼容。后续已补 [伴随图像与颜色键](012-image-loading.md)、[TLG 编码](013-image-writing.md) 和 [加载缓存与预加载](014-image-cache.md)；格式扩展与性能差分仍需继续。

## 来源

- [Kirikiri Z 的 TLG 加载器](https://github.com/krkrz/krkrz/blob/master/visual/LoadTLG.cpp)：原始/封装签名、颜色通道、块格式和标签文法。
- [Layer.loadImages](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_loadImages.html)：加载接口、颜色键和标签返回值。
- 本地参考 `SaveTLG5.cpp`、`SaveTLG6.cpp`、`SaveTLG.h`、`LoadTLG.cpp`、`tvpgl.cpp/.h` 和 `GraphicsLoaderIntf.cpp`。

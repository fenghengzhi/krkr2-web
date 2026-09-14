# PNG 与 TLG 图像写出

状态：saveLayerImage 已接通 PNG、TLG5/TLG6 和原有 BMP，PNG/TLG 编码可暂停和取消。缓存和预加载见后续的 [图像缓存决策](014-image-cache.md)；其他图像格式与统一内存预留继续实现。

## 接口与元数据

`Layer.saveLayerImage(name, type="bmp")` 仍由 type 决定编码，文件扩展名不改变默认值。保存整幅主图，不受 clip、显示尺寸和 layer.left/top 影响，不保存 province，也不修改原图、mask、clip、type 或 imageModified。

| type | 内容 |
| --- | --- |
| bmp / bmp32 | 原有 32 位 BMP，保留 Alpha |
| bmp24 / bmp8 | 原有 RGB BMP / 固定调色板抖动 BMP，不保存 Alpha |
| png / png32 | 8 位 RGBA PNG，保留原始通道 |
| png24 | 8 位 RGB PNG，不保存 Alpha |
| tlg / tlg5 | TLG5 RGBA；tlg 默认选择 TLG5 |
| tlg524 | TLG5 RGB，不保存 Alpha |
| tlg6 / tlg624 | TLG6 RGBA / RGB |

接受这些名称的前导点形式；其他模式明确报错。编码直接保存原始通道，包括全透明像素的 RGB 和 AddAlpha 表示，不自动转换颜色或 Alpha 表示。TLG0 SDS 封装保存 UTF-8 标签；自动 mode 标签覆盖全部 26 种图像混合类型。24 位 TLG 仍保留 mode 字符串，和参考行为一致。

自动元数据沿用参考 SaveLayerImage：mode 来自图层 type；只有正的 imageLeft/imageTop 才生成 offs_x/offs_y，使用图像偏移而不是图层位置。当前图层 API 限制图像偏移非正，因此常规保存只产生 mode。没有擅自将负图像偏移或 layer.left/top 写为正偏移。

PNG 格式编码接口支持 oFFs、pHYs、vpAg 的位置/分辨率元数据，忽略没有标准对应项的 mode 和任意 TLG 字符串标签。常规 Layer 保存因此不会给 PNG 合成 mode 标签；这与参考 PNG 保存器不保存混合类型的行为一致。PNG 原生格式接口的额外位置字段写出是本项目能力，参考 PNG 保存器本身忽略其 meta 参数。

## 模块与算法

`engine/storage/image-writer.ts` 选择编码器、组织元数据；`formats/image/png-encoder.ts` 产生滤波扫描行与 PNG 块。每行比较五种滤波残差的绝对值代价，使用 host 注入的 Web CompressionStream 完成 zlib，再写入带 CRC 的分块 IDAT。无需 Canvas 回读或原生编码模块。

`formats/image/tlg/encode5.ts` 实现颜色差分、行预测、四行分组和共享字典压缩。`slide-encoder.ts` 使用有界哈希链搜索 4 KiB 字典，支持最长 273 字节匹配，避免读取与字典写入重叠的匹配。压缩不划算时恢复字典字节与位置，写原始平面；滤波代码压缩使用 TLG6 指定的初始字典。搜索策略不同于原生，不要求压缩文件逐字节相同。

`encode6.ts` 在每个 8×8 块比较两种预测和 16 种颜色滤波，按局部 Golomb 位数估计选择组合，再按原格式重排并对行组编码。评分包含 Alpha；原生参考只用 RGB 选择部分组合，平分时的选择也可能不同。输出仍为无损格式，不宣称文件大小或选择结果与原生一致。Golomb 写出处理交替零/非零运行、动态参数和以当前字节为基准的逃逸码。

通用 BinaryWriter 保持输出预算并支持长度回填，CRC32 与 PNG 读取共用。TLG5/6 算法、SDS 文本和 PNG 行滤波通过生成器分段运行，沿用会话调度；Web 压缩完成后再次检查取消状态。路径先验证，完整字节生成后才交给 SaveOverlay，随后走既有 IndexedDB 提交与备份流程。压缩失败或编码取消不会覆盖旧存档文件。

## 预算与限制

尺寸仍限制为 4096×4096；最终单文件与整个存档覆盖层分别受现有 64 MiB 限制。PNG 扫描行暂存最多 64 MiB 加逐行前缀，TLG5 的行组平面约 64 KiB、字典索引约 284 KiB，TLG6 的行组平面约 128 KiB、滤波表最多 256 KiB。

压缩结果、长度回填缓冲、SDS 封装和最终存档副本会额外占用内存，保留位图预算不等于峰值内存预算。TLG6 的 32 种候选比较成本较高；已验证可取消，但尚未对完整游戏美术集建立耗时、压缩比和峰值内存基准。原有 BMP 编码仍是同步路径。

## 独立验证

`tests/probes/image-writing-reference.ts` 将本项目生成的 TLG 交给参考 LoadTLG5/LoadTLG6 和 TVP 内核，把 PNG 交给 Pillow；共验证 128 个 TLG 和 64 个 PNG，覆盖透明/不透明、常量/渐变/噪声、窄图、块边界、奇数行组和 24 位输出。测试分配器为原生解码器的额外读取填充字节置零，解码公式和函数保持原样。

记录在 `tests/fixtures/image-writing-reference.json`：TLG 哈希绑定已由原生解码器验证的完整文件字节；PNG 绑定过滤后扫描行，避免把不同浏览器 zlib 的字节差异当成格式错误。当前编码结果同时通过本项目读取器检查像素和元数据；先前独立图像读取样本继续参与回归。普通测试不需要 C++、Pillow 或相邻参考目录。

```sh
node --import tsx tests/probes/image-writing-reference.ts ../kirikiroid2-web /path/to/python-with-pillow
```

真实 TJS 验证整图保存、Alpha、mode 标签、province 不写出、失败保留旧文件和取消。浏览器验证六种格式的显示、备份字节、PNG 原生解码、刷新恢复，以及 PNG/TLG5/TLG6 大图编码中途停止。

2026-09-13 最终检查通过 136 项行为/集成测试和 159 项浏览器测试，无跳过项。原有 KAG 三浏览器双后端的输入、存读档和转场共 18 个场景全部通过。实现、构建、独立解码记录和浏览器测试时序修复汇总在 `out/verification/image-writing-matrix.json`。

## 来源

- [saveLayerImage 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_saveLayerImage.html) 说明旧版 BMP 行为；PNG/TLG 扩展、自动标签与 24 位模式依据本地参考 LayerIntf.cpp、LoadPNG.cpp、SaveTLG5.cpp、SaveTLG6.cpp。
- [PNG 规范](https://www.w3.org/TR/png-3/)；TLG 依据参考加载/保存代码和已记录的独立解码结果。
- TVP 版权声明随 `public/licenses/graphics-notices.txt` 分发；原生探测代码不进入浏览器应用。

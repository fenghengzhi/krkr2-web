# 图像加载、调色板与伴随平面

状态：主图、mask/province 伴随资源、loadProvinceImage、四种颜色键策略已接入。PNG/GIF 与索引 BMP 的像素和索引在 TypeScript 中解析；加载缓存和预加载见后续的 [图像缓存决策](014-image-cache.md)，更多编码格式与性能工作继续进行。

## 模块与加载顺序

`engine/storage/images.ts` 的 ImageLoader 负责扩展名、伴随文件查找和加载顺序。它依赖资源查询、图像解码和可暂停工作执行三个接口，不绑定 File、浏览器 Canvas 或 TJS。像素处理位于 `engine/graphics/loading.ts`，脚本绑定只提交完成的主图、province 和标签。

加载顺序是：解码主图 → 颜色键 → `_m` mask 覆盖 → Alpha 背景色合成 → `_p` province。主图与所有伴随资源准备完成、位图预算检查通过后，才替换图层。失败保留原图、province、clip 和 imageModified；这是本项目的事务边界，不复现原生某些失败路径留下部分替换结果的行为。

文件名去掉扩展名后添加 `_m` 或 `_p`。指定主图扩展名时，mask 优先尝试同扩展名，再按注册顺序查找；province 按注册顺序查找。未指定扩展名时沿用项目既有优先级：PNG、JPEG、BMP、WebP、GIF、TLG。所有候选经过同一个资源解析器，支持保存覆盖层、auto-path、大小写回退和显式 archive>entry。扩展名优先级是确定的项目策略，不依赖参考实现的哈希表遍历顺序。

## 颜色键和平面

- `clNone` 保留图像本身的 Alpha。
- `0xRRGGBB` 匹配的像素 Alpha 为 0，其他像素为 255；修正此前仅清除键色、保留其余旧 Alpha 的行为。
- `clAdapt` 统计首行 RGB，选择频数最多的颜色；频数相同选择最小 RGB 值。遵循文档定义，不沿用旧参考中频数累计未及时清零导致的异常选择。
- `clPalIdx+index` 用原始调色板索引设置透明色，其余索引不透明；重复颜色仍能区分。低 8 位为索引，非调色板源保留原有 Alpha。PNG 路径实现文档定义的指定索引语义，不复现旧 LoadPNG 将索引误传为单个 tRNS Alpha 值的问题。
- `clAlphaMat+color` 在 mask 应用后执行普通 Alpha 背景合成，全部输出为不透明；标签不变。整数公式沿用标量 `background + ((source-background)*alpha >> 8)`，包括 alpha=255 仍可能向背景偏移一级的行为。

`_m` 使用 RGB 灰度值 `(54R+183G+19B)>>8` 替换 Alpha，不与主图 Alpha 相乘，也不读取 mask 自身的 Alpha。mask 尺寸必须与主图一致。这里统一使用 TVP 灰度公式，不复现各原生解码器在 RGB 转灰度系数上的差异。

province 保存原始调色板索引；无调色板的 8 位及以下灰度 PNG、单通道 TLG6 使用灰度字节。真彩色、16 位灰度 PNG 等没有可用索引的来源会明确拒绝，不从显示颜色近似恢复索引。小于主图的 province 按参考实现的指定尺寸加载逻辑重复平铺；大于主图则报错。文档的泛化“尺寸不同报错”与所检查原生尺寸回调并不完全一致，这里采用实际平铺行为。

`loadProvinceImage` 仅替换 province，保持 RGB、Alpha 和 clip，标记 imageModified；自动伴随加载无 `_p` 时清除原有 province。两个入口都使用相同的位图预算与可取消准备流程。

## 编码格式

`DecodedImage` 除 RGBA 与标签外，携带可选原始 `indices` 或 `grayscale` 标记；图层不保留调色板，只提交需要的 province 字节。

PNG 支持合法颜色类型与 1/2/4/8/16 位组合、全部五种滤波、Adam7、PLTE/tRNS、跨 IDAT 数据和 CRC 检查。16 位分量取高字节，透明色在截位前比较；保留全透明像素的 RGB，不经过 Canvas 预乘往返。oFFs、pHYs、vpAg 转成与参考相同名称的字符串标签。静态主图不应用 gAMA/ICC 色彩变换，也不播放 APNG 动画，使用 IDAT 的默认图像；这与浏览器媒体色彩管理及动画显示不是同一功能。

PNG 解析和滤波还原以生成器分段执行，zlib 由宿主注入的 DecompressionStream 完成。PNG/GIF 数据块通过复查边界来汇集，不保留每个小块的独立视图数组；GIF 连续字典重置码也计入让出预算。PNG 压缩数据、逐行前缀和展开数据均检查长度，资源输入仍受 64 MiB 限制。最大 16 位 RGBA 展开暂存约 128 MiB，最终 RGBA 最多 64 MiB，调色板索引最多 16 MiB；这些暂存加上图层替换副本可能明显超过保留位图的 64 MiB 预算。尚未实现全部格式共用的内存预留和逐行流式背压。

GIF 支持 87a/89a、全局/局部调色板、首帧位置与隔行顺序、透明索引和 12 位 LZW 字典。Layer 加载首帧；后续帧不作为动画时间线播放。BMP 索引保留覆盖未压缩 Windows 1/4/8 位，24/32 位保留原有路径；其他 BMP 变体仍可能依赖浏览器解码，不能据此宣称可读取其原始 province 索引。

## 验证与来源

110 个图像样本由 PyPNG/Pillow 编码，期望字节来自原始样本。额外手工滤波后的 PNG 与四位 BMP 用 Pillow 独立读回校验。覆盖 Adam7、16 位透明色比较、全部滤波、重复调色板颜色、GIF 字典增长和隔行、BMP 位/半字节顺序。常规测试只使用带哈希的 `image-reference.bin/json`，不依赖 Python 或相邻项目。

12,288 个颜色键、mask 和背景色合成像素来自未修改的 TVP 标量函数，源码与适配器哈希记录在 `loading-reference.json`。独立生成入口为 `tests/probes/loading-reference.ts`；不把原生 C++ 图像代码链接到应用。

集成验证包括 auto-path 伴随查找、PNG 标签、同扩展名 mask 优先、不同加载顺序、province 平铺/复制、失败时原图保留和暂停/取消。浏览器使用真实 TJS 验证屏幕像素、province 点击命中、BMP mask 回读与大 PNG 的停止。

2026-09-13 的最终实现通过 129 项行为/集成测试和 135 项浏览器测试，无跳过项；原有 KAG 三浏览器双后端的 18 个输入、存读档和转场场景全部通过。浏览器测试修正了滚动后缓存坐标和画布尺寸同步的等待；KAG 探测修正了过早检查求值按钮而跳过初始化中场景的问题。像素、命中和存档断言保持不变。完整来源与构建哈希在 `out/verification/image-loading-matrix.json`。

- [Layer.loadImages](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_loadImages.html)、[loadProvinceImage](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_loadProvinceImage.html)。
- [PNG 规范](https://www.w3.org/TR/png-3/)、[GIF89a 规范](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)。
- 本地 GraphicsLoaderIntf.cpp、LayerIntf.cpp/.h、LoadPNG.cpp 与 tvpgl.cpp/.h；TVP 声明沿用 `public/licenses/graphics-notices.txt`。

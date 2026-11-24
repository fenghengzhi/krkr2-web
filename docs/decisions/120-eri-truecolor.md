# 120　游戏真彩色 ERI 的解码与验收

本批在现有图像加载入口接入 ERI 的无损 Run-length Gamma 块编码。游戏脚本可经 `Layer.loadImages` 加载 24 位 RGB、32 位 RGB、带 alpha 的 32 位图像，以及按该方式编码的单通道 8 位灰度图。第 119 批的 8 位索引与灰度图继续使用原来的 RL-MTF-G 解码器。两者共用 ERI 容器、存储选择、错误消息和缓存。协议与 TJS ABI 沿用现有版本。[播放器入口](../../src/formats/image/eri.ts)

## 块还原与图层输出

Web 支持 `ImageFrm` 版本 1 和 4 的 Gamma 路径。独立块各自读取游程，预置操作表模式允许游程跨块延续。增强模式恢复通道的样本顺序与颜色差值后，再恢复水平和垂直差分。右边和底部超出可见尺寸的样本参与还原，写入私有图像时裁去。解码尺寸可先于像素通知调用者，完整熵流成功后才发布扫描行。Web 对块大小和工作内存另有限制。[块解码器](../../src/formats/image/eri-truecolor.ts) · [固定 ERINA 实现](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/library/common/experi.cpp)

原 KRKR2 在普通加载时将加算 alpha 表示转换为直通 RGBA。alpha 为零的像素输出黑色，其他像素按通道计算 `min(255, floor(通道 × 255 / alpha))`。灰度遮罩从转换前的原始颜色计算 `(54R + 183G + 19B) >> 8`。两条路径均按 ERI 高度的符号还原上下方向。完整 RGB 颜色键在扫描行提交时生效，伴随的 `_m` 图像可覆盖主图透明度。[KRKR2 原加载器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/GraphicsLoaderIntf.cpp)

## 原版对照与游戏验收

Windows 托管作业分别运行手工构造的输入和原作者工具产生的输入，各自产生独立报告。两组都使用已固定大小和 SHA-256 的 KRKR2 2.32r2。探针逐像素比较原生 Layer、实际 Web 图像加载器和外部给定的期望值，记录输入、Web 输出和原生事件。手工对照保留上一批 11 个场景，并覆盖真彩色块、方向、透明度、遮罩和颜色键。[SDK 驱动](../../tests/probes/eri-sdk.ts) · [输入与像素期望](../../tests/helpers/eri-truecolor-fixtures.ts)

另一组从三幅已知像素的 BMP 开始，由 ERINA 1.0A 随附的命令行程序 ericvt 1.02 压缩，再交给两套引擎加载。输入尺寸为 13×11、19×17、21×9，使用 8×8 或 16×16 块，涵盖独立块、操作表及跨块的非整齐边缘。作业先校验工具的 176,128 字节及 SHA-256，再核对输出帧的版本、位深、尺寸和块参数。归档包含 BMP、生成的 ERI、程序输出和哈希。[生成与校验](../../tests/probes/eri-encoder.ts) · [原作者工具源码](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/samples/ericvt/ericvt.cpp)

浏览器场景经源码和字节码启动实际 Worker，分别读取 Layer 的颜色与透明度，并在画布上显示颜色和遮罩。这样可以识别半透明像素的整数转换错误。在原版 KAG 模板中，场景先显式加载 BMP，然后以同名无扩展名的资源加载 ERI，存档、换图、清除缓存并读档。第二次刷新页面后，探针直接恢复书签，检查 3×3 图层的全部颜色与透明度、脚本变量，以及场景是否重跑了原先的加载标签。[浏览器场景](../../tests/browser/eri-loading.spec.ts) · [KAG 场景](../../tests/fixtures/kag-eri-save.ks) · [KAG 探针](../../tests/probes/kag-browser.ts)

本批新增 13 个常规 Node 测试定义及每个浏览器 4 个测试定义。两个 Windows SDK 作业分别计划比较 24 个手工场景和 3 个工具编码场景。书签验收扩充现有 KAG 兼容矩阵的 12 个存档场景，覆盖 XP3／ZIP、双后端和三个浏览器。这些都是待执行的验收范围。算术熵编码、Huffman、其他 ERI 帧和有损编码仍有缺口，完整游戏也仍须实际验收。

## 第 118、119 批结果

第 118 批已终态失败，12 个作业成功、5 个失败、11 个跳过。最后两项 CUR／ANI 对照成功。第 119 批取回时有 21 个作业成功、1 个失败、3 个运行中。PNG 与 JPEG 的独立构建及差分、原版 8 位 ERI SDK 对照和两个分配器作业报告成功。Windows 2022 的 beginMove 作业失败，公开页面只给出退出码 1。主构建和两个 CUR／ANI 作业仍在运行，Node、浏览器和应用验收尚无本次结果。[118 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45469186113) · [119 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45473097908)

本轮保存了三个运行各自的运行状态、作业和产物清单，以及四份公开作业页面。已列出的 40 份产物尚未取得原 ZIP。第 119 批的一次性历史归档回收仍在下载，取回时尚无归档产物。以上成功数均按作业状态统计。本批实现与新增验收仍待托管结果。[历史归档回收](https://github.com/fenghengzhi/krkr2-web/actions/runs/45473098039)

## 批次交接

19 个文件随实现提交 `a1967b78e9280c7a9591d1ca1f15c61e1c552a73` 推送至 `codex/migrated-window-attention`。首次登记时整套验证已排队。原始 Actions 页面与匹配结果保存在 `out/verification/github-actions/120-initial-a1967b78e9280c7a9591d1ca1f15c61e1c552a73/`。下一批一起取回本次结果和第 119 批尚未完成的应用验证、窗口作业与历史归档。[第 120 批全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45475659242)

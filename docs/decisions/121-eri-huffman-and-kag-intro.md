# 121　ERI 默认编码、原版 KAG 介绍程序与构建修复

游戏现在可以通过 `Layer.loadImages` 加载原作者 ericvt 默认生成的无损 ERI。新增支持包括帧 8 的自适应 Huffman 真彩色图像，以及帧 2 的 Huffman 索引图和灰度输出。既有 Gamma 帧和新的 Huffman 帧共用图层像素转换、图像方向、遮罩和成品缓存。协议与 TJS ABI 沿用上一批版本。[游戏加载入口](../../src/formats/image/eri.ts)

## 两种 Huffman 图像

帧 8 单独维护块操作树，颜色通道的熵解码则按前一字节选择自适应树。零游程长度使用自己的树。遇到新值时读取字面量，按原版次序调整权重。根权重达到 `0x4000` 时将叶权重折半并重建。操作表模式可以先读整幅图的块操作，另一种布局在相应块前读操作。两种布局都保留跨块的数据上下文。重排通道后还原颜色差值，按操作位决定是否做水平方向积分，然后恢复垂直差分。[Huffman 树](../../src/formats/image/eri-huffman.ts) · [块还原](../../src/formats/image/eri-truecolor.ts) · [原版 ERINA 解码器](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/library/cpp/experib.cpp)

帧 2 在连续第二次出现同一索引时读取重复长度。每行重新开始判断连续索引，前一符号决定的树和已学习的权重跨行保留。成功解码整幅私有索引平面后，现有调色板路径处理方向、灰度和 `clPalIdx`。Web 保留源大小、尺寸和私有工作内存上限，并限制重复写入在当前行内。[选择与发布](../../src/formats/image/eri.ts)

## 托管验收

Windows 原版 SDK 对照本批计划运行 36 个手工场景和 10 个作者工具场景。后者包含 ericvt 的默认 `-e`、显式增强模式和逐块模式，直接比较原始 BMP 所定义的像素、原生 Layer 和 Web 输出。96×96 的输入先反复使用同一上下文并穿插不同残差，使树达到重建阈值，末尾再切换到不同颜色。8 位 BMP 另查调色板索引键和灰度遮罩。SDK 作业也运行 23 个已有和新增的 ERI 合同测试，使主应用构建失败时仍能保留独立 TAP 结果。[作者工具输入](../../tests/probes/eri-encoder.ts) · [三方逐像素比较](../../tests/probes/eri-sdk.ts) · [Huffman 验收](../../tests/conformance/eri-huffman.test.ts)

浏览器验收还加入完整发行样例 `kag3_intro.xp3`。该包有自己的启动脚本、菜单、说明章节、图片和退出链接。测试从固定提交取得 908,364 字节的原包，SHA-256 为 `b2efe3e6d871c8961c1e0e00070fd0e22a18cdb5cdbf8da4a3cb4e03b7abc46a`。它通过真实游戏输入选择 Kirikiri 介绍路线，检查翻页、书签、刷新后的读档和回到菜单退出。原来的 KAG 模板兼容矩阵继续独立运行。这个样例只覆盖其中一条路线，其他游戏仍需验收。[发行样例来源](https://github.com/fenghengzhi/kirikiroid2-web/blob/8b40dba4a18ec0a4429d6003d77eb8c3d3098821/tests/test_files/xp3/kag3_intro.xp3) · [浏览器场景](../../tests/browser/kag-intro.spec.ts)

## 已取回的第 119、120 批结果

两批构建日志均报告 `src/formats/image/png.ts(549,14): error TS7006`。整缓冲 PNG 计划和流式计划的回调参数类型不同，联合返回类型无法为匿名回调推断唯一类型。本批按整缓冲计划的接口将参数显式标记为 `Uint8Array`。如果发布构建再失败，工作流还会分别收集四个 TypeScript 项目的诊断，保留在原先的构建日志归档中。两批各有七组下游验证跳过，因此没有这两次提交的整套应用结论。[PNG 回调](../../src/formats/image/png.ts) · [119 全套运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45473097908) · [120 全套运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45475659242)

两批 JPEG 逐项比较均为 43/43，PNG 流式及调色板逐项比较均为 30/30、30/30。119 的原版 ERI 对照 11/11 匹配。120 的手工组 24/24、作者工具组 3/3 匹配。119 的 Windows 2022 窗口移动参考在 `caption-left-up` 场景中收到正确位置、目标和按钮状态，但原始中性移动消息的额外标签为 0，未触发按下和同步移动命令。120 同系统 7 个场景全部完成观察。本批在准备阶段单独发送禁止合并的移动消息，在窗口过程记录日志前读取该消息标签，并保留单次按下及目标确认。消息合并是针对这份日志采取的修正方向，成效须以新运行判断。[移动参考](../../tests/native/window-move.cpp) · [Windows MOUSEINPUT 说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)

算术熵编码、有损 ERI、其余非插件运行时差异及完整游戏验收仍未闭合。本批新增代码和验收均待 GitHub-hosted Actions 执行。

# 第 159 批 Deflate64 游戏包、Ogg 配乐定位和预渲染字幕

## 打开用 Deflate64 压缩的游戏和存档

有些 ZIP 的扩展名和普通发行包一样，内部成员却标为压缩方法 9。过去这些包可以列出文件名，但读到相应的启动脚本、XP3 或剧情时会失败。现在可按原来的游戏导入方式打开，存档导入也支持这种压缩方式。方法 9 使用最多 64 KiB 的滑动字典，其中两个距离码可引用 32 KiB 以外的数据，最长的长度码还能一次复制 65,538 字节。[ZIP 规范第 5.6 节](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) · [zlib 的方法 9 解码表](https://github.com/madler/zlib/blob/v1.3.1/contrib/infback9/inftree9.c)

解码器按段读取输入，支持未压缩块、固定码表和动态码表。读取一个成员的任何部分前，先核对整个成员的解压大小和 CRC32。超过整文件解码限额的素材仍可分段读取，连续读取使用会话已有的解压游标和缓存。中途停止会取消本次读取。[Deflate64 解码器](../../src/formats/zip/deflate64.ts) · [ZIP 成员读取](../../src/formats/zip/archive.ts)

托管 Ubuntu 上的 7-Zip 负责压缩并独立解包，记录工具版本、成员方法、原始和解压后的字节摘要。游戏库验收从这份 ZIP 里的原版 KAG 模板启动，实际点击剧情选项、保存、更改进度，刷新页面后再读回原槽位。底层用例另覆盖 65,536 字节距离、最长匹配、重叠复制、超过 64 MiB 的资源切片及存档 ZIP 导入。[归档生成与复核](../../scripts/generate-deflate64-game-fixtures.mjs) · [游戏库验收](../../tests/library-browser/custom-entry.spec.ts) · [范围读取验收](../../tests/conformance/deflate64.test.ts)

## 长 Ogg 配乐的跳转与循环

游戏把配乐定位到较晚的段落，或从循环尾回到中段时，以前的 Vorbis 解码器可能需要从逻辑音轨开头重解整段。现在播放器在扫描 Ogg 页头时记录少量适合恢复解码的位置。定位时重读该音轨的配置头，在目标之前的音频页恢复相邻包之间的重叠采样，再按页末的样本位置对齐。缺少可用定位点时沿用顺序解码。每次实际读取的音频页仍会校验，跨逻辑音轨时使用对应音轨自己的配置和起点。[Vorbis 页读取与定位](../../src/formats/audio/vorbis-source.ts)

托管用例用一段 96 秒的双声道配乐核对远跳、回跳、读到尾部和衔接下一条逻辑音轨时的样本。游戏中可点击按钮切换播放位置、暂停和恢复，并在靠近片尾的 SLI 循环中检查实际声音。[逐样本验收](../../tests/conformance/vorbis-seek.test.ts) · [游戏播放验收](../../tests/browser/long-vorbis.spec.ts)

## 半透明预渲染字幕

使用 TFT 预渲染字体的游戏以 0 到 64 表示每个像素的字形覆盖度。过去网页端把它扩展成普通 8 位透明度参与混合，低覆盖度的字边、阴影和淡入对白可能与原版不同。本批为映射到 TFT 的字形保留 65 级信息，依据原版整数运算合成不透明、普通透明和加法透明图层，并处理保持目标透明度的绘制选项。[字形合成](../../src/engine/graphics/glyph-color.ts) · [文字阴影](../../src/engine/graphics/glyph.ts)

原版 SDK 对照读取字形边缘、阴影和不同透明度下的像素。浏览器验收从实际游戏窗口点击四档字幕透明度，再与预期画面逐像素比较。[原版对照输入](../../tests/helpers/mapped-text.ts) · [字幕画面验收](../../tests/browser/mapped-text.spec.ts)

## 取回的结果

第 157 批现已终结。此前记录的影片测试类型错误导致应用构建失败，Node 和主浏览器验收跳过。该处代码已在第 158 批修订。[第 157 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45818780023)

第 158 批原版图形对照为 **113/113 匹配**，包括此前的四项字体度量差异和新加入的“是否使用返回值”对照。原版 KAG 为 117/119，两项已知的隐式终结时机差异仍有记录。此次快照里还没有第 158 批的应用构建、Node 和主浏览器结果。本批取回并核对了 22 份新的普通归档，共 60,412,236 字节，另复用 25 份既有原件。[第 158 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45821629019)

第 159 批实现提交 `6eb0f065bd569009705f3cb3aa1e07c78d0cb352` 已在 GitHub-hosted Actions 登记，登记时为 `queued`。下一批取回结果。[第 159 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45824742294)

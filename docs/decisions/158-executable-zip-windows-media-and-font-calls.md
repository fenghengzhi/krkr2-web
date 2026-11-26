# 第 158 批自解压 ZIP、Windows Media 过场和字体测量

## 从自解压发行包启动游戏

发行包是 Windows 自解压 ZIP 时，在“游戏位置”选择自动识别，再选择发行包。播放器读取 EXE 里的 ZIP 目录，使用包内的游戏程序目录、补丁和启动脚本。游戏库保存原始输入，再次启动时沿用同一包内目录和存档身份。对于目录里同时有游戏和安装器的发行版，已有游戏目录仍优先。只有多个自解压游戏时，可以在“游戏程序名”里填写所选发行包的路径。[项目定位](../../src/engine/storage/distribution.ts) · [游戏库读档验收](../../tests/library-browser/custom-entry.spec.ts)

有些打包工具将 ZIP 追加在程序后面，内部偏移仍从 ZIP 开头算起。另一些工具把偏移改成从整个文件开头算起。播放器用文件尾部的目录大小、位置和记录签名确定偏移基点，也会检查 ZIP64 的结束记录及定位器。这样可以按需读取素材，即使 ZIP 内某个原样存储的 XP3 恰好落在 16 字节边界，也能先辨认出外层 ZIP。读取成员时仍校验本地头、长度和 CRC。这里的 EXE 作为只读归档使用，ZIP 以外的安装器格式仍需先提取游戏文件。[偏移定位](../../src/formats/zip/executable.ts) · [ZIP 记录规范](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)

分卷包有两种常见命名。按字节切开的文件可以叫 `book.exe.001`、`book.exe.002`。PKSFX 的第一卷是 `book.exe`，其余卷按 `book.z02` 等编号，最后一卷是 `book.zip`。读取器用末卷的磁盘号辨认后一种布局，保留每卷自己的文件偏移。同名的独立 EXE 和普通 ZIP 可以分别使用。[分卷挂载](../../src/backends/files/archive-volumes.ts) · [两卷和三卷游戏验收](../../tests/conformance/pksfx-volumes.test.ts) · [PKWARE 规范第 8.4 节](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)

托管用例用 Python 标准库分别制作、读回 ZIP 和 ZIP64 的两种偏移形式，再交给 Web 读取器。用例还覆盖分成多个编号文件的发行包、含扩展数据的 ZIP64 记录和跨卷读取。游戏库用例从自解压包内的原版 KAG 启动，选择路线、保存、改变进度，再刷新页面从库中读回原槽位。[ZIP 与 ZIP64 对照](../../tests/conformance/executable-zip.test.ts) · [剧情与读档用例](../../tests/library-browser/custom-entry.spec.ts)

## Windows Media 过场

部分游戏用 ASF 容器播放 WMV 7 或 WMV 8 画面及 WMA 1 或 WMA 2 声音。网页播放器已把这些编码接入游戏内影片转换器，转换出的 MP4 继续走现有的播放、定位、音轨和图层显示路径。支持的视频文件可使用 .wmv、.asf 或 .wma 后缀。该路径要求文件含有视频轨，WMV3、VC-1 和受 DRM 保护的内容仍在当前范围以外。[格式路由](../../src/backends/video/legacy/format.ts) · [转换器构建配方](../../scripts/build-legacy-media.mjs)

Windows Media 的测试素材单独生成并用托管机器上的 FFmpeg 解码，记录逐帧时间、参考图像和音轨信息。游戏播放验收使用实际 WASM 转换器。Windows Media 和旧 MPEG／AVI 的素材检查分别记录结果，二者都纳入工作流的通过条件。[素材生成器](../../scripts/generate-legacy-video-fixtures.mjs) · [浏览器影片验收](../../tests/browser/legacy-video.spec.ts)

## 脚本是否使用文字尺寸

第 157 批的五项原版文字度量中有四项与预期不同。脚本单独写一行 `font.getTextWidth("A");` 时，TJS 可以丢弃返回值。原版 Font 在这种调用中先检查参数数量，然后跳过文本转换和位图度量。因此下一次读取空行高度仍可能是 0。如果脚本使用了宽度，例如将它赋给变量，位图会更新最近一次度量。两种写法只差是否取值，游戏随后排出的对白行高却可能不同。

第 158 批为宽度、高度及四个方向上的投影度量接入这项原生行为。新增的内核能力按导出来识别，已有内核仍可走原来的 TJS 包装。托管对照分别记录丢弃和实际取用返回值时的结果。[原版 Font 方法](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9678-L9699) · [Web Font](../../src/engine/tvp/font.ts)

## 取回的历史结果

第 155、156 批都通过类型检查和生产构建，随后旧 MPEG 测试素材生成失败。第 157 批停在浏览器测试的 TypeScript 检查，测试使用的 `findLastIndex` 超出当前编译目标。本批用反向查找替代这次调用，保留影片必须先报告帧、再触发提示点的断言。这三个批次均未运行依赖应用构建的 Node 和主浏览器验收。[第 155 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45813557063) · [第 156 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45815768302) · [第 157 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45818780023)

第 155、156、157 批的原版图形对照分别为 99/99、102/102、103/107。三批的原版 KAG 均为 117/119，仍有两项隐式终结时机差异。三批的 Wine 声音均为 46/46。此次固定快照核对了 79 份新的原始归档，共 134,129,691 字节。第 157 批取回时还有四个作业在运行，未报告项保留当时状态。

实现提交 `355ed18a0665e064df340a0021732db88ce452a0` 已在 GitHub-hosted Actions 登记，登记时为 `queued`。结果留到下一批取回。[第 158 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45821629019)

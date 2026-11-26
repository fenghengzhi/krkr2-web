# 第 170 批游戏 DVD、离线发布与影片首帧

## 从 UDF 游戏 DVD 打开章节

有些游戏 DVD 的镜像扩展名也是 `.iso`，盘上却只有 UDF 文件系统。播放器现在能从这类镜像中找到游戏程序目录、启动用的 XP3 和补丁。TJS 可以用 `Storages.searchCD` 查到盘符，从日文目录或盘内 ZIP 加载剧情。游戏盘以只读方式挂载，书签仍写入浏览器的存档目录。带 ISO 9660 或 Joliet 主目录的桥接盘沿用原有目录选择规则。[启动选择](../../src/engine/storage/boot-disc.ts) · [文件系统入口](../../src/formats/disc/filesystem.ts) · [按卷标查盘](../../src/formats/disc/volume-label.ts)

本批范围是单卷、2048 字节逻辑块、Type 1 物理分区和直接文件条目。读取器处理嵌入条目的小文件、短和长分配描述符、跨段文件、稀疏区及分配描述符续表。它按需读取盘上的扇区，检查描述符校验和、CRC 和块地址。连续且有 Blob 支撑的影片可以直接借用原始数据。虚拟分区、可替换分区和元数据分区留待后续。格式依据为 ECMA 对 UDF 的整理，独立制盘选用 1.02 和 2.01 两个版本。[UDF 格式资料](https://ecma-international.org/publications-and-standards/technical-reports/ecma-tr-112/) · [卷与分区](../../src/formats/disc/udf-volume.ts) · [目录和文件](../../src/formats/disc/udf.ts)

托管 Linux 使用 mkudffs 制作两张仅有 UDF 的盘，通过内核挂载写入原版 KAG 模板和项目编写的章节。只读重新挂载和 7-Zip 独立提取都须核对完整文件树和文件 SHA-256。会话用例还将相同卷标、相同文件路径的两张盘先后换入 G 盘，确认脚本确实换成新盘的内容，原书签仍可读取。浏览器验收从启动、选章和显示盘内图像开始，保存进度 42，继续到 99，再刷新并读取书签回到 42。[制盘与独立回读](../../scripts/generate-udf-game-discs.py) · [文件系统验收](../../tests/conformance/udf.test.ts) · [通过游戏会话换盘](../../tests/integration/udf-disc.test.ts) · [游戏库验收](../../tests/library-browser/disc-boot.spec.ts)

## 离线发布与影片切换

第 168 批在生成离线清单时遇到许可证目录中的 FFmpeg 时钟补丁，因缺少 `.patch` 的 MIME 类型而中止。本批将补丁作为纯文本发布。离线校验读取实际发布文件，将其 SHA-256 与影片转换器记录的源码补丁摘要核对。[离线清单](../../scripts/build/offline-shell.ts) · [发布验收](../../scripts/verify-offline-build.mjs)

此前的 Firefox 记录中，正在播放的影片仍在推进，后台准备的新影片已经缓冲完成，却没有解码或呈现第一帧。现在播放器在满足这个条件时尝试静音启动候选影片的解码，收到真实呈现回调后暂停，并在交付影片前核对首帧和起始位置。浏览器拒绝播放时保留原来的首帧等待和超时。[此前记录](165-disc-files-and-fragmented-movies.md) · [播放控制](../../src/backends/video/browser/host.ts) · [首帧恢复](../../src/backends/video/browser/first-frame-recovery.ts) · [实际影片与游戏按钮验收](../../tests/browser/video-first-frame-recovery.spec.ts)

## 已取回的托管结果

第 168 批最终有 26 个作业通过、5 个失败、15 个跳过。应用、Worker 和纯引擎的类型检查已通过，后续的离线打包失败，依赖生产构建的浏览器和 Node 验收随之跳过。[第 168 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408) · [生产构建](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408/job/140011737201)

第 169 批在取回时仍在运行。纯引擎类型检查通过，测试工具类型检查报告换盘用例用字符串索引三个资源名时发生 TS7053。本批给该资源表补齐键类型，保留原有 ZIP 延迟读取和换盘断言。取证时尚无该批应用构建和浏览器结果，第 170 批新增行为等待托管验收。[第 169 批类型检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/45852398659/job/140021867754) · [换盘用例](../../tests/integration/cdda-change.test.ts)

第 169 批的图层与转场像素对照为 128/128，新增的两项高强度描边均匹配。KAG 原版对照为 136/138。第 168 批的 Wine 声音对照为 60/60，Windows 声音对照为 50/60，余下 10 项记录为缺少声音驱动。[第 169 批图层与 KAG 对照](https://github.com/fenghengzhi/krkr2-web/actions/runs/45852398659/job/140021868176) · [第 168 批声音作业](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408)

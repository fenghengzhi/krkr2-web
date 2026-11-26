# 第 165 批光盘剧情文件与分段影片

## 从导入光盘读取游戏内容

游戏现在可从已导入的 ISO 9660/Joliet 光盘读取剧本、图片及内嵌 ZIP。单一 ISO 可自动绑定为 D 盘。玩家也可用现有光盘设置指定盘符，或导入 CUE 与其数据轨文件。原有 `Storages.searchCD` 找到卷标后，`G:/Routes/Story.ks` 等路径进入正常资源读取、AutoPath、脚本和图像加载流程。资源选择器可浏览光盘目录，盘内文件保持只读。游戏存档继续写入原 `System.dataPath`。[光盘接线](../../src/engine/storage/cdda.ts) · [公开路径](../../src/engine/storage/public-path.ts) · [资源选择器](../../src/engine/storage/selector.ts)

读取器依据 ECMA-119 的卷描述符、目录记录和文件 section，以及 Microsoft CDFS 的命名处理。它按路径读取所需目录，支持普通 ASCII 名称、Joliet UCS-2 名称、子目录、空文件、空目录及连续记录组成的多 extent 文件。查找忽略大小写，省略版本号时采用盘上首个同名版本，显式 `;版本` 精确匹配。空扩展的尾点按 CDFS 规则处理。目录枚举直接返回名称、大小及目录标记，空目录与不存在分别返回空数组和 `undefined`。[读取器](../../src/formats/disc/filesystem.ts) · [ECMA-119 第二版](https://ecma-international.org/wp-content/uploads/ECMA-119_2nd_edition_december_1987.pdf) · [Microsoft CDFS 目录处理](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/cdfs/dirsup.c)

CUE 数据轨支持 MODE1/2048、MODE1/2352、MODE2/2336、MODE2/2352，按 `INDEX 01` 和下一轨边界定位。raw 扇区验证同步头及 Form 1 子头。普通文件按 extent 和交错 unit/gap 取数据，偏移与大小使用精确整数，包含超过 4GiB 的文件。每次底层读取最多 64KiB，单次文件输出最多 64MiB。目录最多 8MiB、65,536 条记录，目录与文件元数据各有 32MiB 缓存上限。现有卷标读取仍只取描述符的小段头部。范围限于 ISO 9660/Joliet。UDF、Rock Ridge、主命名空间的 OEM 高字节名称、跨卷文件及 XA Form 2 未纳入本批。

连续单 extent、MODE1/2048、非交错文件还可传递底层已有的只读 Blob。借用时计入 `track.first` 和文件 extent 偏移，检查范围，并在异步借用前后检查取消。raw、交错及多 extent 文件继续分段读取。这让现有播放器能接收大于 128 MiB 的连续影片资源。新增用例核对 256 MiB 文件的实际借用偏移和长度，播放结果以托管运行为准。

## 独立输入与玩家路线

托管构建通过 `genisoimage` 生成卷标为 `KRKR_STORY` 的 Joliet 输入，并用 `isoinfo` 独立提取核对。内容包括英文与日文路径的 UTF-16LE 剧本、4×4 BMP、包含 `Bonus.tjs` 的 ZIP、空文件和空目录。新增 6 个格式层定义覆盖该真实输入、既有普通/Joliet ISO、四种扇区布局、非零 INDEX、版本选择、关联文件、多 extent、交错及范围检查。稀疏大文件用例还要求 Blob 借用没有新增数据读取，并保留取消检查。[素材生成](../../scripts/generate-story-disc.py) · [格式验收](../../tests/conformance/disc-filesystem.test.ts)

源码与字节码会话从光盘读取表达式，核对盘符路径往返、日文名称、目录与 ZIP 的 AutoPath、空文件及写入拒绝。实际游戏使用固定原 KAG 模板。玩家点击进入盘内章节，加载盘内图片，将进度 42 保存后改成 99。存入游戏库并刷新，再经原 Load 链接恢复 42。四个浏览器定义分别覆盖两个后端和源码/字节码，保存前后的原书签字节继续精确比较。[会话验收](../../tests/integration/disc-story.test.ts) · [原 KAG 游戏输入](../../tests/helpers/disc-story.ts) · [游戏库恢复](../../tests/library-browser/disc-story.spec.ts)

Windows 托管对照只读挂载同一组 ISO，先由系统读取日文文件与内嵌 ZIP，再由原 KRKR2 检查卷标查找、完整路径、本地路径、`Scripts.evalStorage` 和 AutoPath 的实际结果。输入哈希、原进程记录及卸载结果均保存。本批代码与这些验收尚待 GitHub-hosted 执行。[原版 Windows 对照](../../tests/probes/disc-volume.ps1)

## 分段 MP4 的音轨切换

第 160 批 Firefox 报告中，一部影片的原播放器已报 6.166666 秒。重新打开另一条音轨时，新播放器只报首段的 1.510666 秒，于是引擎拒绝切换，连 2 秒处的画面也无法验收。对于完整导入的分段 MP4，引擎现在用已解析的采样时间和编辑列表补齐选轨文件中声明为零的时长。已有的非零时长和媒体数据沿用原值，无法可靠计算时保留输入。索引可以从分段来源读取。[选轨实现](../../src/formats/video/mp4-audio.ts) · [Mozilla 关于分段影片时长的记录](https://bugzilla.mozilla.org/show_bug.cgi?id=1365148#c1)

新增验收逐包对照 FFmpeg 生成的独立记录，并比较选轨前后的画面时间。在实际游戏里，玩家跳到 2 秒、在暂停和播放状态切换语言，再回到同一帧。验收核对两个图层的完整像素和两条音轨各自的频率。另一组 Firefox 影片仍有在等待首帧呈现回调时超时的记录，需单独处理。[媒体文件对照](../../tests/conformance/video-fragment-duration.test.ts) · [游戏按钮与声音验收](../../tests/browser/video-fragment-duration.spec.ts)

## 已取回的运行结果

本批取回第 160 批的三份新浏览器报告。Firefox 第 4 分片完成 322 项，其中 271 项通过、51 项失败。Chromium 主浏览器和 WebKit 第 1 分片的作业均已取消。三份报告合计记录 1,568 项通过、205 项失败、1 项跳过，另有 211 项未报告。原版 `kag3_intro.xp3` 的第一条路线、书签和刷新恢复在 Chromium、Firefox、WebKit 上的 Asyncify 与 JSPI 六个组合均已通过。第 161 至 164 批在取回时均为 `pending`。[第 160 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404) · [第 160 批 Firefox 第 4 分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938356276)

旧配乐焦点测试在页面切换后仍报告拥有焦点，播放器也没有收到后台音量命令。本批将 Chromium 的四个组合放到现有的独立浏览器进程中，使用实际标签页切换，核对可信焦点事件、音量命令及左右声道的采样。Firefox 与 WebKit 继续保留原焦点验收。三份新产物共 440,878,681 字节，连同此前存档的 50 份，53 份普通原件的大小和 SHA-256 均与本次目录一致。归档摘要存放在 `out/verification/github-actions/165-archive-summary.md`。[焦点验收](../../tests/helpers/wave-focus-browser.ts) · [独立 Chromium 入口](../../tests/activity-native-browser/wave-focus.spec.ts)

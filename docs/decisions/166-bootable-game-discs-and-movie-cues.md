# 第 166 批光盘游戏启动与影片事件

## 从光盘启动游戏

导入只含游戏光盘的文件集合时，可以直接选择单个 ISO，或一起选择 CUE 与轨道文件。自动识别也会在光盘目录中查找原游戏，支持位于子目录的 `data.xp3`、`content-data/`、`data/` 和合并版启动程序。已经找到的本地游戏保留原选择顺序。一张 CUE 和它引用的 ISO 只算一张盘。若有两张独立光盘都含游戏，可以在“游戏程序名或发行包”指定要启动的文件。[光盘选择](../../src/engine/storage/boot-disc.ts) · [项目入口](../../src/engine/storage/distribution.ts)

以盘中 `DiscGame/data.xp3` 为例，游戏程序目录是 `file://./d/discgame/`，剧本工作目录是 `file://./d/discgame/data.xp3>`。游戏可以用原路径打开补丁、声音、脚本及图片。光盘只读，默认的 `System.dataPath` 使用该游戏独有的可写目录 `game://./savedata/`。按程序目录展开的存档位置也以此游戏的可写空间为基准。游戏库存放原始介质，重启时按已保存的光盘和项目目录打开。更改映射盘符后，同一个库项目保留存档身份。[系统路径](../../src/engine/system/environment.ts) · [存档身份](../../src/player/game-identity.ts) · [重新打开与更换盘符的验收](../../tests/conformance/boot-project.test.ts)

托管 Ubuntu 制作两张包含固定原版 KAG 模板的 Joliet 镜像，逐一提取盘内的游戏输入并对比字节。镜像内还有用于标识程序名的占位文件及相邻配置文件，浏览器核对实际读出的程序名与配置参数。浏览器分别通过单 ISO 和 CUE 加 ISO 启动，真实点击进入光盘章节、存入进度 42、改为 99，再由游戏库刷新并读回 42。另一项会话验收为数据轨前置 150 个音频扇区，核对按 CUE 索引读取项目且写档落在光盘之外。Windows 原版对照读取同一张盘，检查 XP3 脚本、菜单标签和图像像素。[独立制作](../../scripts/generate-boot-disc.mjs) · [混合模式光盘](../../tests/integration/boot-disc-range.test.ts) · [游戏库验收](../../tests/library-browser/disc-boot.spec.ts) · [Windows 原版对照](../../tests/probes/disc-boot.ps1)

## 影片图层与剧情提示帧

第 160 批留下了影片时钟跨过目标、画面却还在前一帧时触发剧情提示的记录。原版在帧更新回调之后比较实际画面编号。现在图层或混合模式已经交付播放帧后，由交付帧的回调决定提示何时触发。若浏览器跳过目标帧，后续第一个到达或越过目标的帧可以触发一次提示。覆盖显示模式及尚未交付画面的路径继续使用时钟后备。新影片或变更显示模式时重置该状态。[原版帧更新](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L679-L751) · [浏览器播放器](../../src/backends/video/browser/host.ts) · [提示帧验收](../../tests/browser/video-frame-cue.spec.ts)

混合图层颜色验收现在按原版的目标图层几何在色块内部取样。过场时钟的亚毫秒对照使用实际可定位的时间，重开影片的画面比较追踪此前真正交付给图层的画面及其来源。另一组 Firefox 首帧呈现回调超时仍待解决。[混合图层](../../tests/browser/video-colors.spec.ts) · [时钟](../../tests/browser/video-clock.spec.ts) · [过场重开](../../tests/browser/video-prepare.spec.ts)

## 恢复普通应用构建

第 161 至 163 批的独立测试工具类型检查都停在 WAVE 读取器的两个 TS7022 错误。第 161 批的应用、engine 和 worker 类型检查也报同样错误。本批给生成器读取的 `header` 和解析后的 `length` 补上显式类型，读取范围、块扫描和原有格式兼容分支保持原行为。[WAVE 读取器](../../src/formats/audio/wav-native.ts) · [第 161 批类型检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/45831107660/job/139973430628)

第 162、163 批的影片转换器在应用固定 FFmpeg 5.1.9 补丁时失败，尚未进入编译。应用构建随后因缺少转换器产物而停止。本批将相同的 MPEG-1 时钟修改重新写成前后各三行上下文的标准补丁，保留严格的 `--fuzz=0`。构建日志增加补丁和应用前后源码的 SHA-256，便于下一次核对实际输入。[补丁](../../native/legacy-media/elementary-mpeg1-clock.patch) · [构建脚本](../../scripts/build-legacy-media.mjs) · [第 162 批转换器失败](https://github.com/fenghengzhi/krkr2-web/actions/runs/45832905859/job/139977475164)

这些修正只经过源码检查。后续仍需由既有 GitHub-hosted 类型检查、转换器构建和真实影片验收确认。

## 本轮取回的结果

本轮对第 160 至 165 批各取一次已发布状态，新增保全 81 份普通 ZIP，共 194,248,009 字节。连同复用的 53 份，134 份原件的大小与 SHA-256 全部符合冻结目录。原报告、失败附件和未报告范围继续保留，摘要位于 `out/verification/github-actions/166-archive-summary.md`。

第 160 批已结束。最后公布的 WebKit 主浏览器第 3 分片完成 324 项，其中 304 项通过、20 项失败。失败包括真实目录选择超时 2 项、远程清单与脚本编码各 4 项、字幕截图尺寸 8 项，以及分段影片音轨选择 2 项。同一报告中的另外 10 项音轨选择和 8 项音轨交接通过。此前取消作业留下的 Chromium 189 项、WebKit 第 1 分片 22 项未报告，以及 Node 取消和 WebKit 第 4 分片缺少普通报告的情况仍然有效。[第 160 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404) · [WebKit 第 3 分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938356468)

原版 Introduction 样例的第一条实际路线、书签和刷新恢复，继续保留三浏览器、两个后端共 6/6 通过的第 160 批证据。第 161、162 批已结束并失败，第 163 批在快照时仍运行，但应用构建已经受阻。三批依赖应用构建的 Node、主浏览器和游戏库验收被跳过。第 164、165 批仍为 `pending`。[第 161 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45831107660) · [第 162 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45832905859) · [第 163 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45834683767) · [第 164 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45837990362) · [第 165 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45840946389)

## 原版对照与仍未完成的范围

第 161 批原版 KAG 为 127/129 匹配，第 162、163 批各为 132/134 匹配。新增五项属性 setter 和五项控制标签属性对照全部匹配。两项旧差异保留，其中 `live-condition` 的实际 YES 分支、清理后的标签字段与条件层级一致，差异落在夹具的对象终结计数。本批没有把它当成新的剧情分支故障，也没有改写原预期。

三批普通图层和转场对照均为 124/124 匹配。ERI 作者输入、原编码器输入和 DCT 分别为 49/49、10/10、15/15，PNG stream 与 palette 各 30/30，JPEG 为 43/43。Wine 声音对照均为 54/54。Windows SLI/WAVE 则各有 46 项匹配、8 项因缺少声音驱动未取得预期行为。新增五个 RIFF 开片与头部读取对照均匹配，实际播放仍保留其设备限制。[普通对照工作流](../../.github/workflows/test.yml)

独立 alpha 矩阵仍只有 1 项匹配、80 项未报告，原版配置五组也未完成。逐报告路径、大小、摘要和状态保存在 `out/verification/github-actions/166-reference-summary.json`。这些原版结果有各自的输入与范围，网页游戏兼容仍需后续托管验证。第 166 批当前没有执行结果，整体目标继续进行。

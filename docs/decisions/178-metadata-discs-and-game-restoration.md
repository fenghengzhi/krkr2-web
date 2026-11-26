# 第 178 批游戏光盘、旧版存档与媒体播放

## 光盘上的日文章节

有些游戏盘把目录、文件入口和文件集放在 UDF 2.50 元数据分区中。读取这些结构时，逻辑块号指向元数据文件内的位置，分段的元数据文件又可能位于物理分区或可替换分区。播放器沿这两层地址读取目录和脚本，游戏的大文件仍可按范围读取。在主元数据文件入口无效时，读取器会尝试镜像入口。标有独立副本的光盘还可以在查找目录或脚本遇到元数据校验错误时使用镜像。[分区与镜像读取](../../src/formats/disc/udf-volume.ts) · [UDF 2.50 第 2.2.10、2.2.13 节](https://ecma-international.org/wp-content/uploads/ECMA_TR-112-3_1st_edition_december_2023.pdf)

同一张桥接盘可以有两套文件名。例如，脚本要求的日文章节名在 ISO 9660 一级目录中可能只剩一个短文件名。本批按卷识别区读取可挂载的 UDF，查卷标和打开文件使用同一套目录选择规则。UDF 无法识别或校验失败时，仍可挂载光盘里的 Joliet 或 ISO 9660 目录。微软 IMAPI 导入文件系统也采用 UDF、Joliet、ISO 9660 的优先顺序。[目录选择](../../src/formats/disc/filesystem.ts) · [卷标选择](../../src/formats/disc/volume-label.ts) · [Microsoft IMAPI 文件系统导入](https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-importfilesystem)

托管验收使用 Windows IMAPI 分别制作纯 UDF 和 ISO/UDF 桥接游戏盘，均带冗余元数据。7-Zip 分别解出两张盘的 UDF 目录，比对每个文件。桥接盘还以 ISO 模式独立解出，用于检查同一章节的两种名字。Windows 默认挂载的文件系统、实际日文路径和章节散列值另行核对。网页验收从同一批镜像启动原版 KAG、进入章节、保存，并在刷新游戏库后读回书签。分段元数据、镜像读取和 ISO 回退有各自的用例。[制盘](../../scripts/author-metadata-disc.ps1) · [独立解盘](../../scripts/verify-metadata-disc.py) · [完整目录比对](../../tests/conformance/udf-metadata-game.test.ts) · [游戏内验收](../../tests/library-browser/disc-boot.spec.ts)

## 在新版本游戏中恢复旧电脑的进度

玩家只有旧电脑导出的 JSON 备份时，可以在“浏览器备份（JSON）”中暂停当前游戏，选择“从浏览器备份选择存档目录”。面板显示备份的来源游戏标识和目录，玩家可以选中原版存档所在的子目录。确认后，播放器把其中的书签、玩家笔记等文件写入当前游戏的存档目录，保留子目录结构并替换同名文件。普通整份备份导入继续检查游戏标识。切换格式、恢复运行或更换游戏都会使待确认的选择失效。[备份读取](../../src/player/save-backup.ts) · [目录选择](../../src/app/native-save-zip.ts)

验收由旧版 KAG 游戏实际建立书签，再从新的浏览器存档数据库启动新版游戏。它分别检查两个版本的原有进度、同名书签替换、无关文件保留，以及刷新后在游戏里重新读回旧章节。另有相对路径、日文文件名、大小写冲突和取消时的原子性检查。[跨版本游戏验收](../../tests/library-browser/save-backup-migration.spec.ts) · [存档目录回归](../../tests/conformance/save-backup-directory.test.ts)

## 配乐在正确的乐句切换

普通 Wave 可以通过同名 SLI 文件设置条件跳转。若某个标签改变后续跳转所读的标志，原版解码器先决定当前读取单元的终点，再处理单元内的标签。此前网页播放器在听到标签时立即重选跳转，有时会在第一遍就错过应播放的乐句。本批让这种配乐按原版每秒八个单元的顺序解码。脚本改标志会影响后续选择。游戏定位或停止时会重新建立解码位置。流式配乐等待尚未到达的音频页时保留已选的读取范围。[原版 WaveLoopManager](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveLoopManager.cpp#L438) · [音频分段读取](../../src/engine/media/filtered-wave-source.ts)

新增验收比较左右声道的实际采样与游戏收到的标签顺序，覆盖普通文件、流式读取、暂停和修改标志后重播。浏览器验收通过游戏按钮换分支，并从实际输出的两条声道辨认乐句。原版 SDK 另外记录第一段标签，便于从同一份输入比对游戏里实际选择的乐句。[采样和标签用例](../../tests/conformance/wave-conditional-unit.test.ts) · [TJS 游戏内验收](../../tests/integration/wave-conditional-unit.test.ts) · [浏览器乐句验收](../../tests/browser/wave-conditional-unit.spec.ts) · [原版 SDK 对照](../../tests/probes/sli-sdk.ts)

## 影片暂停后的时钟

第 171 批 WebKit 的一个多音轨影片用例完成了首次呈现。游戏图层画面、播放器画面和重复读回的像素一致。但播放器在首帧回调中暂停解码器，当时记录的媒体时间为零，随后浏览器送来的暂停事件中，时间已经是 0.475924583 秒。两次读取之间没有发生定位。播放器现在在临时播放成功取得首帧后，先等真实暂停事件，再判断是否需要定位、是否需要新的呈现回调。事件丢失、取消和已经暂停的情况分别处理。该改动等待托管验收，Firefox 从未送达首帧的另一组失败仍在追踪。[恢复逻辑](../../src/backends/video/browser/first-frame-recovery.ts) · [WebKit 暂停实现](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/html/HTMLMediaElement.cpp#L4615)

## 此次取回的结果

第 171 批取回时仍在运行。新增的 Firefox 游戏库报告有 69 项通过、37 项失败。Firefox 常规第 3 分片有 302 项通过、22 项失败，WebKit 常规第 3 分片有 321 项通过、3 项失败。三份报告合计 692 项通过、62 项失败。Node 作业已取消，报告只留下 14 个通过的顶层项目，剩余范围未报告。第 172 至 177 批取回时都在排队。[第 171 批托管记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320) · [第 177 批托管记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45870448777)

第 170 批 Chromium 常规套件取消时，还有 721 项未报告。自本批起，三款浏览器的常规用例都分在四台托管 runner 上，每个分片保留自己的日志和结果。游戏库和离线套件各自整组运行。[第 170 批 Chromium 作业](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169086) · [托管批次配置](../../.github/workflows/test.yml)

第 178 批实现提交 `b3974a2` 登记时为 `pending`。登记后修正了一条流式配乐测试的单采样边界预期，该修订随下一批验证。[第 178 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45873527327)

# 第 167 批光盘发行包、明朝字体与 WAVE 声道

## 从 ZIP 内的游戏光盘启动

选择“自动识别游戏目录、ZIP 或光盘”后，可以直接导入装有 ISO 或 CUE 及数据轨的 ZIP。分卷 ZIP 需要同时选中全部文件。若 ZIP 中已经有安装好的游戏，自动识别优先选择它。若有两张盘都可以启动，界面会列出可填入“游戏程序名或发行包”的路径，例如 `Release.zip>Media/Disc2.cue`。游戏库同时记住外层发行包和盘片，在更改映射盘符后仍使用同一存档目录。[项目选择](../../src/engine/storage/distribution.ts) · [光盘启动](../../src/engine/storage/boot-disc.ts) · [存档身份](../../src/player/game-identity.ts)

游戏仍从光盘虚拟盘符读取启动脚本、XP3 及补丁，启动程序旁的配置也从盘内读取。盘符可绑定到发行包内的相对路径，也可写明外层 ZIP。读取 ZIP 成员时沿用既有的完整性校验，大镜像的首次读取可能需要扫描整个压缩成员。[盘符绑定](../../src/engine/storage/cdda.ts) · [ZIP 成员读取](../../src/formats/zip/archive.ts)

托管用例把同一套原版 KAG 测试游戏分别包装为含 ISO 的单个 ZIP，以及含 CUE 和 ISO 的三片 ZIP。两个分割点均落在压缩后的 ISO 数据内。Python 写入，Info-ZIP 解压逐字节比较。浏览器导入原始发行文件，在剧情中保存进度 42、将进度改为 99，刷新后重新从游戏库启动并读回 42。另有用例核对指定光盘、盘符变更、多个可用光盘的提示及安装好的游戏的启动优先级。[制盘与包装](../../scripts/generate-disc-releases.py) · [选择与重开](../../tests/conformance/disc-distribution.test.ts) · [浏览器章节和书签](../../tests/library-browser/disc-boot.spec.ts)

## 日文明朝字体

部分原版游戏用日文名指定明朝字体。游戏内字体和浏览器现在会匹配 `ＭＳ 明朝` 与 `MS Mincho`、`ＭＳ Ｐ明朝` 与 `MS PMincho`。实际存在的同族字体优先，缺少对应字体时使用衬线替代。浏览器验收使用项目自制的两套不同宽度的字形，逐像素比较按家族名选择与直接读取字体文件的结果。微软原字体的实际字形以及不同 Windows 区域设置下的字体枚举仍有各自的验证范围。[字体名称](../../src/engine/graphics/font-family.ts) · [游戏字体选择](../../src/engine/graphics/fonts.ts) · [浏览器替代字体](../../src/backends/text/browser/families.ts) · [对白字形对照](../../tests/browser/font-localized-mincho.spec.ts)

## 多声道声音

一些 WAVE 文件通过扬声器掩码区分中置、低音、后置或侧置声道。以四声道为例，中央对白和后置中央声道现在都分配到左右声道，原有的四角布局仍把后左和后右分开处理。明确映射的低音声道沿用既有立体声输出策略。声道元数据依据固定原版源码。Windows 对照记录原版打开这些文件的结果，Web 的双声道输出另用 FFmpeg 的具名声道表达式逐样本核对。[原版 WAVE 格式读取](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp#L626-L648) · [Web 混音](../../src/engine/media/wave-speaker-mask.ts) · [格式与播放验收](../../tests/conformance/wave-speaker-mask.test.ts) · [FFmpeg 对照](../../tests/probes/wave-speaker-mask-reference.ts) · [浏览器播放](../../tests/browser/wave-speaker-mask.spec.ts)

## 已取回的结果

第 166 批已经发布的普通原版对照中，图层与转场匹配 126/126，KAG 匹配 132/134。跨第 163 至 166 批取回的 103 份普通工件均已核对大小和 SHA-256。此前 Introduction 首条路线的六个浏览器与后端组合均已通过，该结果属于第 160 批。[第 166 批运行记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45843758935) · [第 160 批证据范围](166-bootable-game-discs-and-movie-cues.md)

第 160 批两项 WebKit 目录选择验收在 Playwright 等待文件选择器完成时超时，已有浏览器事件却记录了本次选择的全部 41 个文件及正确的目录，应用也已启动所选游戏。本批保留原超时，只在路径与大小、可信输入事件、表单状态及运行中的游戏会话全部吻合时继续检查原有游戏画面和存档。[目录选择验收](../../tests/helpers/game-directory-input.ts)

第 163、164、165 批最终均失败，旧 WAVE 类型错误和影片转换器补丁失败阻断了普通验证。第 166 批的测试与构建工具类型检查已通过。取证时其影片转换器仍在运行，应用构建和依赖它的浏览器结果尚未公布。第 167 批新增的行为等待后续批次取回各作业结果。[第 163 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45834683767) · [第 164 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45837990362) · [第 165 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45840946389) · [第 166 批工具类型检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/45843758935/job/139991941664)

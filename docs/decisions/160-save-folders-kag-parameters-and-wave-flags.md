# 第 160 批 ZIP 游戏启动、桌面备份读档、KAG 宏参数与配乐分支

## 从带说明文件的 ZIP 发行包启动

在自动模式中一起选择游戏 ZIP 和外部说明文件时，播放器会从候选 ZIP 内查找入口或原版项目。目录中已有散装游戏、原生项目或可用的自解压发行包时，沿用既有选择。若同一目录有多个可玩的普通 ZIP，界面给出候选包路径，可在「游戏程序名或发行包」指定要玩的版本。存入游戏库后，重开使用当时选中的发行包。[项目查找与恢复](../../src/engine/storage/distribution.ts) · [多发行包游戏库验收](../../tests/library-browser/custom-entry.spec.ts)

## 从完整桌面备份里恢复存档

有些桌面备份将游戏目录和存档一起打进 ZIP。例如，游戏需要在自己的存档目录找到 `migration0.bmp`，原版备份里的名字却是 `旧版/SaveData/migration0.bmp`。此前整包导入会保留外层目录，游戏的读档菜单就找不到这个槽位。

暂停游戏，在「存档与备份」中选择「原版游戏存档」，点击「从 ZIP 中选择存档目录」，选到实际的存档目录后点击「导入此目录」。播放器显示本次选中的文件数和总大小，把目录内的文件按相对路径导入当前游戏的存档位置。缩略图附带的书签和嵌套文件保留原始字节，同名文件按已有存档导入规则替换。继续游戏即可从原来的读档菜单恢复。整包、散装文件和磁盘目录仍可用原入口导入。[存档界面](../../src/app/native-save-zip.ts) · [成员读取与校验](../../src/player/native-saves.ts)

选择目录时只读 ZIP 索引，确认后才读取所选成员并校验其 CRC。即使完整备份超过 96 MiB，也可以导入其中的小目录，选中的存档仍受 64 MiB 与 10,000 个文件的限制。托管用例包含一个带 97 MiB 游戏资源的备份。原版 KAG 模板的浏览器验收先存下剧情值 99，再导入带缩略图的旧槽位，重新打开游戏后从槽位读回剧情值 7。[目录与大小验收](../../tests/conformance/native-saves.test.ts) · [实际读档流程](../../tests/browser/native-saves.spec.ts)

## 剧情宏读取动态参数

KAG 场景可以用 `%caption` 等写法读取宏参数。游戏脚本可以给参数字典安装属性读取函数，根据当前剧情进度返回不同的选项文字或跳转目标。过去 Web 端从整份字典的副本中取值，会绕过这个读取函数。现在每次引用具名参数时都在 TJS 中读取该字段，读取函数能看到当时的游戏状态。使用 `*` 转发整份宏参数时仍沿用字典复制规则。[原版 KAG 参数读取](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L2193-L2226) · [剧情标签解析](../../src/engine/kag/parser.ts) · [TJS 参数读取](../../src/engine/tvp/kag.ts)

新增验收在原版 KAG 模板上显示由游戏状态产生的选项，点击后走向对应章节，保存后修改进度，再次启动游戏并读回书签。原版 SDK 另有五项对照，覆盖重复读取、字段转发、返回值类型、异常和书签恢复。[游戏分支验收](../../tests/browser/kag-parameter-properties.spec.ts) · [原版对照输入](../../tests/helpers/kag-parameter-properties.ts)

## 配乐分支标志一起复位

游戏可以用 16 个 WAVE 标志决定 SLI 循环接下来播放哪段音乐。过去 `flags.reset()` 需要依次向混音器发送 16 条命令，播放中的音轨可能在两条命令之间读到部分清零的标志，从而走进错误的音乐分支。现在一条混音命令就能把同一音轨的全部标志清零。当前播放位置和已经排队的音频继续保留。播放器与会话 Worker 的协议升到 59，使页面和 Worker 对这条命令使用相同约定。[原版标志复位](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveLoopManager.cpp#L208-L212) · [混音器](../../src/engine/media/mixer.ts) · [游戏声音接口](../../src/engine/media/sounds.ts)

托管用例为清零前、清零后和部分清零分别编写了可辨认的乐段，从游戏按钮执行复位，采集实际 AudioWorklet 输出。另在可控的播放时钟上逐样本检查分支处的左右声道。[逐样本用例](../../tests/conformance/wave-flags-reset.test.ts) · [游戏声音验收](../../tests/browser/wave-flags-reset.spec.ts)

## 应用构建与测试代码的检查

第 158 批已结束。工具类型检查报告 PKSFX 用例读取了不存在的 `error` 事件。引擎通过 `log` 事件的 `level` 字段报告错误，本批修正了断言。第 158 批的 Node、主浏览器和旧影片素材检查均已跳过。[失败运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45821629019) · [PKSFX 用例](../../tests/conformance/pksfx-volumes.test.ts)

测试与构建工具的 TypeScript 检查现在作为单独的托管作业运行，保留编译输出，也是整批通过的必要条件。应用本身的三个 TypeScript 项目、生产构建及离线文件校验继续决定能否生成供浏览器运行的播放器。这样能在同一批里同时取得测试代码的诊断和可运行应用的验收结果。[工作流](../../.github/workflows/test.yml) · [构建命令](../../package.json)

第 159 批的原版图形对照已有 **124/124 匹配**，包括新增的 11 个 TFT 字形、阴影及透明度用例。原版 KAG 为 117/119。取回时普通应用仍在构建，Node、主浏览器、Deflate64 和长 Ogg 素材检查均未报告。本次新取 27 份普通归档，共 63,002,036 字节，另复用 20 份已校验原件。[第 159 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45824742294)

第 160 批实现提交 `58f64696cc96b01ffb2f7933c017cbdb1aa3209e` 已在 GitHub-hosted Actions 登记，登记时为 `queued`。下一批取回结果。[第 160 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404)

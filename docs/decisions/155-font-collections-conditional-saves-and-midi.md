# 第 155 批游戏字体合集、条件分支读档与 MIDI 声像

## 一个字体文件包含多个家族或字重

TTC 和 OTC 可以让多种字体共用同一份字形数据，各自保留名称、字宽、字符映射和排版表。此前游戏库内和临时载入的游戏都只发现第一种字体。现在游戏的字体选择框可以列出其余成员。剧情用家族名选择字体时，会按所求粗体和斜体匹配实际成员。按文件名直接打开合集仍使用第一个成员。带纵排度量的成员也会出现在纵排字体列表中。[OpenType 合集格式](https://learn.microsoft.com/en-us/typography/opentype/spec/otff#font-collections) · [游戏字体目录](../../src/engine/graphics/font-catalog.ts)

目录扫描只读取元数据，来自多个成员的相同表范围只读一次。游戏字体单文件上限仍为 16 MiB，一份文件的元数据读取预算为 1 MiB。游戏实际绘字时，播放器把成员编号交给 FreeType。缓存同时区分资源和编号，同一成员的横排和纵排可共用已打开的字形数据。游戏的 Pad 文本窗口和仅接受单份字体的绘图后端会收到选定成员的独立 OpenType 文件。[字体加载](../../src/engine/graphics/fonts.ts) · [独立字体的偏移与校验](../../src/formats/font/collection.ts)

验收使用项目自制的三成员合集。玩家依次看到常规、等宽和粗体文字，两字宽度应为 20、28、36 像素，再切回第一种。每次把实际面板和直接载入独立 TTF 的参照面板逐像素比较。另有共用字形表的双成员合集，覆盖浏览器 FontFace 和游戏 Pad 的实际字宽。[对话画面验收](../../tests/browser/font-collection.spec.ts) · [元数据与表校验](../../tests/conformance/font-metadata.test.ts) · [Pad 验收](../../tests/browser/pad.spec.ts)

## 从嵌套条件中的剧情书签继续

原版把每层条件记录为八个十六进制字符，恢复时每读一层把读取位置向前移动一个字符。因此在排除剧情分支时留下的书签，读回后可能和首次经过同一标签时选择不同的后续标签。Web 此前按八字符分组恢复。现在从存档恢复当前场景和调用栈里的条件时采用原版读取方式，未经过读档的普通剧情调用和返回仍复制当时的条件状态。[原版保存与恢复](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L650-L693) · [KAG 解析器](../../src/engine/kag/parser.ts)

原版 SDK 和 Web 使用相同的条件剧情，分别观察初次游玩、书签恢复、调用后返回，以及保存到文件再读取。浏览器验收从原版 KAG 模板中的可点击选项进入恢复路线，用游戏菜单存档、改变剧情后再读回。[条件书签](../../tests/helpers/kag-condition-stack.ts) · [实际游戏路线](../../tests/browser/kag-condition-stack.spec.ts)

## 配乐复位时的音量与左右位置

KRKR2 处理 MIDI 文件中的 CC121 控制器复位时，还会另行发送按声音对象音量计算的 CC7。脚本直接调用 `MIDISoundBuffer.midiOut` 只发送脚本给出的消息。播放器现在区分这两条路径，并采用旧 Windows GS 合成器处理 CC121 的规则。值为零时保留设备的声道音量和左右声像，非零时同时恢复这两项。同一首配乐循环或停止后重新播放时，声像保留到曲谱发送新的控制。Web 使用自己的合成音色。[原版 MIDI 播放实现](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L495-L515) · [微软旧 GS 兼容行为](https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode)

验收将控制器复位与明确写出音量、表情和声像的参考乐谱对照。浏览器通过游戏按钮触发操作，再从 AudioWorklet 采样，检查左声道独奏、回到中央、音量变化及停止后的静音。[声音采样验收](../../tests/browser/midi-controller-reset.spec.ts)

本批合计新增 12 项 Node 验收，每个常规浏览器项目新增 17 项定义，原版 SDK 的 KAG 对照新增 5 项。实际结果等待托管执行。

实现提交 `c6e23ad7c53067530c3239b52a2ef84b3362998b` 已提交 GitHub-hosted Actions，登记时为 `pending`，结果留到下批取回。[第 155 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45813557063)

## 本次取回的托管结果

第 148、149 批已结束。第 150 批取回时仍有一项 Wine 声音对照在运行，第 151 至 154 批仍在排队。本次取回并核对 50 份新原始归档，共 121,635,273 字节，另复用 24 份既有原件。第 149、150 批的应用构建都停在 `video-prepare.test.ts` 的 TS2367，依赖构建的网页验收跳过。第 153 批已经提交这一类型错误的修复，仍待托管结果。[第 149 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45793541359) · [第 150 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45796411933) · [第 153 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45808179488)

第 150 批原版 KAG 的 99 项中有 95 项匹配。已有三项剧情结尾差异继续保留，新出现的 `partial-current-call` 报告从 void 转换为对象失败。归档中没有该用例拟保存的文件，尚不能将错误定位为读回时的行为。两批原版配置各有五份进程记录，路径、参数和图像缓存限额可从记录核对，但后续步骤中断，整项配置对照仍未通过。[第 150 批原始托管记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45796411933)

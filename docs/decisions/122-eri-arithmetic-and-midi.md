# 122　无损算术 ERI、MIDI 和游戏验收

本批接入两条游戏会用到的资源路径。图层可以加载采用旧 ERINA 算术编码的图片，MIDI 音轨可以处理分段重置命令及原引擎支持的系统消息。原版 KAG 介绍程序的启动、翻页、书签、刷新读档和退出继续随同一提交验收。[KAG 浏览器场景](../../tests/browser/kag-intro.spec.ts)

## 无损算术 ERI

架构 32 使用前一个符号选择概率表。帧 1 和 4 预读块操作表，随后用 1 至 8 位有符号字母表还原残差，复用既有的块重排、像素预测和方向转换。帧 2 在跨行保持模型的同时还原连续的 8 位索引。图层沿用调色板、色键和伴随灰度遮罩处理。加载器在预算内解码至私有图像，成功后才发布；超过范围的位宽会报错。有损 ERI 仍待实现。[播放器加载入口](../../src/formats/image/eri.ts) · [算术模型](../../src/formats/image/eri-arithmetic.ts)

算术区间使用无符号 32 位寄存器，每个上下文的频数总和达到 65,536 时折半。初始化、连续 32 个一位时的填充、输入耗尽后的续位均按固定版本源码实现。x86 汇编和标量 C++ 的续位上限不同，播放器采用 x86 分支。已完成的 121 原版对照样本只涉及此前支持的编码。122 新增输入用独立的整数区间构造，像素期望来自选定的原始颜色和索引。Windows SDK、Web 图层和预期像素逐项比较，另在 Web 侧覆盖损坏数据与模型缩减。[原版初始化](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/library/common/experi.cpp) · [原版 x86 读取](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/library/asm/experia.asm) · [独立输入](../../tests/helpers/eri-arithmetic-fixtures.ts) · [SDK 比较](../../tests/probes/eri-sdk.ts)

本批 Windows 原版 ERI 计划包含 49 个手工场景和 10 个作者工具场景。新增十个算术输入覆盖 RGB、RGBA、正负高度、块操作、较窄符号、调色板、灰度，以及连续一位触发的填充；另有三个独立的色键和遮罩组合。Web 侧的压力输入用 256×256 图像跨越多次模型缩减。Session 和浏览器验收通过真实的 `Layer.loadImages` 加载，分别检查脚本可读的像素、最终画布，以及伴随遮罩损坏后的恢复。[图层集成](../../tests/integration/eri-truecolor.test.ts) · [浏览器验收](../../tests/browser/eri-loading.spec.ts)

## MIDI 打开与播放

脚本可以分别重设 `TJSReadError` 和 `TVPInvalidSMF` 的消息。读取不完整的 SMF 文件头、音轨头或声明的音轨数据时，现在走前一个消息。完整读到错误的文件标记、轨道标记或不支持的格式时，使用后一个消息并带入原版原因。Windows 对照让原版 `MIDISoundBuffer.open` 依次打开八个输入，保存脚本实际收到的消息，与 Web 端同一组字节比较。[固定版 Win32 MIDI 源码](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp) · [输入与原脚本](../../tests/helpers/midi-contract.ts) · [SDK 比较](../../tests/probes/midi-sdk.ts)

节拍事件按原版 32 位无符号值读取，零值恢复每四分音符 500,000 微秒。系统公共消息按状态消耗参数，使它们之后的音符保持对齐。浏览器合成器在完整接收已识别的 GM、GS 或 XG 重置包时清除活动音符并恢复通道设置，允许一个包跨多个文件事件。节拍和合成器状态由独立合约检查，Session 与浏览器另查游戏脚本、播放和停止。这些验收覆盖文件读取、事件与声音输出；硬件音源的具体音色仍属另一兼容边界。[SMF 读取](../../src/formats/audio/midi.ts) · [播放器合成器](../../src/engine/media/midi-synth.ts) · [MIDI 合约](../../tests/conformance/midi-native.test.ts)

## 已取回的第 120、121 批结果

两批全套运行终态均为失败。第 121 批的应用构建通过了上次出错的 PNG 回调，随后在 JPEG 对照工具报三处 TS7022，涉及解码步骤、起始行和行数。本批给三个变量补上接口类型。121 的主 Node、浏览器、KAG 等七组应用作业因此跳过，原版 KAG 介绍程序的路线仍待本批实际执行。[120 全套运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45475659242) · [121 全套运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45478711947) · [修正位置](../../tests/probes/jpeg-compare.ts)

121 的 Windows 原版 ERI 手工场景 36/36、作者工具场景 10/10 逐像素匹配，独立 ERI 合约 23/23 通过。JPEG 对照为 43/43，PNG 流式与调色板两组各 30/30，低位深 PNG 合约 8/8。窗口移动参考在两种 Windows runner 各观察到完整的 7/7 场景。旧提交 111 的两组专项各完成 240/240，均无新 core，历史 SIGTRAP 和 SIGABRT 的根因仍未定位。[121 原始运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45478711947)

本轮核对两个历史运行列出的全部 56 份 ZIP，总计 467,289,885 字节，其中 32 份为新取回。归档时核对了 GitHub 记录的 SHA-256 和长度，保留了两次按名称下载返回的 404，以及通过固定产物 ID 取得的原 ZIP。本地归档摘要在 `out/verification/github-actions/122-archive-summary.md`。新提交的结果由下一批取回。

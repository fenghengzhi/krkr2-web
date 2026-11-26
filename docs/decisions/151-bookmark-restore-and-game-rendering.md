# 第 151 批游戏兼容修复

## 读档途中选择剧情分支

游戏可以在书签的属性读取函数里查询正在恢复的 `KAGParser`，据此选择章节和分支。原版先恢复宏参数，再读取调用栈。随后每取回一个调用帧、文件名或条件字段，就先应用它，再读取下一个字段。之前的 Web 实现会一次读齐一组字段，脚本因此可能在读档途中看见旧文件名或旧分支。[原版恢复顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L728-L906)

此次修改让书签里的脚本看到已经恢复的角色参数、已装入的调用帧和前一个属性设置的条件。场景名称与正在解析的文件内容分开保存，直到实际重载时再更新文件内容。条件层数也单独保存，所以脚本在下一项条件数据恢复前调用 `store()`，能读到当时的层数。脚本属性中途抛错会保留在它之前已应用的字段。[解析器](../../src/engine/kag/parser.ts) · [脚本绑定](../../src/engine/tvp/kag.ts)

新增的同源 Windows SDK 和 Web 会话场景核对宏参数、文件名、条件栈和两层跨文件返回，也检查书签中途抛错后能否载入下一份有效存档。浏览器沿用原版 KAG 模板，玩家刷新读档后再点一次支线选项。书签从前一个属性读到的场景名和条件值决定实际显示的对白，最后由剧情自身返回主线。[共享对照](../../tests/helpers/kag-partial-state.ts) · [浏览器验收](../../tests/browser/kag-partial-bookmark.spec.ts)

## 立绘边缘与半透明混合

第 143 批的原版像素记录揭示了两种舍入方式。旋转立绘时，原版 Windows SDK 使用的 MMX 内部循环对横向和纵向插值权重的处理不同，测得的灰度和遮罩都是 191。用 64/255 的不透明度叠加另一个测试色块时，水平内部得到的遮罩是 63。此前 Web 采用了标量 C 版本的运算顺序，分别预计为 192 和 64。原始报告同时保留了当时的预期和实测值。[第 143 批原版实测](https://github.com/fenghengzhi/krkr2-web/actions/runs/45777718215) · [立绘对照场景](../../tests/helpers/sprite-sampling.ts)

另一项差异来自脚本传给绘图函数的数字。KRKR2 2.32 向 TJS 导出的 `stRefNoClip` 是 `0x10`。开启它时，插值可以参考源矩形外的相邻像素。第 143 批误用了 `0x10000`，所以原版仍在矩形边缘截取采样。相同测试行的首尾灰度分别是 64 和 192。[原版 TJS 常量](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/ScriptMgnIntf.cpp#L67) · [原版绘图常量](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerBitmapIntf.h#L56-L67)

TJS 的 `Layer` 绘图入口现在识别原版标志。旧 Web 脚本若将 `16` 至 `19` 写死为 Gaussian 或 Blackman 滤镜，应改用 `stGaussian`、`stFastGaussian`、`stBlackmanSinc`、`stFastBlackmanSinc`。若写死 `0x10000` 表示允许取相邻像素，应改用 `stRefNoClip`。存档中单独保存的数值没有版本信息，脚本读回后也按同一规则解释。直接调用 TypeScript 绘图接口的嵌入应用沿用其现有数值。[脚本参数转换](../../src/engine/graphics/script-stretch-mode.ts) · [原版 MMX 旋转采样](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/IA32/affine.nas) · [原版 MMX 缩放采样](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/IA32/stretch.nas)

## 绘制游戏指定的候选字体

部分游戏给对白指定逗号分隔的候选字体，例如 `Missing,GameFont,serif`。原版从头查找可用字体，空候选项表示直接选择接下来的名字，开头的 `@` 表示整组用于纵排。此前 Web 以整串名字查询游戏字体，可能在发行包自带所需字形时仍使用系统替代字体。[原版字体选择](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L1579-L1638)

普通对白可以直接使用发行包里已可见的字体。游戏随后打开新资源时，可通过 `Font.getList` 刷新目录。浏览器还会参考用户已授权的系统字体名称，以及浏览器能用 `local()` 找到的名称。系统字体的可见范围由浏览器决定。验收用例提供窄、宽两种字体，让玩家切换选项，并将画面上的字形与直接按文件名绘制的结果相比。先前 Chromium 的 Mincho 整串字形差异仍保留为独立问题。[绘制入口](../../src/engine/graphics/fonts.ts) · [浏览器字体验收](../../tests/browser/font-candidates.spec.ts)

## MIDI 配乐的通道调音

标准 MIDI 文件可以用注册参数号分别设置弯音轮的音程范围、通道微调和半音移调。原版播放器将这些控制消息发往 MIDI 设备。Web 合成器此前只处理弯音范围的整半音，忽略微调和移调。[MIDI 协会控制器表](https://midi.org/midi-1-0-control-change-messages) · [原版 MIDI 消息发送](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L480-L507)

本批按旧 Windows 常用的 Microsoft GS 合成器处理旋律音高。每个通道独立保存调音，音符在起音时取得当前微调和移调。因此改变调音时，一个已经按住的音符可以保持原音高，下一个音符才采用新调。弯音范围按整半音设置。Web 仍使用自己的音色，打击乐和弯音滑行未作旧设备波形对照。[微软对旧版合成器的说明](https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode)

浏览器验收从一个 440 Hz 音符开始。玩家按下游戏按钮升高八度时，当前音符仍是 440 Hz，重新发音才变为 880 Hz。后续按钮分别控制弯音、控制器复位、低八度、微调和模块复位。测试从实际 AudioWorklet 输出测量每一步的音高。[真实播放验收](../../tests/browser/midi-pitch.spec.ts) · [旋律合成](../../src/engine/media/midi-synth.ts)

本批新增 16 项 Node 测试，每个浏览器项目新增 8 项字体与 MIDI 游戏验收。已有的 KAG 读档和立绘画廊浏览器路线也增加了操作步骤。原版 SDK 对照新增 3 项 KAG 场景和 5 项立绘场景。[字体会话](../../tests/integration/font-candidates.test.ts) · [MIDI 对照](../../tests/conformance/midi-pitch.test.ts) · [立绘画廊](../../tests/browser/sprite-sampling.spec.ts)

## 取回的托管结果

第 140 至 142 批已结束，各有 24 个作业成功、4 个失败、10 个跳过。第 143 批取回时有 19 个成功、3 个失败、10 个跳过、4 个仍在运行。这些提交的应用构建均在视频命令读取 `frame` 时出现 TypeScript 错误，依赖构建的 Node、浏览器和实际游戏测试均跳过。第 145 批包含相应的类型修改。本次快照中，第 144 至 150 批都仍在排队。[第 142 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45775883723) · [第 143 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45777718215)

第 143 批的原版图形对照实报 80 项，其中 75 项与当时的预期相符。原版 KAG 对照 82/82 匹配，Windows 声音对照 40/44 匹配，其余四项报告 DirectSound 不可用。第 140 至 142 批的 Wine 声音对照均为 41/41。此次取回的 71 份新归档已核对大小与 SHA-256，之前的 24 份原件继续保留。[第 143 批托管归档](https://github.com/fenghengzhi/krkr2-web/actions/runs/45777718215)

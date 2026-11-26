# 第 156 批分卷游戏、默认对白字体和 MIDI 单音模式

## 导入分成多个文件的游戏

玩家可以一次选入同一游戏的全部分卷。按字节拆开的 `release.zip.001`、`release.zip.002` 会组成一个逻辑 ZIP，`data.xp3.001`、`data.xp3.002` 同样能作为主游戏包或补丁。PKZIP 的命名不同，`release.z01` 是第一卷，`release.zip` 是最后一卷。自动模式会在逻辑归档中寻找游戏。远程游戏目录清单也可以逐项列出各卷。[分卷挂载](../../src/backends/files/archive-volumes.ts) · [PKWARE 格式规范第 8 节](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)

单卷 ZIP 中的文件偏移从归档开头算起，PKZIP 分卷的偏移从记录指定的卷开始算起。读取器分别定位文件头、中央目录和 ZIP64 结束记录，按记录所在卷核对条目数。成员数据跨卷时沿用原来的解压与 CRC 校验。普通读取只请求需要的字节。各卷均有本地只读 Blob 时，影片可以直接组合相应切片。[ZIP 读取](../../src/formats/zip/archive.ts)

游戏库按原文件逐卷保存及校验，重开时重新组成游戏所见的归档。重新选择同一组分卷时，选择顺序不影响该组文件的存档身份。拆分方式、文件名或远程版本发生变化，可能产生另一份游戏身份。ZIP 发行包内的编号 XP3 也可以作为主包读取。带子目录的相对入口（例如 `scripts/boot.tjs`）可以从包装目录内定位到相应工作目录；多个目录都符合时，由玩家指定游戏目录。ZIP 的已有压缩方法与解码大小限制继续适用。同名可换介质分卷和分卷自解压程序仍未接入。[项目定位](../../src/engine/storage/distribution.ts) · [游戏库验收](../../tests/library-browser/split-distribution.spec.ts)

托管验收包含 Info-ZIP 实际生成的三卷发行包、一个跨卷 ZIP64 目录、跨压缩流读取和两个拆分 XP3 的补丁优先级。浏览器用原版 KAG 模板实际选择剧情、保存、更改进度，再从游戏库重开读回。编号卷走本地文件入口，PKZIP 卷走远程清单入口，后者在重开前关闭文件服务器。[分卷与 ZIP64 对照](../../tests/conformance/archive-volumes.test.ts) · [XP3 入口与存档](../../tests/integration/split-game.test.ts)

## 游戏没有指定字体时的对白

原版 2.32stable 初始化图层时把字体高度设为 −12，脚本第一次读取能看到负号，实际绘制和度量采用 12 像素。之后给字体高度赋负值时，原版设置器会保存其绝对值。Web 新图层和输入位置提示采用这套初始值，并使用日文原版的“ＭＳ Ｐゴシック”字体名。浏览器缺少该字体时仍会使用系统替代字体。Windows SDK 对照会记录实际系统代码页及原版返回的字体名，以区分不同系统下的名称转换。[原版字形默认值](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L1478-L1506) · [原版高度设置器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L4719-L4733) · [实际对白与输入提示验收](../../tests/browser/layer-default-font.spec.ts)

## 配乐的单音与复音声部

发送 MIDI CC126 后，旋律声道在新音符开始时释放前一个音符；CC127 切回复音，旋律可以再次叠奏。切换只作用于指定声道。原版 KRKR2 把这些控制器消息交给 MIDI 设备，Web 采用旧 Windows GS 合成器的通道规则。验收比较重叠音、延音踏板、复位及重播后的声道输出，浏览器从实际游戏按钮切换乐谱并记录 AudioWorklet 的声音。[微软 GS 兼容行为](https://microsoft.github.io/MIDI/kb/in-box-general-midi-synth/#compatible-mode) · [合成器](../../src/engine/media/midi-synth.ts) · [播放验收](../../tests/browser/midi-channel-mode.spec.ts)

## 本次取回的结果

第 151、152 批的原版图形对照均为 **93/93 匹配**，包括此前有差异的立绘采样。两批原版 KAG 均为 98/102 匹配，三项剧情结尾差异和一项部分书签差异仍有记录。第 152 批的旧影片转换器已在托管机器上成功构建。两批应用构建都停在视频测试的 TS2367，依赖应用构建的网页验收跳过。第 153 批已提交类型修复，本次取回时第 153 至 155 批仍在排队。[第 151 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45800870443) · [第 152 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45804548247) · [第 153 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45808179488)

本次取回并核对了 51 份新的原始归档，共 71,451,418 字节，另复用 24 份既有原件。第 156 批新增 16 项 Node 验收，每个常规浏览器项目新增 8 项，每个游戏库浏览器项目新增 4 项，原版 SDK 增加 3 项默认字体对照。新增行为等待托管验证。

实现提交 `8f9460db680d8fcae2555aac6d0eeb6ff70b0adb` 的应用与兼容性验证登记时为 `pending`，结果留到下一批取回。[第 156 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45815768302)

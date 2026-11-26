# 游戏光盘的数据扇区、MP3 配乐与键盘操作

## 读取保留扰码的数据轨

CloneCD 的 `DataTracksScrambled=1` 表示 IMG 保留了数据扇区在光盘上的编码。以前播放器见到这个标记就拒绝导入。现在它会在识别轨道模式、读取卷标、目录和文件时解码。每个 2352 字节扇区从第 12 字节开始应用同一序列，序列在下个扇区重新开始。音频轨仍直接提供原始立体声样本。支持范围为单区段 CloneCD、Mode 1 和 Mode 2 XA Form 1 数据轨。[ECMA-130 第 15 节及附录 B](https://ecma-international.org/wp-content/uploads/ECMA-130_2nd_edition_june_1996.pdf) · [数据轨读取](../../src/formats/disc/track.ts)

验收沿用由 cue2ccd 制作并由 bchunk 独立提取过的混合模式游戏盘。测试端按位生成另一份序列，校对 cdrtools 已发布表的全部 2340 字节摘要后，将游戏盘的数据轨转换成有扰码版本。专项检查跨扇区读取、音轨起点和中段的实际样本、运行中弹出与重新插盘。浏览器用例从该盘启动原版 KAG，保存章节，刷新游戏库后再读取存档。[cdrtools 参考表](https://github.com/Distrotech/cdrtools/blob/35398db65da4a50579ecb54bbb33c32277c6dbc9/libedc/scramble_table) · [混合模式验收](../../tests/integration/clone-cd.test.ts) · [浏览器读档验收](../../tests/library-browser/disc-boot.spec.ts)

## 从 CUE 播放 MP3 配乐

有些发行版将 CD 配乐另存为 MP3，在 CUE 中保留原来的轨号和起始时间。以前播放器能读到这些轨号，却无法播放对应文件。本批在 CD 音频读取路径接入 mpg123。读取器扫描帧头并建立稀疏索引，从编码器延迟和尾部填充确定有效样本，再用同一时间轴处理 75 Hz 的 CUE 轨道边界和游戏内定位。解码器按段交付 PCM。录音中可独立解码的位置较少时，向后跳转可能需要从较早的音帧重新解码。[MP3 读取器](../../src/formats/audio/mp3-source.ts)

CD 配乐支持普通 CBR、VBR Layer III，以及 ID3 和尾部 APEv2 标签。读取器跳过封面和歌曲资料，带标签的文件与相同音频的无标签版本应有相同的首尾样本。验收用 FFmpeg 独立解出完整录音，记录总帧数和摘要，再选取包含轨道交界及结尾的片段比较波形。[APEv2 布局](https://mutagen-specs.readthedocs.io/en/latest/apev2/apev2.html) · [标签读取](../../src/formats/audio/mp3-tags.ts) · [独立音频素材](../../scripts/generate-cdda-mp3-fixtures.mjs)

## 菜单快捷键与游戏键盘事件

脚本可以用 `MenuItem.shortcut` 绑定快捷键，再将它设为空字符串，把同一个键交还给剧情。菜单标题中制表符后面的提示仍可显示。原版 KAG 的验收先用一个快捷键执行菜单动作，然后解除绑定，再按同一个键进入章节并保存、恢复进度。[MenuItem.shortcut 原版说明](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_MenuItem_shortcut.html) · [原版 KAG 键盘路线](../../tests/browser/kag-menu-access.spec.ts)

内置的 Shift+F1、Shift+F4 可以独立打开控制器和控制台，用户可用 `-hkcontroller`、`-hkconsole` 改键或清空。脚本绑定的菜单先处理匹配的组合键。会话协议 73 将已配置的系统快捷键交给页面，以免浏览器同时输入字符。[系统快捷键](../../src/engine/input/system-shortcuts.ts) · [脚本输入验收](../../tests/integration/window-system-shortcuts.test.ts)

第 173 批 Firefox 的四个键盘菜单用例均在游戏启动后读到 640×478 的画布，预期为 640×480。原版 KAG 初始化后添加了可直接点击的顶层菜单项，页面给这类按钮的上下内边距比同一行的子菜单标题多两个像素。现在两类项使用相同的字体与行高、内边距和边框规则。用例保留原来的窗口尺寸断言，在实际打开菜单、保存和读档时检查显示。[菜单样式](../../src/app/game-windows.css)

## 本次取回的托管结果

第 185 批已按完整提交号登记。取回时第 174 至 185 批均在排队。[第 185 批验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45889204879)

来自第 173 批的 9 份新增浏览器报告合计已报告 3,134 项，其中 2,757 项通过、375 项失败、2 项跳过，另有 849 项未报告。Firefox 的游戏库作业被取消，但已发布完整的 110 项结果，其中 109 项通过，一项大影片换轨超时。常规浏览器矩阵有多个作业在 45 分钟附近结束，本批给常规和游戏库分片预留 75 分钟以完成执行和上传。单个用例的超时保持原设定。[第 173 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259)

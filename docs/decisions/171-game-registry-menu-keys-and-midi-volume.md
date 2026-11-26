# 第 171 批游戏设置、键盘菜单与 MIDI 音量

## 读取安装时保存的游戏设置

KRKR2 脚本可以通过 `System.readRegValue` 查询安装程序写入的选项。现在，玩家可把该游戏的 Windows 注册表导出文件和游戏一起导入，在“游戏注册表文件”填写其路径。文件可以位于导入目录、XP3 中或已绑定的虚拟光盘上。设置来自玩家指定的文件，查询和删除记录只作用于当前游戏的内存副本。留空时，脚本收到原版查询缺失值时使用的 `void`。游戏库会记住已选的文件，原有库记录继续使用默认设置。[玩家入口](../../src/app/app.ts) · [游戏库记录](../../src/player/library/records.ts)

查询按原版规则拆分注册表根、子键和值名。省略根时从当前用户开始，以反斜线结尾可读取默认值。字符串和带环境变量的字符串均按原文返回，DWORD 按大小端读取为 TJS 整数。二进制、多字符串以及缺失的值返回 `void`。解析器支持 Windows Registry Editor 5.00 与 REGEDIT4 导出，包括多行十六进制、同名值覆盖和删除记录。播放器仅在脚本首次实际取值时打开所选文件。[KRKR2 原版查询](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L225-L414) · [Windows 值类型](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types) · [Web 读取实现](../../src/engine/system/registry.ts)

Windows 托管用例给测试游戏建立一次性设置，用固定原版播放器读取这些值，再将 Windows 实际导出的同一份文件交给 Web 读取器。游戏库验收还会从原版 KAG 模板进入设置指定的章节、将进度 7 存档、改为 99，随后刷新并读回 7。[Windows 原版与导出](../../tests/probes/game-registry.ps1) · [Web 回读](../../tests/probes/game-registry-export.ts) · [游戏库验收](../../tests/library-browser/registry-game.spec.ts)

## 用键盘操作原版 KAG 菜单

原版 KAG 在菜单标题中用 `&` 标记访问键，例如「System(&S)」。玩家可以从游戏画面用 Alt 加访问键打开菜单，用方向键选择、Enter 确认、Escape 退出。重复的访问键会在同级可用项之间移动焦点。浏览器验收使用原版 KAG 菜单查看历史、写入并读回书签，同时核对弹窗与返回游戏后的焦点。[菜单事件](../../src/app/game-menus.ts) · [原版 KAG 键盘验收](../../tests/browser/kag-menu-access.spec.ts)

## MIDI 乐谱中的主音量

MIDI 配乐可以用通用实时主音量消息改变所有通道的音量。Web 合成器现在处理完整消息以及分段送达的消息，将 14 位音量按所选 Windows 合成器的凹形音量曲线换算为增益。在乐谱指定静音的区间，音乐时钟仍可继续推进。验收检查声音样本、定位后的状态和实际游戏按钮触发的配乐变化。[微软合成器主音量实现](https://github.com/microsoft/MIDI/blob/4db4520bd0e95ed224bb4458ad810091df783aac/src/in-box/Libs/MidiSynthLib/SynthEngine.cpp#L1751) · [Web 合成器](../../src/engine/media/midi-synth.ts) · [音频样本对照](../../tests/conformance/midi-master-volume.test.ts) · [浏览器配乐验收](../../tests/browser/midi-master-volume.spec.ts)

## 已取回的结果

第 169 批最终有 26 个作业通过、5 个失败、15 个跳过。生产构建记录的是修正前的离线清单错误，缺少 FFmpeg 源码补丁的 MIME 类型。第 170 批的测试工具与纯引擎类型检查均已通过。取回时其应用构建正在准备 runner，尚无发布、UDF 制盘或游戏验收结果。第 171 批新增行为等待托管验证。[第 169 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45852398659) · [第 170 批类型检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140030537055) · [第 170 批应用构建](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140031065325)

第 171 批实现提交 `1e20b9f` 登记时为 `pending`，下一批取回运行结果。[第 171 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320)

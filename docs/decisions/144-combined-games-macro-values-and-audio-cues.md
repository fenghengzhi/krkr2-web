# 第 144 批内嵌游戏、剧情数值与曲尾提示

## 在安装器旁找到游戏

有些发行包把游戏资源合并在 `Game.exe` 里，同时附带 `Setup.exe`。自动模式现在可以从同目录的多个程序中找出带 XP3 标记的那一个，按它的实际文件名读取配置。原版 Windows 的项目查找顺序为 `content-data/`、`data.xp3`、`data.exe`、当前程序内嵌的 XP3、`data/`，最后是程序目录。Web 使用同一优先级，并负责从玩家导入的文件中确定相应的程序。[原版项目选择](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SysInitImpl.cpp#L935-L1007) · [Web 项目选择](../../src/engine/storage/project.ts)

自动识别 ZIP 时先看上层目录。外层找到了游戏，其子目录里的演示脚本和工具就不会抢先启动。两个平级目录各有游戏时，可填写“程序所在目录”。同目录里两个 EXE 都有内嵌 XP3 时，可填写“游戏程序名”。查找时只读取文件内容，探测结果限本次选择复用，取消后可以重新导入。已经保存的游戏库条目继续使用已选目录和对应的存档标识。[ZIP 选择](../../src/engine/storage/distribution.ts) · [优先级、歧义及取消验收](../../tests/conformance/combined-launcher.test.ts)

常规浏览器验收从游戏和安装器两个文件中进入章节，点击游戏窗口保存进度，再导入带有两个版本的游戏并指定另一版本。游戏库验收把原版 KAG 模板作为内嵌 XP3，旁边放入安装器、工具目录示例、独立的配置文件和剧情补丁。玩家选择剧情、保存槽位并刷新，从库中重开后再次点击读档，验收比较实际对白、槽位文件内容和存档标识。[章节启动与选择](../../tests/browser/combined-launcher.spec.ts) · [原版 KAG 游戏库验收](../../tests/library-browser/combined-launcher.spec.ts)

## 宏参数中的 TJS 实数

剧情脚本可以计算数值后赋给宏参数，再通过 `%` 或 `*` 传给下一层宏。值为 1 的实数此前可能变成整数，负零也可能丢掉符号。现在这些值在跨过 Web 解析器时由 TJS 虚拟机持有，条件求值和转为字符串时保留原类型。对照包含嵌套宏、表达式、异常后的下次解析，以及从书签文件恢复到新的虚拟机。[参数传递](../../src/engine/tvp/kag.ts) · [源码、字节码与书签](../../tests/integration/kag-real-params.test.ts)

## 曲尾接续下一段声音

有些游戏把下一段声音的启动放在 WAVE 最后一个采样之后的 SLI 标签回调里。自然播放到末尾时，混音器会交付该位置的标签，再通知停止。整曲循环可在回到开头前交付曲尾提示，显式 SLI 跳转保留优先级。滤镜链也会交付落在最后一个块边界上的标签。验收分别检查曲尾标签启动下一段的事件顺序、双声道样本、手动停止和重播。[混音器](../../src/engine/media/mixer.ts) · [滤镜块边界](../../src/engine/media/audio-filter-chain.ts) · [曲尾和循环验收](../../tests/conformance/wave-tail.test.ts)

## 已取回的托管结果

本批新增 13 个 Node 测试，每个浏览器项目新增 12 个常规测试和 4 个游戏库测试。原版对照新增 5 个 KAG 宏参数场景和 2 个实际播放曲尾标签的场景。[宏参数浏览器验收](../../tests/browser/kag-real-params.spec.ts) · [双声道接曲验收](../../tests/browser/wave-tail.spec.ts)

第 134 批的三浏览器原版 KAG 与发布兼容用例合计 96/96 通过，游戏库与 PWA 合计 128/128 通过。Firefox 的两项场景用例通过，包含图层透明度、转场和保存 BMP 遮罩的回读。另有四项缩略图用例通过。[第 134 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45761489263)

本次取得该批九份常规浏览器报告中的三份，共 794 项通过、33 项失败。另五份尚未发布，Firefox 第一分片的归档已登记，但下载未成功。Node 仍为 4,066 项通过、4 项图层断言失败。第 135 至 143 批在本次取回时仍在队列中。

第 144 批实现提交为 `dd91ffaab28dc6dd73262d703edc88b5ceca432d`，GitHub 首次登记为 `pending`，结果留到下一批取回。[第 144 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45779775709)

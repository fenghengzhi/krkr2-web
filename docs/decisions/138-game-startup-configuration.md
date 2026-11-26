# 第 138 批游戏启动配置

在“游戏位置”选择自动识别或指定目录后，播放器会读取游戏发行包里的外部启动设置。例如 `Story/Novel.exe` 对应 `Story/Novel.cf`。同一目录还有安装器或设置工具时，可以在“游戏程序名”填写 `Novel.exe`。程序名用于选择配置和识别游戏资源。脚本里的 `System.exeName` 返回实际导入文件的完整虚拟路径。游戏库可以在刷新后恢复这个选择，已有项目和存档沿用原标识。

例如下面的 `Novel.cf` 会把存档位置设为程序目录下的 `Profiles`，同时向游戏脚本提供一个 `-route` 参数。

```text
datapath=$(exepath)/Profiles
route=default
```

原版先读取启动参数和程序旁的默认配置，确定存档目录，再从该目录加载 `Novel.cfu`。因此 `Profiles/Novel.cfu` 中的 `route=extra` 会让 `System.getArgument("-route")` 返回 `extra`。用户文件中即使另写 `datapath`，脚本查询参数可以看到这个值，实际存档目录仍是第一次选定的 `Profiles/`。显式传入播放器的启动参数优先于这两个文件。游戏写入或玩家导入的同名文件在下次启动时优先于发行包中的副本。[原版初始化顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SysInitImpl.cpp#L1542-L1584) · [Web 配置读取](../../src/engine/system/project-config.ts)

配置按日文 Windows 的 CP932 解码。每行写一个参数，行首分号表示注释，没有等号的键取值为 `yes`。同一文件内首次出现的键优先，参数名区分大小写。等号后紧跟引号的值按 TJS 字符串规则处理。源码和字节码会话使用同一套设置，调试模式在创建脚本运行时之前确定，JPEG 解码精度也在启动时固定。[配置解析器](../../src/engine/system/config-file.ts) · [引擎验收](../../tests/integration/game-config.test.ts)

这一批覆盖目录和 ZIP 发行包里的外部配置，以及存档覆盖层的用户设置。传统“文件集合”仍使用已有的虚拟运行器。二进制程序内部嵌入的默认选项，以及浏览器尚未实现的原版选项所控制的功能，仍是后续兼容工作。

## 验证

浏览器验收让游戏按钮写入真实槽位和用户配置，从游戏库重启，再导入另一份用户设置。断言包括启动路线的画面像素、脚本读回值、实际存档文件路径和内容。独立 Windows 作业分别运行仅有默认配置、载入用户设置、命令行覆盖普通参数，以及命令行改选存档目录四种情况。每种都核对脚本日志、原版写入文件的字节和落盘目录。[浏览器验收](../../tests/browser/game-config.spec.ts) · [原版验收](../../tests/probes/player-config-sdk.ts)

本次取回了第 133 批首版 WebKit 游戏库的 19 项结果，全部通过。该版游戏库与离线应用合计 116 项通过，其常规浏览器分片在取回时仍未报告。第 136 和 137 批的公开运行页当时均为 Waiting。第 135 批的作业 API 请求触及匿名限额，已保留该次响应。已取得的 43 个历史归档均完成大小与 SHA-256 核对。[133 首版运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623) · [137 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45766826621)

本批实现提交为 `4a423e725dc4c96f510bbb4c543d8d1d6f393952`，会话协议为 50。首次登记时工作流为 `pending`，下一批取回结果。[第 138 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45768308104)

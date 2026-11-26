# 第 139 批游戏内嵌设置与旧脚本模式

有些游戏把默认启动设置保存在游戏 EXE 里，发行包中可以没有 `.cf`。播放器现在读取所选程序内的普通配置文本。例如内嵌的 `datapath=$(exepath)/Profiles` 能让游戏找到 `Profiles/` 下的设置和进度。优先级由高到低依次为播放器显式启动参数、存档目录中的 `.cfu`、程序旁的 `.cf`、程序内嵌默认值。存档目录在读取 `.cfu` 前已确定。[原版路径与选项初始化](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SysInitImpl.cpp#L1332-L1377) · [Web 启动配置](../../src/engine/system/project-config.ts)

播放器按 64 KiB 分段搜索原版指定的 512 KiB 至 5 MiB 区间。找到首个对齐的配置标记后，在普通字符串的终止符处停止解析。目录、ZIP 发行包和游戏资源追加在 EXE 末尾的发行方式都能使用。只支持整文件读取的旧宿主若提供超过 5 MiB 的 EXE，会记录提示并继续使用外部设置。ZIP 中同时有安装器和游戏程序时，可填写游戏 EXE 文件名。若包中有多个同名文件，再填写“程序所在目录”。[配置读取](../../src/engine/system/embedded-config.ts) · [内嵌设置和 XP3 共存验收](../../tests/integration/game-config.test.ts)

| 启动设置 | 游戏中的效果 |
| --- | --- |
| `holdalpha=yes` 或 `true` | 新建图层默认保留遮罩。例如在 `dfOpaque` 下填色，原为 73 的遮罩仍为 73。图层可分别修改自己的 `holdAlpha`。 |
| `evalcontext=global` | 方法中的 TJS 后缀 `!` 在全局对象上下文执行。已编译的字节码在另一个会话载入后使用该会话的求值设置。 |
| `unaryaster=compat` | 编译游戏源码时，一元 `*` 取得属性对象，`&` 强制读取属性值。写入字节码的指令在以后载入时仍保留编译时的含义。 |

脚本在运行中调用 `System.setArgument` 可以更新可查询的参数。以上三个引擎行为在启动时确定。相同的游戏脚本交给托管 Windows 原版、源码会话和字节码会话，记录表达式读取与写入的对象、属性运算结果和图层遮罩。[共用脚本](../../tests/helpers/startup-script-modes.ts) · [跨会话字节码验收](../../tests/integration/startup-script-modes.test.ts)

固定 SDK 附带的原版程序其普通内嵌配置为空。原版 Windows 作业保留该区域的读取结果，并运行空配置、外部配置、用户设置和命令行组合共五种情况。非空内嵌设置使用独立编写的测试数据验收。浏览器用实际游戏按钮检查启动路线、存档、导入设置和从库重启。[原版 Windows 验收](../../tests/probes/player-config-sdk.ts) · [浏览器验收](../../tests/browser/game-config.spec.ts)

第 133 批首版最新取回的五个常规浏览器分片中，2,137 项通过、53 项失败、1 项跳过。该版 KAG 缩略图的实际保存与刷新读回在三种浏览器、两种后端及源码和字节码的 12 个组合上全部通过。原版介绍游戏已取得 Chromium 和 Firefox 的四条通过路线，WebKit 对应分片在本次取回时仍未报告。第 133 批最终版至第 138 批当时均在排队。[133 首版托管结果](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623)

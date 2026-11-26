# 第 148 批远程游戏目录、图层选项和 MIDI 初始化

## 从一个链接打开完整发行目录

许多游戏同时依赖主 XP3、补丁和散装资源。现在发布者可以提供一份 UTF-8 JSON 清单，玩家在“远程来源”选择“游戏目录清单（JSON）”后输入链接。播放器默认自动识别游戏目录，也可以指定程序目录或游戏根目录。单文件链接沿用原入口。[播放器入口](../../src/app/app.ts) · [README 示例](../../README.md)

清单包含数值 `version: 1` 和非空的 `files` 数组。字符串条目表示游戏中的相对文件路径，播放器逐段编码 URL，因此文件名中的空格、中文、`#`、`%` 和 `?` 都能保留。对象条目可以把 `path` 指定的游戏路径映射到单独的 `url`。相对 URL 以清单经过 HTTP 重定向后的最终地址为基准。绝对 HTTP(S) 链接可指向另一个允许跨域读取的服务器。[清单读取](../../src/backends/files/remote-manifest.ts)

会话先读取整份清单并验证全部路径，再开始打开游戏文件。清单上限为 10,000 项，逻辑路径每项最多 1,024 个 UTF-16 代码单元，清单正文与展开后的路径和链接各限 8 MiB。实际游戏文件继续使用已有的 HTTP Range、强 ETag 和小文件快照机制。停止载入会取消仍在读取的清单和资源请求。[HTTP 验收](../../tests/conformance/remote-manifest.test.ts)

游戏身份由实际文件的逻辑路径、远程版本和选择的项目决定。只调整清单的缩进或条目顺序，可以继续使用同一份存档。保存到游戏库时，播放器复用本次启动已经解析的文件列表，并核对资源身份后复制原件。之后从库启动只读取浏览器保存的文件。临时载入的游戏点击“重新开始”会重新读取远程清单。会话协议升至 54。[会话准备](../../src/workers/session.worker.ts) · [源码与字节码的启动和存档验收](../../tests/integration/remote-manifest.test.ts)

浏览器验收从播放器表单打开原版 KAG 模板、作者提供的补丁剧情和散装脚本。玩家点击选项进入章节，把进度 7 写入原版书签，再改为 99。游戏库验收在清单撤下后保存这些文件，关闭资源服务器并刷新页面，从库重新启动，通过原版读档选项恢复进度 7。它还比较两次导出的书签字节，检查离线重开时是否仍请求旧服务器。[浏览器启动与停止](../../tests/browser/remote-manifest.spec.ts) · [游戏库与书签](../../tests/library-browser/remote-manifest.spec.ts)

## 图层的可见、启用和焦点状态

原版图层对 `visible`、`enabled`、`focusable` 和 `joinFocusChain` 使用 TJS 布尔转换。过去 Web 播放器先取整数，把数值 `0.5` 当成了关闭，游戏中的按钮可能因此消失或无法点击。现在保留 TJS 对小数、字符串和对象各自的转换规则。浏览器从实际窗口检查左右两个选项的显示、鼠标命中和 Tab 焦点顺序。[原版图层属性](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L9199-L9332) · [浏览器选项验收](../../tests/browser/layer-input-booleans.spec.ts)

## MIDI 模块复位后的首个音符

部分 MIDI 配乐在开头发送硬件模块初始化指令，紧接着在同一拍发出首个音符。原版在完整的 GS Reset、GS Mode Set、GM On 或 XG On 指令后安排 50 毫秒的设备等待，再发送通道音量。Web 播放器据此安排后续事件的实际输出时刻，并保留乐谱原有的事件时间。[原版 SMF 播放顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L516-L558)

连续复位两次会让同拍的音符等到 100 毫秒。原定在等待结束之后的音符仍按谱面时间发声。验收将带复位的曲子与在谱面里显式延后首音的参考曲逐样本比较，并覆盖循环、定位和手动重播。这里比较的是单首曲子的立体声 PCM。Windows 实体 MIDI 设备和多个音源共用同一硬件端口的时序仍待核对。[MIDI 混音对照](../../tests/conformance/midi-reset-delay.test.ts) · [脚本播放验收](../../tests/integration/midi-reset-delay.test.ts)

本批新增 14 个 Node 用例、每个浏览器项目 12 个常规用例和 4 个游戏库用例，并为原版图层属性增加 5 项对照。浏览器的声音验收通过游戏窗口切换配乐，采集实际输出，测量每个循环里静音的长度与随后音符的频率。[浏览器声音验收](../../tests/browser/midi-reset-delay.spec.ts)

## 已取回的托管结果

第 135 批九份常规浏览器报告已全部取回，合计 3,242 项通过、101 项失败、2 项跳过。该批新加的共享图层画廊和音乐平滑循环均通过 12/12。本轮共核对 95 份托管产物的原始归档，其中 49 份为新取回。[第 135 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45763956289)

第 136、137 批的应用构建均在视频命令的 TypeScript 类型检查处失败。两个工作流各有 24 个作业成功、3 个失败、10 个跳过。构建失败的位置在读取 `frame` 时仍可能收到 `rewind` 或 `prepare` 命令。第 145 批已将这些命令拆成独立类型，其构建结果在本次取回时仍待报告。两批独立执行的原版 KAG 对照分别为 74/74 和 78/78，图形对照分别为 60/60 和 62/62。另一个原版对照作业在 SLI/WAVE 与透明度转场的比较步骤报告失败。第 138 至 147 批在这次快照中仍在排队。[第 136 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45765870289) · [第 137 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45766826621)

第 148 批实现提交为 `22b6eaaf1a156e05adcc64fd101472e18410589b`。GitHub 首次登记的运行状态为 `pending`，执行结果留到下一批取回。[第 148 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45791223343)

# 第 154 批远程游戏下载续传、剧情游标与后台声音

## 把远程游戏保存进游戏库

以前将远程发行包保存到游戏库时，网络中断或关闭页面都会让下一次保存从头开始。现在，对支持 HTTP 字节范围和强 ETag 的来源，播放器每写完 1 MiB 就先把内容刷入 OPFS，再把该块的 SHA-256 提交到 IndexedDB，最后一个块可以更短。用户主动保存过的纯远程游戏会保留下载地址和启动设置。重开页面后可以在游戏库点“继续下载”，也可以移除未完成的下载。[导入流程](../../src/player/library/service.ts) · [磁盘复制](../../src/backends/files/opfs-library.ts)

继续下载时会重新联系服务器确认版本。来源地址、最终地址、版本标识、大小和项目身份参与校验，文件排列还要与写入 OPFS 的顺序一致。播放器在本地重读每个已确认的块并核对摘要。文件缺失、块损坏、写完后尚未记录摘要，都会触发该块重新下载。若服务器上的游戏换了版本，需要重新载入游戏。用户可以分别管理旧下载和新版本。普通临时游玩沿用会话内存缓存。

混合本地文件与远程资源的项目需要再次提供同组文件。本地文件会重新复制，远程文件中已确认的范围块可以复用。只支持整文件响应的来源在每次准备时仍要重新获取。续传沿用原游戏标识与存档目录。服务器断开时，只能从已经发布完成的游戏库条目启动。[来源识别](../../src/backends/files/source-files.ts) · [游戏标识](../../src/player/game-identity.ts)

游戏库数据库升至版本 3。旧游戏的目录、资源和存档标识保持可用。完成导入时，完整文件清单、可启动目录和断点清理在同一事务中提交。多标签页共用原有写锁，仍在使用旧下载列表的标签页只能移除尚未完成的下载。断电时留下的无摘要块会重取，已确认的下载目录会在恢复时保留。下载记录最多 256 项，可以单独清除。[游戏库索引](../../src/backends/files/library-index.ts) · [磁盘中断验收](../../tests/conformance/library-resume.test.ts)

新增浏览器验收覆盖取消、刷新、重试、远程版本变化和游戏存读档。另一个用例在资源已写好时让目录提交失败，然后改动磁盘中的一个块，从另一个标签页继续。它核对实际 HTTP 请求只包含版本探测和那个损坏的块，并检查正式目录、断点清理与游戏脚本读取的内容。[游戏下载验收](../../tests/library-browser/remote-resume.spec.ts) · [发布失败后恢复](../../tests/library-browser/remote-download-integrity.spec.ts)

## 剧情在解析属性时读取下一条指令

部分脚本会在标签属性的表达式中调用同一个 KAGParser 的 getNextTag()。这次调用可能已把解析器带到下一行。原版在表达式返回后继续使用此刻的行和游标。此前 Web 仍在进入表达式前的行上寻找后续属性，可能丢失动态选项的文字、目标或分数。此次修订把实际正在扫描的文本与场景行号分开保存，处理嵌套读取、复制解析器状态以及从调用栈返回。[当前行的解析](../../src/engine/kag/parser.ts) · [标签游标](../../src/engine/kag/lexer.ts) · [原版解析器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp)

## 失去焦点时按游戏配置调整声音

原版在首次创建 WaveSoundBuffer 时读取发行设置。`-wsmute=minimize` 对应最小化，`yes` 或 `deactive` 对应失去激活；`-wsmutevol` 指定 0 至 100 的后台音量百分比。脚本的 globalFocusMode 可以选择更严格的条件。播放器在原来的语音、音效和全局音量上合并这层衰减，恢复焦点后使用当前音量继续播放。Web 将页面隐藏和失去焦点对应到浏览器提供的状态，用户主动暂停仍按暂停逻辑处理。[原版读取设置](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L173-L188) · [原版音量运算](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L3026-L3069)

验收从实际发行配置载入声音，通过另一浏览器标签页切换焦点，录取真实 AudioWorklet 的输出。它同时检查失焦和恢复的响度、播放时钟、SLI 标签和暂停，另有采样控制确认其他声音种类的输出。[后台声音验收](../../tests/browser/wave-focus.spec.ts) · [采样对照](../../tests/conformance/wave-focus.test.ts)

## 取回的托管结果

第 146、147 批已结束，第 148 批取回时仍在运行。第 147、148 批的应用构建均停在视频测试的 TS2367，依赖该构建的 Node 和浏览器验收跳过。该类型问题已在第 153 批修改，本次快照中第 149 至 153 批仍在排队。50 份新原始归档共 121,552,871 字节，均已核对 SHA-256 与大小，另复用 24 份既有原件。[第 147 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45788518065) · [第 148 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45791223343) · [第 153 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45808179488)

147 和 148 的原版 KAG 各有 89/92 项匹配。三个 EOF 差异分别涉及实数零的文本表示、出错时已写入的标签字段，以及临时对象何时析构。原隐式析构用例和它的差异记录继续保留。本批增加显式持有、失效和重入的独立对照。两个批次的原版图形仍为 75/80。[EOF 对照](../../tests/helpers/kag-eof.ts) · [重入剧情验收](../../tests/helpers/kag-entity-cursor.ts)

本批新增 9 项 Node 验收，每个常规浏览器项目新增 8 项，每个游戏库浏览器项目新增 6 项。原版 SDK 增加 5 项解析器游标对照和 1 项显式对象失效对照。游戏库迁移检查同时覆盖已有的 v1 和 v2 数据库。以上新增验收等待托管执行。

实现提交 `8b28dac7efcd2d81c73672846431c5652f710f46` 已登记 GitHub-hosted Actions 的应用与兼容性验证。登记时状态为 `pending`，结果留到下批取回。[第 154 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45811619796)

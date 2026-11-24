# 123　KAG 书签、配乐循环与 MIDI 输出

这一批处理玩家读档后继续剧情的路径，以及游戏脚本控制配乐时会碰到的两类原版接口。验收使用固定的 Windows 2.32r2 发行版、同一次提交构建的 Web 播放器及独立的输入数据。

## 从宏调用中的书签继续游戏

原版 KAG 在宏中调用另一份剧本时，书签里同时保存调用栈、宏参数字典和最近到达的标签。Web 的 `KAGParser.store()` 现在写出这些字典，包含脚本在运行中对 `mp` 的修改。恢复时也能读取旧 Web 存档的键值数组。播放器在调用 `onScenarioLoad` 和 `onScenarioLoaded` 前恢复宏参数和调用栈，使游戏能够在载入回调中读取当时的角色和剧情状态。Web 书签另存属性顺序，以供依赖 `taglist` 的脚本恢复重复属性。[原版 Store 和 Restore](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L478) · [Web 解析器](../../src/engine/kag/parser.ts)

同一会话里的解析器共享按存储名索引的八项剧本缓存。读取文件时命中会更新使用顺序。回调直接提供的剧本文字独立解析。重新打开当前剧本会回到开头，其他解析器清理缓存后，正在读的剧本仍可继续。显式 `clear()` 和达到 `clDeactivate` 的内存整理都会清空共享缓存。调用 `assign` 复制剧本位置与调用状态，目标解析器保留自己的中断请求和特殊标签处理设置。[原版缓存](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L241) · [Web 会话缓存](../../src/engine/kag/service.ts)

标签属性依次解析和求值，较早的表达式可以在后续语法错误前生效。游戏回调能读取当时的列位置。`*` 转发当前宏字典中的属性。缺少标签、内联脚本未结束、调用栈为空、旧调用行不匹配、部分非法书签和语法错误都通过对应的原版消息返回给 TJS，支持游戏在运行中更换消息及参数顺序。[原版标签解析](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L1524) · [共享对照脚本](../../tests/helpers/kag-scenarios.ts)

Windows 验收让原版引擎在从入口剧本调用章节时实际写出书签。Linux 作业检查原文件的 SHA-256，再把同一文件交给 Web 播放器的源码和字节码入口。两者都要读回角色与运行中新增的宏参数，经过原来的 `return` 回到入口剧本的下一条指令，并清空调用栈。Chromium 还会导入这份原版书签，保存一份 Web 书签，刷新页面后再次载入。其余常规浏览器作业覆盖 Web 存读档。原版 KAG 发行样例的菜单和剧情路线继续独立运行。[原书签生成与比对](../../tests/probes/kag-sdk.ts) · [浏览器读档验收](../../tests/browser/kag-macro-bookmark.spec.ts)

## 游戏配乐的循环与标签

`WaveSoundBuffer.open` 从原始字节读取伴随的 `.sli` 文件。解析器按固定原版源码识别单引号、字面反斜杠、平滑标志和条件。多条链接位于同一个采样位置时，条件与标志编号决定优先级。内存播放和流式过滤共用标签中的标志运算，覆盖递增、递减、引用其他标志及范围截断。游戏可以为非法循环信息设置自己的 `TVPInvalidLoopInformation` 消息，收到出错旁路文件的名字。[原版 WaveLoopManager](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveLoopManager.cpp) · [Web 解析器](../../src/formats/audio/sli.ts)

原版 SDK 作业检查打开文件、原版标签字典的采样位置、四种无效旁路以及重新打开。Web 的 Session 和浏览器另外播放已知的音频，核对实际选择的循环分支、收到的标签顺序和停止后的标志值。[原版打开文件对照](../../tests/probes/sli-sdk.ts) · [共享音频与独立预期](../../tests/helpers/sli-native-fixtures.ts)

## 脚本直接发送 MIDI

`MIDISoundBuffer.midiOut` 通过原生 TJS 八位组参数入口读取输入，支持类和实例调用。输出按消息逐条提交，因此末尾不完整的消息会保留前面已经发出的音符。它使用 `TVPMalformedMIDIMessage` 报告原版可判定的格式错误。原版 `FF 00` 设置 50 毫秒等待期，下一条实际输出在剩余时间结束后发出；这个等待可跨调用，停止会话可以取消它。不同会话拥有各自的输出时钟和合成状态。[原版 Win32 输出](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L85) · [Web 输出](../../src/engine/media/midi-output.ts)

播放器继续使用 Web 合成器。Windows SDK 另外观察五组原版参数调用，并用一个缺少操作数的短消息区分实际输出已启用和打开 MIDI 设备失败后直接返回两条路径。Web 的音频合成、50 毫秒等待、已发出音符、错误和清理由 Session 和浏览器检查。WinMM 物理设备的音色仍是兼容边界。新 Worker 音频消息使用协议 43，TJS WASM ABI 为 5，并声明 `nativeMidi: 1` 能力。[原版参数观察](../../tests/probes/midi-sdk.ts) · [浏览器 MIDI 验收](../../tests/browser/midi-output.spec.ts)

## 第 122 批已经取回的证据

取回时整套验证仍在运行。此前失败的类型检查与发布步骤已成功，离线夹具也已生成。构建当时正在准备共享视频素材，主 Node、浏览器和 KAG 游戏验收尚无报告。原版 ERI 对照中，手工场景 49/49 和作者工具场景 10/10 匹配，ERI 合约 31/31 通过。MIDI 打开文件对照 8/8 匹配，独立 MIDI 合约 3/3 通过。两个 PNG 对照组各 30/30，低位深 PNG 合约 8/8。该快照列出的全部 22 份 ZIP 均已核对 SHA-256 和字节数，共 179,983,786 字节。两次按固定 ID 下载返回的 503 也随随后按运行与名称取得的原件保留。[第 122 批验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45482636479)

Windows 2022 的窗口移动参考有一个前置步骤超时。原始日志显示，中性移动消息抵达正确的子窗口与坐标，按钮也处于释放状态，消息的附加标记为零。超时发生在注入左键按下和执行移动命令之前。其余六个场景和 Windows 2025 的七个场景完成了观察。本批用相隔四像素的准备点和目标点确认单次中性移动，核对两个容差区间均在本次创建的子窗口内。左键按下仍须带正确标记，后续保留原有的捕获、同步系统命令及清理断言。[Windows 参考程序](../../tests/native/window-move.cpp)

书签测试使用可以序列化的 TJS 数据。含循环引用和宿主对象的宏参数仍受值传递边界限制。本批新增行为与上一批尚未报告的游戏验收均待收回托管结果。完整非插件兼容和更多实际游戏仍需验收。

## 批次交接

实现提交 `63602e7d7f1444668d528fa48c55a2e680ca3576` 已推送。本批新增 24 个常规 Node 定义与每个浏览器 12 个定义。GitHub 首次登记的状态为 `pending`，登记页和提交匹配记录位于 `out/verification/github-actions/123-initial-63602e7d7f1444668d528fa48c55a2e680ca3576/`。下批取回本次结果以及第 122 批此前未报告的应用验收，优先核对原版 KAG 路线、原书签恢复、音频输出与窗口移动参考。[第 123 批全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45486961680)

初始登记后，现有 MIDI 集成测试增加了在音频渲染暂停期间推进 50 毫秒时钟并恢复播放的断言。此处只改测试，随交接提交保留，由下一批托管运行执行。123 运行覆盖原有的跨调用等待与停止取消断言。

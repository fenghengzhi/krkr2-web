# 第 150 批剧情书签、鼠标选项和 WAVE 循环

## 在当前场景中恢复章节

原版游戏可以给 `KAGParser.restore` 一份只含 `curLabel` 的字典。例如，当前支线收到 `%[curLabel:"*selected"]` 时，解析器会重新载入当前场景并移动到该标签。之后遇到 `[return]`，游戏仍能回到调用这段支线的主线。此前 Web 播放器会因为缺少 `callStack` 而拒绝这份书签。[原版恢复流程](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L728-L908)

省略或填写 `void` 的场景名、标签和调用栈分别沿用当前值。显式的空调用栈会清除调用者。空标签保留重新载入后的位置，通常是文件开头。解析器已有缓存的宏参数时，书签仍须提供宏参数数组。若提供数组但省略栈底，默认栈底为恢复的参数深度。重新载入场景期间，游戏回调可以推进剧情，也可以修改书签里的条件状态。Web 在回调结束后读取这些字段。书签或调用帧上供游戏自己使用的回调保留在 TJS 中。[脚本接口](../../src/engine/tvp/kag.ts) · [解析器](../../src/engine/kag/parser.ts)

同一组剧情文件分别交给原版 Windows SDK、Web 源码和字节码会话。七项对照覆盖从磁盘恢复只含标签的书签、返回主线、缺省和显式清空的区别、宏内恢复、场景载入回调改变下一条分支，以及脚本属性被读取的次数与顺序。[共享场景](../../tests/helpers/kag-partial-state.ts) · [会话验收](../../tests/integration/kag-partial-state.test.ts)

自定义书签属性还有一项已知差异。原版逐个应用条件字段，后一个属性的 getter 若在恢复途中调用 `store()`，可能看见前一个字段已改变。Web 会收齐这些字段，核对条件嵌套后一起应用。[原版恢复顺序](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L872-L906) · [Web 条件恢复](../../src/engine/kag/parser.ts)

浏览器用例载入原版 KAG 模板，让玩家点击选项进入支线、恢复指定章节，再通过剧情自身的 `[return]` 返回主线。它还保存书签、停止游戏、刷新页面并重新读档，核对实际显示的章节、调用深度和存档字节。[浏览器书签验收](../../tests/browser/kag-partial-bookmark.spec.ts)

## 游戏选项的左键、右键与中键

原版窗口分别处理鼠标按下、松开、左键单击和双击。玩家在选项上右键打开菜单或中键查看历史时，游戏应只执行绑定给相应按键的动作。此前 Web 可能同时触发选项的单击或双击。图层的默认 `onHitTest` 现在也只记录命中结果，避免鼠标移动时反复调用动作所有者。游戏覆写该方法后可以将结果交给基类，例如用小数 `0.5` 表示命中。[原版窗口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1765-L1810) · [原版图层命中处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L8048-L8071)

浏览器用例在同一选项上用不同按键操作，逐步核对选项、菜单和历史的触发次数、窗口与图层收到的事件顺序，以及显示玩家选择结果的色块。[玩家操作验收](../../tests/browser/mouse-button-choice.spec.ts) · [真实脚本会话](../../tests/integration/mouse-button-choice.test.ts)

## WAVE 背景音乐能播放到曲尾

有些 WAVE 文件带有采样器使用的 `smpl` 循环标记。此前游戏播放这些文件时可能一直重复曲中一小段，听不到尾奏。原版 `WaveSoundBuffer` 读取 PCM 声音数据，由游戏的 `.sli` 文件指定分段循环。没有该文件时，开启 `looping` 会从曲尾回到曲首，关闭后会播完剩余部分。整文件和流式播放现在遵循相同规则。独立的 RIFF 解码接口仍可读取采样器标记。[原版 WAVE 解码](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp#L614-L724) · [原版循环文件处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L2918-L2970)

验收曲目依次播放 500、1000 和 1500 Hz 三个乐句。浏览器用例采集实际混音输出，检查整曲顺序、玩家关闭循环后的尾奏与静音，以及带有明确 `.sli` 指令时单独循环的第三个乐句。[浏览器音频验收](../../tests/browser/wave-sampler.spec.ts) · [解码与播放验收](../../tests/conformance/wave-sampler.test.ts)

## 取回的托管结果

第 139 批已结束，24 个作业成功、4 个失败、10 个跳过。上次尚未发布的 Wine 声音参考现已取回，41/41 匹配。第 140 批在这次快照中有 23 个作业成功、3 个失败、10 个跳过，Wine 声音参考仍在运行。两批应用构建都在视频命令读取 `frame` 的 TypeScript 检查处失败，Node、常规浏览器和依赖构建的游戏验收没有结果。第 145 批包含相应的类型修改，本次取回时该批仍在排队。[第 139 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45769721383) · [第 140 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45771395938)

第 140 批原版 KAG 对照为 78/78，图形为 62/62。Windows 声音参考为 37/41，另四项报告 DirectSound 不可用。该批的 Windows 配置对照没有取得五个计划场景的进程记录。第 149 批修订了输入 JSON 的读取方式，执行结果仍待取回。本轮新增 25 份原始归档，已核对大小和 SHA-256。第 141 至 149 批在快照中仍在排队。[第 149 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45793541359)

第 150 批实现提交为 `e2b388570a2f07a2409d8093bf3f4de1fe170846`。GitHub 已登记托管运行，登记时状态为 `pending`，结果留到下一批取回。[第 150 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45796411933)

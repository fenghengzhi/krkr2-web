# 第 149 批发行目录、图层重绘和 MIDI 重播

## 从发行目录定位游戏

当本地文件夹或远程清单把主包放在 `合集/Novel/data.xp3` 时，播放器会把 `合集/Novel/` 设为程序目录。补丁、程序旁的脚本和存档目录都随游戏定位。父目录中有完整游戏时，附带的子目录示例不会抢占入口。两个并列目录各有游戏时，播放器提示选择程序所在目录。输入独有的程序名也可以选择对应版本。[目录选择实现](../../src/engine/storage/distribution.ts)

导入根的 `startup.tjs`、`content-data/`、`data.xp3`、`data.exe` 和 `data/` 保留已有的启动优先级。程序目录由用户指定时直接使用该目录。游戏路径保留导入时的大小写和上层目录，这样自动识别和手动选择同一版本能打开同一个存档。以往保存在游戏库里的条目继续使用已记录的目录。[原有目录、游戏选择和存档身份验收](../../tests/conformance/combined-launcher.test.ts)

玩家在“启动脚本”填写其他文件名时，播放器也用这个名字查找游戏。如果导入根已有该文件或脚本地址中指定的归档，保留原来的程序目录选择。相对地址仍从最终游戏目录解析，例如从 `data/` 以 `../boot.tjs` 启动。会话协议升至 55，让 Worker 在选择程序目录时就能得到这次启动的脚本名。[播放器启动](../../src/player/create-player.ts) · [相对入口验收](../../tests/integration/project-root.test.ts)

浏览器验收从真实文件夹选择器或远程清单打开原版 KAG 模板，进入补丁章节，将进度 7 写入游戏书签。文件夹组随后改用手动选择的目录启动。清单组先复制到游戏库，关闭资源服务器并刷新页面，再从库启动。两组都比较导出的书签字节，并通过游戏自己的读档选项返回进度 7。[原版游戏目录与书签验收](../../tests/library-browser/wrapped-directory.spec.ts)

## 绘制开关和缓存图层

原版脚本给 `Layer.callOnPaint` 和 `Layer.cached` 赋值时使用 TJS 布尔转换。数值 `0.5` 可以请求下一次绘制，也可以把图层子树作为一组缓存合成。此前先取整数会把两个开关都关掉。新用例用真实点击取消和恢复绘制，检查 `onPaint` 调用次数、回调开始时标志是否已清除，以及缓存图层下半透明颜色的整帧结果。[图层接口](../../src/engine/tvp/layer.ts) · [游戏画面验收](../../tests/browser/layer-paint-switches.spec.ts)

## 配乐循环和重播

有些 MIDI 配乐在曲中途才为通道选择乐器。原版在循环或停止后重新播放同一首曲子时停止旧音符、复位控制器，并保留已经选择的乐器。因此下次回到开场时，旋律可能使用上一遍后半段选中的音色。曲谱在结束的最后一拍换乐器时，播放到曲尾才应用这次变化。如果玩家提前停止，重播时保留的是停止时已经选中的乐器。显式定位仍从谱面重建通道状态，曲谱发送的模块复位继续生效。[合成器](../../src/engine/media/midi-synth.ts) · [原版播放控制](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp#L897-L965)

验收将同首曲子第二次播放的双声道 PCM 与一份开头明确选好乐器的参考谱比较。浏览器从实际游戏按钮操作停止、重播和切换参考曲，并采集音频工作线程的输出。这项对照覆盖同一首配乐。新打开的曲子拥有单独的合成器，多个音源共用 Windows 实体 MIDI 端口的状态仍待核对。[PCM 对照](../../tests/conformance/midi-program-replay.test.ts) · [浏览器声音验收](../../tests/browser/midi-program-replay.spec.ts)

本批新增 12 个 Node 用例、每个浏览器项目 8 个常规用例与 4 个游戏库用例，并在原版图层对照中增加 3 项。运行结果将在后续批次取回。

## 第 138、139 批托管结果

第 138 批已结束，24 个作业成功、4 个失败、10 个跳过。第 139 批取回时有 23 个作业成功、3 个失败、10 个跳过，Wine 声音参考仍在进行。两批应用构建都在视频命令的 `frame` 类型检查处失败，Node 和常规浏览器均缺少运行结果。第 145 批已修改命令类型，其构建状态在本轮快照中仍待确认。第 140 至 148 批当时均在排队。[第 138 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45768308104) · [第 139 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45769721383)

两批原版 KAG 对照均为 78/78，图形对照均为 62/62。Windows 原版配置对照分别计划 4 项和 5 项，实际均缺少进程输出。输入中同时含有 `Case` 和 `case` 两个参数。第 149 批让 PowerShell 以能保留大小写不同键名的哈希表读取 JSON，两个参数的原断言继续逐项比较。本次取回的 49 份原始归档均已核对字节数和 SHA-256。[Windows 配置夹具](../../tests/probes/original-player-config.ps1)

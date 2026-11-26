# 第 172 批全屏画面、章节选择与配乐循环

## 第 170 批实际跑过的游戏

生产发布和离线打包通过，许可证目录中的 FFmpeg 源码补丁已进入发布包。UDF 1.02 和 2.01 两张 32 MiB 游戏盘均通过 Linux 内核重新挂载和 7-Zip 独立回读。Windows 原版读取光盘的作业也已通过。Chromium、Firefox、WebKit 各自的原版 KAG 流程、存档和转场验收成功。[生产构建](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140031065325) · [制盘门禁](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168268) · [完整工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668)

Chromium 游戏库的 102 项验收中有 66 项通过、36 项失败。自定义入口、内嵌 XP3 程序、分卷发行包、汉化剧情和远程游戏目录等已有通过记录。12 项光盘启动用例在玩家界面取走所选文件、清空文件框后才检查文件名，因此停在游戏就绪之前。本批在真实 change 事件中保存文件名、顺序和字节数，随后继续核对启动脚本、章节、像素与书签。[第 170 批游戏库结果](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169043) · [光盘启动验收](../../tests/library-browser/disc-boot.spec.ts)

另有 20 项已经到达章节，但保存后的访问计数没有增加。制作用例中的 4×4 或 8×8 图片被原版 KAG 当作整个背景载入，导致主图层缩到了素材尺寸。同一位置连续出现新链接时，原版还会等待指针真实移动后才允许再次点击。本批在相应剧情中明确保留 640×480 的图层范围，通过浏览器指针移入链接解除点击锁，再检查原来的章节与存档结果。其余 4 项 CDDA 用例在检查盘符时把字母作为 TJS 布尔值使用。TJS 在此会把字符串转为整数，D、E 都会变为零。修订后的游戏脚本逐项核对盘符、缺失卷标和实际音轨，已通过的双声道采样断言继续使用。[光盘剧情](../../tests/fixtures/disc-story/Story.ks) · [玩家点击](../../tests/helpers/kag-game-controls.ts) · [双盘 CD 音轨用例](../../tests/helpers/cdda-library.ts)

## 按游戏发行配置显示全屏

此前播放器总是将整幅画面缩放到浏览器视口内。现在进入全屏时会读取游戏的 `-fsres` 和 `-fszoom`。`inner` 完整显示画面，`outer` 铺满视口并从两侧或上下居中裁切。`fsres=nochange` 配合 `fszoom=no` 会保留游戏原尺寸。自动分辨率模式仍按原版规则将 `no` 作为 `inner`。原版在放大比例大于 1 且小于 1.034 时保留原尺寸。浏览器以当前视口作为全屏显示区域。[原版模式与缩放](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp#L725-L903) · [全屏计算](../../src/engine/scene/fullscreen.ts)

裁切量同时用于图层绘制、影片位置、光标和输入坐标。脚本设置的窗口缩放在退出全屏时恢复。浏览器验收通过发行配置文件启动游戏，将 320×240 场景铺满 960×540 视口，核对实际可见像素，点击画面上的选择项，再从存档读回它的游戏坐标。[原版窗口居中](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L1344-L1371) · [浏览器画面与游戏输入](../../tests/browser/fullscreen-fit.spec.ts)

## 游戏外置设置与 WAVE 循环

玩家可以将 Windows 游戏设置导出文件与游戏 ZIP 一同导入，也可用发行包名称明确指定包内的设置。选择的外置资源只供注册表读取，游戏库重开沿用原先的选择。光盘和设置文件一起导入时也会参与启动盘识别。[项目识别](../../src/engine/storage/distribution.ts) · [设置来源验收](../../tests/integration/registry-imports.test.ts) · [实际游戏库重开](../../tests/library-browser/registry-game.spec.ts)

普通 WAVE 在源采样率与输出速率不同、需要做线性插值时，现在会跨越实际的 SLI 跳转或整曲循环取下一采样。接缝处的输出不再混入已跳过的音频，标签和状态仍在真正经过该位置时交付。验收对照预先展开的音频样本，覆盖缓冲与流式读取、条件跳转、暂停及恢复。[混音器](../../src/engine/media/mixer.ts) · [采样对照](../../tests/conformance/wave-loop-resampling.test.ts) · [浏览器实际声音输出](../../tests/browser/wave-loop-resampling.spec.ts)

第 171 批在本次取回时仍为 `pending`，当时还没有作业结果。第 172 批上述改动等待托管验证。[第 171 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320)

第 172 批实现提交 `5b76122` 登记时为 `pending`，下一批取回运行结果。[第 172 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217)

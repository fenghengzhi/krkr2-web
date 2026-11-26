# CloneCD 游戏盘、影片换轨与双击坐标

## 用 CCD 和 IMG 启动与播放

玩家可一起选择 `.ccd` 和同名 `.img`，从盘内的 KRKR2 游戏启动。游戏库重开、ZIP 中的光盘、按卷标查找盘符、读取章节和运行中换盘共用同一份轨道表。当前支持单区段（single-session）、未扰码的 CloneCD 2／3 镜像，涵盖普通立体声 CD 音轨与 Mode 1 或 Mode 2 Form 1 游戏数据。文件选择接受随盘附带的 SUB。游戏读取的数据和音频来自 IMG。[光盘解析](../../src/formats/disc/ccd.ts) · [GNU CCD 格式说明](https://www.gnu.org/software/ccd2cue/manual/ccd2cue.pdf)

每个 IMG 扇区占 2352 字节。解析器从轨道索引或 TOC 的 PLBA 找到起点，从真实数据扇区的头部确定模式。只有 TOC 的旧描述文件也可读取。读取章节时保留下一轨的边界，播放配乐时保留音轨间隙、预加重标记和引出区起点。[CD 音轨](../../src/formats/audio/cue.ts) · [数据轨](../../src/formats/disc/volume-label.ts) · [libMirage 的 CCD 实现](https://github.com/cdemu/cdemu/blob/master/libmirage/images/image-ccd/parser.c)

托管验收使用同一批生成的 KAG 游戏 ISO 和四秒可逐采样核对的立体声 PCM。独立工具 cue2ccd 制成一张混合模式光盘，第一轨是配乐，第二轨在第 300 个扇区开始。游戏库验收启动原版 KAG、存档、刷新并读档。会话验收另从 D 盘读取日文章节、逐样本检查配乐并换盘，也检查选漏 IMG 时能否继续读取原盘。[制盘工具](https://github.com/mistydemeo/cue2ccd/tree/aa74f53b6d211e4ac844bd7c8fb2b69ea482669d) · [游戏与音轨验收](../../tests/integration/clone-cd.test.ts)

## 播放中切换影片轨道

换轨时旧影片先暂停。浏览器可以先更新暂停标志，稍后才在暂停事件中公布停止时刻。现在播放器等待该事件，再把最终时刻交给新轨道。如果暂停被更新的命令取消，这次换轨无法接管播放器。已有验收继续检查两种实际音调和恢复位置，并增加对准备失败后旧轨道能否继续播放的检查。[影片实现](../../src/backends/video/browser/host.ts) · [播放中换轨验收](../../tests/browser/video-playing-audio-switch.spec.ts)

## 双击游戏内的图层

原版窗口通过保存的按下位置分派双击。玩家在同一位置连续按下两次，第二次按住鼠标移开再释放时，现在游戏可在原按下位置收到双击，并在真实释放位置收到抬起事件。两次按下位置不同时，原版窗口的事件先后仍待单独核实。[浏览器输入](../../src/backends/input/browser.ts) · [原版窗口处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp)

Windows 托管用例启动原版 SDK 的游戏窗口，分别在同点和相邻两点连续按下鼠标，再移动到第三个位置释放，并记录游戏窗口和图层实际收到的事件。这两份观察可用于核对原版对按下和双击的分派顺序。[Windows 原版对照](../../tests/probes/mouse-click-sdk.ts)

## 本次取回的托管结果

第 172 批最终失败。15 份常规浏览器报告累计 3,488 项通过、390 项失败、2 项跳过，另有 706 项未报告。WebKit 游戏库作业取消前记录了 88 项通过，余下 22 项未报告。Firefox 大影片用例的首错是等待定位后的画面超时，现有附件不足以将该超时归因于本批修订的暂停时钟。[第 172 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217)

第 173 批已取得生产构建和类型检查的通过结果。三种浏览器的离线用例合计 65 项通过，Chromium 原版 KAG 与运行时兼容用例 32 项通过。另有原版对照作业仍然失败。取回时第 174 至 182 批仍在排队。[第 173 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259) · [第 182 批托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45883191112)

第 183 批实现提交 `4eb1849` 已登记，登记时状态为 `pending`。下一批取回已发布的结果。[第 183 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45885531653)

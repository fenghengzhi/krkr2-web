# 088 同步窗口拖动与光标横向精度

状态：开发候选，本批尚未取得执行结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器。会话协议 **33**，TJS ABI **5**、字体 ABI **2**。所有构建、测试、浏览器及原生探针只在 GitHub-hosted Actions 执行；整批推送，下次工作时回收固定快照，不实时监控。

已整批推送精确提交 `7ebb8f65a9ecfffee8826b14a65dd3c739e14759`，对应 [Full test suite 37279350828](https://github.com/fenghengzhi/krkr2-web/actions/runs/37279350828)。首次唯一查询为 **in_progress／conclusion=null**，只确认运行创建及精确提交；原响应保存于 `out/verification/github-actions/37279350828/initial-run-discovery.json`。未查询实时 jobs／artifacts，下一轮先补取 087 终态，再回收本批固定快照。本段通过 `[skip ci]` 文档提交保存，不产生通过结论。

## Window.beginMove

固定 KRKR2 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [WindowFormUnit.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp) 调用 `ReleaseCapture()`，随后同步 `Perform(WM_SYSCOMMAND, SC_MOVE+2, 0)`。[WindowImpl.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp) 在全屏时抛错。[Microsoft WM_ENTERSIZEMOVE](https://learn.microsoft.com/windows/win32/winmsg/wm-entersizemove) 描述系统进入移动循环的边界；函数返回发生在该循环退出后。

新实现通过已有 ModalLoop 保留 TJS 调用栈，拖动期间继续同一 VM 的 Timer／事件泵。单次交互有独立 requestId、Window ID、脚本请求身份及单调 reply sequence；页面 update 实时更新 Window.left/top，commit 保留位置，cancel 回到开始前的位置，error 经 TJS Exception 返回。没有宿主呈现能力时明确失败，不能挂起一个没有结束入口的循环。

新的 `window-move` 事件发布请求或 null；页面回报走独立 `Session.windowMove` RPC，不排在等待移动结束的脚本队列后面。全屏、失效窗口与嵌套 move 被明确拒绝。隐藏、暂停、页面离开、窗口失效和 Stop 撤销交互；子模态出现时先撤掉拖动 UI，保留子作用域，待它退出后再收尾父 move。已接受的 commit 不会被紧接着发生的 Pause 改写为回滚。null 表示交互已退休，不等同于 TJS frame 已完成 unwind。

页面使用真实 pointer capture，支持无标题栏窗口，按实际坐标预览并逐帧发布位置；释放提交、Escape 取消，Enter 提交。键盘方向调整按 CSS 像素处理，是 Web 容器适配。单个响应式主窗口首次拖动时转为浮动呈现，保留当时 canvas 的 CSS 缩放；成功保留新位置，取消恢复嵌入布局与原逻辑位置。原有标题栏拖动／缩放继续保留。

移动期间页面清理自己的 DOM 指针捕获和暂态按钮，阻止游戏鼠标／键盘事件继续进入 VM，但继续更新真实按键观测。已接纳的引擎工作保持生命周期，尚未提交的 DOM 队列被撤下。结束后的兼容 mouseup／click 和 Escape／Enter keyup 不应变成游戏操作。这里没有凭 `ReleaseCapture()` 推断并调用 LayerManager.release：原生 OS 捕获和 KRKR2 Layer 捕获是两个层次，原有 Layer down 后续取得捕获的时序继续保留。

Web 页面没有可读取的全局 OS 指针：没有任何页面 pointer 观测时调用会明确报错。无按键启动、隐藏／禁用／不可激活桌面窗口，以及系统边框、屏幕限制、DPI 和键盘步长尚不能宣称完全等价。新增托管原生探针用于核对这些边界；本批主路径实现并不消除这些待验证项。

新增 **20 个 Node 定义**：move 核心 6、真实 Session 5 场景 × 源码／字节码 10、输入协调器 2、光标完整 plane 2。另增**每浏览器 8 个定义**：两种实际拖动场景 × 双后端 × 源码／字节码，覆盖 Timer 在挂起期间继续运行、无边框位置、Layer 回调顺序、结束输入不误派、Escape、隐藏、失效、嵌入布局转换和 Stop。所有新增定义尚待托管执行。

## 独立 User32 参考

新增 [native-window-move.yml](../../.github/workflows/native-window-move.yml)，在 Windows 2022／2025 各执行七种受控观察，与完整 Tests 共用同一次 run 并加入最终依赖。原门禁全部保留。

探针在自有 UI 线程和 HWND 上建立子窗口捕获，再按固定源码调用 ReleaseCapture 和同步 `SendMessageW(WM_SYSCOMMAND, SC_MOVE+2, 0)`；逐项记录 WM_ENTERSIZEMOVE、WM_EXITSIZEMOVE、WM_MOVING、捕获、按键、窗口位置和函数返回。七种配置包括普通／无边框按住左键、未按左键以 mouseup／Escape 结束，以及 disabled、hidden、noactivate 的取消路径。SendInput 是托管桌面的受控 OS 输入，不是物理硬件，也不是原版 VCL／Layer 实测。

每阶段等待有界，整个进程 120 秒、外层 job 8 分钟；只清理自己持有的进程、线程、窗口和注入状态。超时与不完整采样均失败，保留 partial journal，不把超时解释为原生功能不支持。source、编译日志、status、JSON／JSONL、平台版本与 hash 清单始终归档。当前尚无该探针结果。

## 光标颜色精度的证据范围

087 的两个 Windows 报告中，当前生产 smooth 分支对应的 11 个目标一致。把 X 比例先舍入到 binary32、之后在 binary64 累加，可以使 48×48 DIB 的完整 RGB plane 和 PNG 的完整 RGBA plane 从 5／4 个通道差异降到零，六个已匹配的常量色目标仍为零。Y 的三种累加路径在这两份完整 plane 中无法区分，因此保留当前 Y 算术。

本批据此仅修正通用 X 步长，不添加尺寸特判。13×9 三个目标仍有 **17／22／14** 个通道差异（此前为 57／39／37），不能称为颜色缩放完成。两个新回归使用原生边缘像素、热点及整 plane SHA-256，而不是由生产缩放计算期望；原 half-size DIB 测试另修磁盘行序夹具错误，保留原像素和 hash 期望。

原 95 份光标样本及顺序全部保留，追加 20 份 CUR：13×9、9×13、48×48、17×41 四个尺寸 × X-only、Y-only、非对称 XY、checker、impulses 五个独立色场，共 115 份。新增来源为 69,120 字节，全部进入原 raw、strict 绘制和 176 候选诊断路径；3,770 条 mask 比较保持。严格失败、未比较范围和原门禁均不缩减。完整原始矩阵及来源哈希保存于 `out/verification/github-actions/37275964642/088-cursor-color-evidence.json`。

## 087 固定快照

本轮对 [37275964642](https://github.com/fenghengzhi/krkr2-web/actions/runs/37275964642) 的 run、jobs、artifacts 各查询一次。快照为 **in_progress／conclusion=null**，22 jobs 中 **6 success、2 Windows strict failure、14 running**，最终 All tests 尚未出现。固定清单 **9/9 ZIP、30,742,219 字节**全部核对大小和 API SHA-256；未刷新后来发布的结果。

构建成功，四份 TypeScript 配置、Vite、离线校验和四份共享 MP4／ffprobe 夹具生成已执行；此前五个类型错误未再阻塞。双 allocator 各 60/60，Chromium library 19/19、PWA 20/20、trusted lifecycle 7/7 均单次通过。夹具生成本身不证明音轨行为通过。

两 Windows mask 各 **3,770/3,770 matched**；主 strict 各 **293/332 matched、39 mismatch、1,858 uncompared**。176 候选覆盖 66 targets，无一个跨完整目标集全零；这个目标集也包含独立的整数缩小／alpha 归约分支，不能假定应由一个插值核处理全部。

Node、主浏览器、Firefox／WebKit、原 KAG 和直接 runtime 等在固定快照仍运行，结果未报告；窗口遮罩、鼠标键盘、流式音频和 MP4 候选不能据此计为已通过。下次先补取 087 终态与新增产物，再回收本批。历史失败和旧快照保留，完整非插件目标继续 active。

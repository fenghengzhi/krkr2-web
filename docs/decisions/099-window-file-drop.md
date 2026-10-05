# 099 Window 文件拖放与窗口回归

状态：开发候选，尚待 GitHub-hosted Actions 执行。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，未完成。会话协议 **39**，TJS ABI **5**、字体 ABI **2**。

本轮从干净的 `f995ed2` 继续。上一轮 098 的 63 个文件已经提交并推送，是实际进展。本地只进行源码检查、编辑，以及历史原件的下载、哈希核对、解包和解析；所有构建、测试、类型检查、浏览器及可执行参考探针只在 GitHub-hosted runners 运行。大批次推送后，下轮取回固定结果，不实时轮询。

## 固定的历史结果

对 097／`37329111623` 和 098／`37335381893` 各一次查询 run、jobs、artifacts 后冻结清单。**37 个原 ZIP、858,611,351 字节**全部 API SHA-256／大小匹配，其中 13 个旧包重新核对、24 个新包。总表为 `out/verification/github-actions/099-archive-summary.json`，各运行保留原始返回及 `099-final-summary.*`／`099-snapshot-summary.*`。

| 范围 | 097 终态 | 098 固定快照 |
| --- | --- | --- |
| run | completed／failure | queued／conclusion=null |
| jobs | 19 success、7 failure、3 cancelled | 7 success、18 running、3 queued |
| 原 ZIP | 29／846,793,162 字节 | 8／11,818,189 字节 |
| build | success | success |
| Node | 3,257 完整报告：3,225 pass、32 failure | 未报告 |
| 主浏览器 | 2,472 计划：1,938 pass、379 failure、155 未报告 | 未报告 |
| 原 KAG 兼容 | 96/96 pass | 未报告 |
| 直接运行时 | 6/6 failure | 未报告 |

098 的 run 与 jobs 是分别读取的非原子快照：run 返回 queued 时，稍后的 jobs 返回已经包含成功和运行中作业。这里保留两个原始事实，不通过再次查询来修改快照。098 尚无主应用报告，不能把未报告写成零失败或通过。

097 的 32 个 Node 失败与 096 同组：Pad 4、归档搜索 4、assignImages 2、Province 2、VideoOverlay 图状态 8、Window 生命周期／mainWindow 各 6；对应的 098 修订仍待结果。097 新增项目目录 17 个和视频音频 10 个 Node 定义已报告通过；真实浏览器音频 4×3 全部通过。项目浏览器 11/12 通过，另一个 WebKit 场景在初始目录导入／模式选择处失败，未进入资源命名空间断言。

097 主浏览器的 155 未报告来自取消的 Firefox shard 2（57）、WebKit shard 1（56）和 shard 2（42）。游戏库 57/57、PWA 59/59 有完整通过报告。双 Windows 光标 strict 仍各 **536/596 matched、60 failure、3,178 uncompared**，mask 各 **3,770/3,770**。有界 Layer 生命周期诊断正常不证明历史堆崩溃根因已解决；冻结原包没有完整 core，历史失败和未比较保留。

## 原版文件拖放契约

固定原版提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788`，原件在 `out/verification/window-popup/source/`。`WindowFormUnit.cpp:2192–2240` 逆序遍历 HDROP 的顶层项目，保留存在的文件或目录，构造真实 TJS Array 并投递输入事件，空 Array 也可投递。`WindowIntf.cpp:455–463` 在交付时检查 Window 的可用状态，仅向 Window 发出 `onFileDrop`，不广播给 Layer。`1004–1014` 的默认 action 要求至少一个参数，并把同一个 Array 放入事件字典的 `files`。

事件非合并、非丢弃型；System.eventDisabled 暂停交付，窗口退休取消其待处理事件。原版可见且启用的 Form 并不因没有焦点或不可聚焦而拒绝已收到的拖放。详见 `out/verification/window-file-drop/098-audit.md`。

候选在 DOM drop 回调内同步取得 File／目录能力，再由与普通输入相同的 FIFO 执行异步枚举和注册，避免后来点击超过尚未完成的拖放。Worker 使用 BlobSource 范围读取，Session 按 Window 身份、surface epoch、序号和生命周期检查，在交付时升级弱 Window 引用并构造真实 Array。资源注册不重启游戏，也不改变项目根、当前目录、存档身份或自动搜索路径。

每批分配实际检查碰撞的会话私有目录，顶层同名项目拥有不同子目录。文件拥有独立不可变资源身份；目录元数据保留空目录。原始归档沿用已有按需索引器，不为拖入资源增加 collection 裸别名。资源成功注册后属于 Session，即使目标窗口随后关闭，其他脚本已经保存的路径仍可读取；Stop 撤销未完成事务并清理会话资源。

异步准备前分别预留事件队列与 receipt 的容量，普通输入和 Timer 入队也计入这些预留；预留本身不成为可执行工作，不持有 VM 对象。取消、窗口退休和 Stop 唤醒等待者，失败路径幂等释放预留。实际枚举和读取可能晚于取消结束，其后续 Promise 仍被观察。

浏览器授予的是读取能力。本 Web 映射将拖入树设为只读，并在最终 SaveOverlay 写入、UPDATE／append、图像保存和备份导入处阻止覆盖。备份必须在改变现有存档前完整预检。目录、资源数量、名字长度、逻辑源字节和实际并发读取分别有预算；取消等待不会提前退还尚未结束的实际读取预算。

具体上限为每批 256 个顶层项目、10,000 个条目、64 层目录、4,096 字符路径和 2 Mi 名字字符；Session 最多 256 批、50,000 文件与 50,000 目录、8 Mi 名字字符及 64 GiB 声明源大小。完整读取最多 64 MiB，实际未结束读取最多 32 个／128 MiB。大型源保留范围读取能力，不因拖入就读取完整文件或索引完整归档。

外部 OS 拖放与构造的 DOM DragEvent 是不同证据。浏览器测试传递真实 File 字节和目录能力，但若通过测试控制接入目录 handle，只能证明能力枚举和会话处理链，不能据此宣称已经验证物理 OS 文件管理器拖放。浏览器缺少目录能力时必须明确报告，不能把目录静默省略成一个成功批次。

本批新增 **29 个 Node、每浏览器 16 个定义**：存储核心 8、真实 VM 写入 2、真实 Window 拖放 12、协调器 4、调度预留 1、光标 leave 顺序 2；浏览器为实际 App 拖放 12、File／目录能力 4。OPFS／legacy Entry 能力在不存在的浏览器上明确记为 skipped，不能计作目录支持通过。定义数量是源码库存，不是执行通过数量。

## 窗口回归修订

097 菜单光标原件显示：F9 popup 阻塞普通输入期间，早先排队的 mouseleave 在 Timer 设置新虚拟光标后才交付，把新光标形状重置为 default。真实 mouseleave 现在与 move 共用即时物理序号观察；Session 拒绝旧序号覆盖较新的脚本光标。新增回归同时要求后来的真实 leave 仍可接管、旧嵌入端无序号 leave 仍可交付。原菜单光标断言保留，清理失败不再遮盖主要失败。

历史 menu-modal 的真实 trace 显示点击目标 canvas 高度只有 31，却仍点击 y=50。夹具在安装菜单后重新设置所需 innerSize，并检查实际 backing；全屏夹具按真实桌面和所需宽高比检查 viewport，而非继续要求未全屏的 backing。恢复窗口时也先设置 chrome，再指定期望 innerSize。

字体／Province 鼠标夹具选取目标逻辑像素内可表示的整数 client 坐标，防止小数布局原点被 MouseEvent 取整到相邻像素；临时隐藏光标的独立 client／screen 控制同样使用可表示的整数，不更改原状态和命中断言。attention 的页面缩放覆盖整个测量后的 Window 及裁剪层级，仍检查正负锚点、窗口移动、字体及两次 CSS 缩放。

固定 System display 的测试区分 Player 构造期间的 display 观察器与之后用于真实窗口 chrome 的观察器：注入固定系统尺寸禁止的是前者，不能因后者正常存在就判失败。所有观察器在 Stop 后清理的断言保留。对无测量几何的嵌入宿主，生产 Window 观察器重新监听 canvas 的 CSS 尺寸，以更新外框 region clip 的页面投影；有测量几何的窗口继续使用完整 outer 的逻辑坐标。

## 剩余范围

本批新实现和新增定义均尚待托管验证。098 的主要回归结果仍需下一轮回收；原生光标严格差异、历史宿主崩溃、Firefox 媒体截图阻塞、更多音视频格式和真实游戏兼容仍未闭合。整体非插件目标继续 active，不能以完成本批候选替代完整目标。

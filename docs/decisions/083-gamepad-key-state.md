# 083 真实 Gamepad 输入与按键查询

状态：开发候选，未取得本批执行结果。仍以完成插件以外的 KRKR2 Web 模拟器为整体目标。全部可执行验证只在 GitHub-hosted Actions 运行，按大批次提交；下次取回结果，不实时监控。新增输入设置使用会话协议 **28**；TJS ABI **5**、字体 ABI **2** 不变。

## 原版合同与 Web 输入边界

原 KAG 的 `system/MainWindow.tjs` 已有方向、确认和取消的 Pad 映射，但此前 Web 只定义 `VK_PAD*` 常量，没有真实设备来源。本批接入 `navigator.getGamepads()` → 会话级采样器 → 现有 Window 输入队列 → Worker／TJS。没有用键盘 DOM 伪事件替代 Pad 键值，也没有替换 KAG 原处理器。

原版依据为固定提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [DInputMgn.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/DInputMgn.cpp)、[WindowFormUnit.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp) 及 SystemImpl 的查询路径。源码及大小／SHA-256 索引保存在 `out/verification/gamepad/source/manifest.json`。浏览器设备布局依据 [W3C Gamepad 标准布局](https://www.w3.org/TR/gamepad/#remapping)；这是 Web 映射，不是 DirectInput 设备编号、驱动校准或硬件延迟等价的声明。

- 每个会话仅一个采样器，RAF 驱动、间隔至少 50 ms。只在有资格的游戏窗口获得焦点时读取设备；菜单、页面控件、隐藏、模态阻断、暂停和 Stop 停止接收并释放旧按键。
- 初次选择最低 API index，连接未变时保持该设备。断开或 identity／mapping 更换后重新选择。初次进入或恢复时已经按住的每个键必须先松开，再次按下才接收。
- 标准设备的左摇杆和 D-pad 12–15 合成四个方向，buttons 0–9 映射 `VK_PAD1`–`VK_PAD10`。非标准设备明确使用其暴露的前两轴和前十按钮，不猜物理布局。`VK_PADANY` 只查询聚合，不生成额外按键事件。
- 原码按 left／right／up／down 的位顺序处理方向，按释放、新按下、重复的顺序派发。默认重复 delay=500 ms、interval=30 ms，首个计数在 530 ms；方向共用一组时钟，普通按钮另一组且选择最近一批新按下中的最低编号。每组每次最多补十轮重复，超额不积压；`ssRepeat=128`。
- Web normalized axes 映射为正 32767／负 32768 的整数范围后，使用原码不对称阈值 31128／−31129。原 DirectInput 另设 50% 驱动 deadzone，其具体外部重标定核尚未证明；本实现不编造第二个变换。

设备查询为空、未获得浏览器手柄交互暴露或 API 不存在时，不生成输入。查询异常会释放已接收的键、停止该采样器并报告原错误，键盘和鼠标路径独立。取消 RAF 增加 generation，暂停后恢复期间迟到的旧回调不得清除新句柄或再创建一个循环。

物理 Pad 状态与键鼠集合合并后立即送入现有 keyState 通道，不等待正在执行的脚本回调。脚本事件仍使用现有串行队列及 Window／keyboard route revision。窗口切换先向旧路由释放，再进入新路由；临时菜单保留逻辑 Window 焦点，但暂停手柄。模态阻断、退休 surface 和旧会话不能重新获得输入。

## 参数与 System.getKeyState

`-joypad` 在首个 Window 构造时固定：省略或精确字符串 `dinput` 启用，其余值禁用。`-paddelay`／`-padinterval` 默认 500／30，后续 `System.setArgument` 更新重复参数。初值和后续值都通过真实 TJS `int` 转换，再收窄到 signed 32-bit；原字符串仍可由 getArgument 取得。负 delay 或非正 interval 禁用重复。新 InputView 携带设置，DOM driver 从 Worker 类型图排除。

`System.getKeyState` 现在处理第二参数和最近按下记录：省略默认查询当前；显式 void 按 TJS 布尔转换为 false。键值先经过原 int64→uint32 低位转换。返回值即使被脚本丢弃，查询仍执行。

- Pad current 查询不消费记录；false 消费指定键的按下记录；`VK_PADANY,false` 消费所有 Pad 记录，保留键鼠记录。
- 非 Pad 查询模拟本会话已观察的 Win32 高／低位合同：true 或 false 调用都会消费该键“自上次查询以来”的记录，结果分别是当前状态或记录值。
- 只有已观察的 0→1 变化产生新记录；重复、相同快照和 script-posted 输入都不能制造一次按下。释放、失焦或暂停不消费未查询记录，Stop／新会话才清空全部状态。

范围限于网页实际观察的物理输入；不能获取操作系统桌面上其他应用的按键，也不宣称复现 Win32 跨进程竞争低位的行为。

## 已回收验证与仍失败范围

本批对 081／082 的 run、jobs、artifacts 各只取一次固定快照，全部 **32/32** 原 ZIP 大小与 SHA-256 匹配，旧快照不覆盖。

[081／37240240034](https://github.com/fenghengzhi/krkr2-web/actions/runs/37240240034) 已终态 **failure**，23 job 中 16 success／7 failure。Node 报告 **2770 pass／2772**，两失败是 binder 的 SIGTRAP 与 menu-lifetime 的 SIGABRT 进程；崩溃后未报告用例不算通过，原始栈保留且根因未证明。CUR format **28/28**、load **12/12**、storage **16/16**、Session **20/20**；它们是 081 定义，不能代替 082 新增定义。常规浏览器 **1981 pass／14 failure**，其中 13 个光标断言，另一个 WebKit 图片写入启动超时。library 57/57、PWA 59/59、trusted 7/7、兼容 96/96、六组 direct runtime 和 allocator 120/120 的各自结果保留。完整证据为 `out/verification/github-actions/37240240034/083-final-summary.md`。

[082／37242235256](https://github.com/fenghengzhi/krkr2-web/actions/runs/37242235256) 固定快照仍 **in_progress／conclusion=null**，6 success／2 Windows failure／14 running。Build、allocator 120/120、trusted 7/7、Chromium library 19/19 和 PWA 20/20 已有报告；Node、常规浏览器、兼容和 direct runtime 尚无产物，不推断结果。两套 Windows 完整采集 **87** 份：raw **173/173 限定匹配但 partial**，另 2 份转交产品加载范围；strict **258/308 匹配、50 draw 差异、0 接受差异**，11 份 ANI 的逐步 rate／steps／duration 元数据匹配，另 1,738 个 draw 未比较。墙钟动画仍未测。摘要为 `out/verification/github-actions/37242235256/083-snapshot-summary.md`。

082 的 128 组缩放诊断已完整保存，但没有全局零差异公式。64×64 alpha 两种编码的中心双线性结果与 raw plane 一致，反证原统一整数缩小 nearest 候选；256 mask 边界也有确定差异。修订只采用可证明的范围，其余继续进入严格 gate，不按“最接近”候选放宽像素容差。

本批将固定 profile 的 64×64 alpha→32×32 改为中心 2×2 均值再向下取整，并新增完整原生 RGBA 平面 SHA-256 回归；光标加载共 25 个定义。96→32 的中心恰为整数，不能区分 nearest 与 bilinear，未据此推断唯一原生算法。256 的 mask 生产算法保持待校准，原生矩阵从 87 扩为 **95**：1 位和 32 位零 alpha 各增加多边界、孤立 1、孤立 0、棋盘四种源坐标图案，AND 与单色 XOR 使用独立坐标方向，公式和坐标系随 metadata 保存。这些样本用于区分采样、收缩和偏移，不能把旧半幅样本的一行差硬编码成结论。

浏览器历史失败也分别处理：WebKit 的 marker CSS 大小 32×32，但旧截图为 64×64 设备像素；原 PNG 在正确坐标含精确预期颜色，本批明确截图比例而不放宽颜色断言。物理光标定位需对照实际 MouseEvent 坐标，不能把请求给浏览器的浮点移动坐标当作已观察事实。非整数 CSS 采样和其他尚未证明的差异仍保留。

## 本批托管验收定义

| 范围 | 新增或扩展 |
| --- | --- |
| 纯设备状态机 | 25 个定义，覆盖映射、逐键 neutral、设备变化、两组重复、上界和独立输出所有权。 |
| 浏览器采样驱动 | 4 个定义，覆盖 50 ms 当前采样、暂停恢复迟到 RAF、API 异常和最终清理。 |
| 多窗口协调器 | 4 个定义，覆盖与脚本队列并行的状态、焦点转移、临时菜单、模态／参数／退休。 |
| 真实 TJS 查询 | source／bytecode 共 12 个定义，覆盖记录消费、类型转换、事件禁用、重复、posted 输入和生命周期。 |
| 参数与 Window | source／bytecode 共 6 个定义，覆盖默认值、初次固定、动态更新、整数转换及依赖参数。 |
| 真实浏览器 | 每浏览器双后端共 4 个定义；受控设备快照经过生产 navigator 采样、Worker 和 TJS，核验按下／释放／重复／查询、焦点、断开、Stop 和新会话。 |
| 原 KAG | 原 6 个 cursor 兼容 case 保留键盘全部阶段，再增加真实原处理器的 Pad 方向导航、确认和独立设备观察；库存总数不靠重复计算增加。 |
| 光标回归与参考 | 新增完整 64→32 alpha 原生平面回归，加载共 25 个定义；两套 Windows 分别严格采集 95 份资源。截图比例及物理事件坐标修订保留原有精确断言。 |

以上是本批待执行定义，不能算通过。托管受控 Gamepad API 快照可以验证设备边界之后的完整链路，不是实际硬件、浏览器首次授权或任意驱动布局的实测。本批之后仍需回收 082 完整终态及本批结果，并继续缩放、其他输入边界、长音频流式解码和视频多音轨等完整非插件工作。

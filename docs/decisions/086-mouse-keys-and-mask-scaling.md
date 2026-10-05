# 086 键盘模拟鼠标、掩码缩放与交错视频

状态：开发候选，尚未取得本批执行结果。完整目标仍是完成插件以外的 KRKR2 Web 模拟器。会话协议 **31**，TJS ABI **5**、字体 ABI **2** 不变。所有测试、构建、浏览器与原生探针只在 GitHub-hosted Actions 执行；按较大批次推送，下次工作时回收固定快照，不实时监控。

已整批推送 `a3272586a93a5b7f13c1812396cc5b35f313db31`，对应 [Full test suite 37273929294](https://github.com/fenghengzhi/krkr2-web/actions/runs/37273929294)。首次唯一查询为 **in_progress／conclusion=null**，只确认运行创建及精确提交身份；原响应保存在 `out/verification/github-actions/37273929294/initial-run-discovery.json`。没有查询实时 jobs／artifacts；下一轮先补取 085 终态，再回收本批固定清单与产物。本记录以 `[skip ci]` 文档提交保存，不产生通过结论。

## Window.useMouseKey

此前 `useMouseKey` 只有属性存储，没有实际行为。本批按固定 KRKR2 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [WindowFormUnit.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp) 接入键盘和 PAD 的鼠标模拟。方向键／PAD 方向控制位移，Enter／Space／PAD1 为左键，Escape／PAD2 为右键。

转换发生在引擎确认 Window 接收者、`trapKey` 门控和输入生命周期之后。这样陷阱窗口使用自己的设置，不能被前端提前吞键绕过；`Window.postInputEvent` 的脚本按键直接进入原来的事件路径，不经过窗口表单的鼠标转换。方向 down 被吞，方向 up 继续作为键盘事件；按钮键的 down／up 被转换，Esc／Enter／Space 的对应字符输入被吞。

纯状态机保留原版的 50 ms 节拍、45 ms 最小间隔、第一次方向动作后的 100 ms 延迟、每次加速度变化、Shift 加速、反向重置、另一轴减速及负奇数算术右移。位移单位是客户区 CSS 像素，经实时比例换算为 Window 客户坐标，再进入既有 zoom／PaintBox／Layer 坐标转换。页面提供指针观测与尺寸比例，计时由引擎时钟决定；持续移动仅针对获得焦点且未显示菜单的窗口，延迟一帧不回放一串补偿动作。

左键 keyup 先产生独立 click，再产生 up；click 使用最后一次 down 的坐标，up 使用当前坐标。Window 先收到 click；Layer 只有在该坐标命中且仍持有 capture 时才收到 click，依据 [LayerManager.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerManager.cpp) 的 `PrimaryClick`。单独 click 不改写当前光标观察、不释放 capture，也不能被模拟鼠标事件中的空 shift 覆盖真实键盘／鼠标状态。

每次赋 `true` 都重置模拟按钮标志和节拍，保留加速度；赋 `false` 对仍按住的模拟按钮在最后一次 move 位置补 up，不补 click。setter 使用原版布尔转换，`0.5` 不能先被整数化为 false。重复 down、没有配对 down 的 keyup，以及窗口外按钮事件的处理按固定原版路径保留。真实鼠标接管更新当前位置，持续按住方向时下一次节拍从该位置继续。虚拟光标由 Window 自身拥有，无主 Layer 时也不伪造脚本对象身份；Web 只移动页面内标记，不移动操作系统指针。

手柄采样提供“先移动、再读取新 PAD 状态”的节拍入口；纯键盘配置保留独立定时入口。节拍随包冻结此前已接纳的有界按键集合，即使等待前一事件 ACK，也不会被较新的物理状态改写。该集合只用于这次移动，不能写入 `System.getKeyState`。迟到 move 在检查序号后才更新历史位置；窗口移动／缩放而物理鼠标静止时重新投影同一观测，有有效虚拟光标时则不能由旧观测覆盖它。事件预算拒绝会回滚尚未成功接纳的虚拟位置。

普通模式切换不凭空撤销已经派生的输入事件；Window 退休、会话停止和原有输入失效规则继续负责丢弃过期工作。源码／字节码验收检查事件顺序、捕获、物理按键、禁用补 up、重复赋值、CSS 比例／zoom、145 ms 首次门槛、真实指针接管、陷阱路由、脚本投递和退休时的清理。纯状态机与真实浏览器链路另行覆盖加速、PAD 和节拍生命周期。所有新增定义均待托管执行。

本批新增 **30 个 Node 定义**：mouse-key 状态／节拍 6、协调器 3、真实 Session 10、光标字面值 3、MP4 增量 8（该文件从 14 增至 22）。每浏览器新增 **12 个定义**：真实键盘／受控 PAD 经生产链路的 8 个，以及交错视频的 4 个。PAD 数据来自受控浏览器 API 快照，不冒充物理手柄实测；桌面边缘裁剪、OS 屏幕外移动和浏览器调度不能据此称为与原桌面完全等价。

## 原生光标掩码

本次回收的两套 Windows 各 1,100 行原始采样一致。在 256→32 的四个 AND 轴组中，输出第 0 个坐标依赖输入 0…4，其后是 5…12、13…20，直到 245…252；最后三行／列不影响单独 AND 输出。72 个 AND 点观察与独立两轴支持集合一致。

单色 XOR 的边界观察不能解释为两份独立缩放。例如原 AND 第 253 行的零线不影响输出 AND，却把输出 XOR 的第一行变成零；AND 点 (5,253) 仅影响 XOR 的 (1,0)。这些原始结果支持将上半 AND、下半 XOR 的 256×512 单张 mask 缩放为 32×64，XOR 首行会覆盖原 AND 的末三行。生产修订据此使用删除像素的 Boolean AND 聚合，并将单色两半作为共同坐标空间处理。

通用比例采用前一中心样点之后至当前中心样点的区间，放大时重复样点取单点。**完整 256→32 采样支持该尺寸的区间；其他比例推广尚未验证。** 新增 64×64、48×48、13×9、64×48、48×64、64×13、13×64 的独立单平面原生观察，每种分别改变 mono AND、mono XOR 和 32-bit AND：1,872 条轴线、42 个常量、756 个点，共 **2,670 行**。

旧 1,100 行及原有 95 份完整 CUR／ANI 观察保留。新严格 mask 比较将全部 **3,770 行**的生产加载结果与原始 GetIconInfo plane 逐像素比较，保存每行结果和差异；原 CUR、原 plane、阶段 JSON／JSONL、进程超时和清理结果也保留。三个 Node 回归使用原始观察中的字面坐标／像素，未使用生产算法制造期望。

158 个颜色缩放候选仍没有全域零差异；13×9／48×48 的单通道量化差异继续保留。本批不按最接近排名替换颜色核，不加像素容差，也不删除原 strict gate。原生采样是固定 GitHub-hosted Windows 的 User32 API 行为，不冒称执行了原 Borland/VCL 引擎或验证了真实墙钟 ANI 播放。

## MP4 的独立分片地址校验

085 因固定 MP4Box 2.4.1 忽略同一 traf 后续 trun 的显式 `data_offset`，暂时拒绝这种合法地址形式。本批自主读取 trex／tfhd 的默认 sample size／duration、每个 trun 的 signed offset 和逐样本字段，按固定 traf base 加显式 offset 或前一 run 末尾计算实际地址，独立检查 mdat 边界与安全整数时间。MP4Box 继续处理普通样本表与整体数量，不能用其错误连续地址证明分片合法。

选轨仍保留文件长度、媒体字节、样本地址、时间轴和原索引关系；解除的是已获得独立校验的多 run 限制。跨被移除 traf 继承基址、加密、外部资源和未知结构等其余边界继续明确保留。该实现没有新增逐样本的大型重复对象，原 64 MiB 选轨输入、轨道／box／样本上界和取消检查继续适用。固定依赖依据 [MP4Box.js v2.4.1](https://github.com/gpac/mp4box.js/tree/v2.4.1/src)；偏移和结构范围仍受原文件界限约束。

托管构建通过 [FFmpeg 的 frag_interleave](https://ffmpeg.org/ffmpeg-formats.html) 生成完整交错 MP4，保留已有普通、共用 moof 和独立 moof 三份夹具。四份文件均生成独立 ffprobe packet 清单，包含原始 pos、size、PTS／DTS、duration 和 SHA-256。Node 验收必须确认真实存在多个非连续显式 run，再比较原媒体字节；应用浏览器增加交错容器的双后端 × 源码／字节码四个定义，继续读取实际 440／880 Hz 输出及播放位置。夹具和验证仅在托管机器执行，尚无通过结论。

## 固定快照与构建修订

[085／37270916669](https://github.com/fenghengzhi/krkr2-web/actions/runs/37270916669) 的 run、jobs、artifacts 各查询一次。固定快照仍为 **in_progress／conclusion=null**：10 个 job 中 3 failed、1 success、1 in_progress、5 skipped，未出现最终 All tests 结果。固定清单 **4/4 原 ZIP** 共 17,786,890 字节，大小和 SHA-256 均匹配；没有刷新以取得稍后的产物。完整记录在 `out/verification/github-actions/37270916669/086-snapshot-summary.md`。

Build 报告 **3 条 TypeScript 诊断**：`kept` 的推断为隐式 any，以及两处为 Window 动态添加频谱观测方法时的类型转换。本批将相关 box 数组拆成独立显式类型声明，并明确动态属性的转换边界。后续 Node、浏览器、原 KAG、直接 runtime、可信生命周期全部 skipped；084 流式音频、083 手柄和 085 视频改动仍无执行报告，不能追认为通过。

Asyncify allocator 在该快照为 **60/60**，JSPI 当时仍运行、产物未发布，结果未报告。两 Windows 各 95 份原生加载观察，strict 各 **270/332 匹配、62 draw 差异、1,858 未比较**；raw 173/173 仅为 partial，11/11 ANI 元数据比较匹配。Mask 原生采样 1,100/1,100 完成只证明采集完整，当前生产修订仍需新托管执行。下一轮补取 085 终态和后续产物，再回收本批结果。

完整非插件目标保持 active。除这些候选与回归外，仍包括剩余 Window 接口、完整几何／字体／输入差分、Vorbis 高效随机跳转和其他编码流式化、旧视频编码及长视频读取、存储边界和复杂 KAG／媒体恢复场景。`beginMove`、`setMaskRegion/removeMaskRegion` 等已识别接口缺口另行推进，不能以本批已实现内容替代整体完成。

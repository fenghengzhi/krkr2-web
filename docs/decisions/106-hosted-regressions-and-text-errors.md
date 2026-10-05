# 106 托管回归与原生错误边界

状态：开发候选，尚待 GitHub-hosted Actions 验证。从干净的 `68d4adf` 继续；105 已提交和推送实际实现，是有进展的一轮。整体目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。协议 **41**、TJS ABI **5**、字体 ABI **2**，已有 `nativeSystem:5`、`nativeRandom:1`、`nativeMessages:1` 保持。

实现提交 `e35f394d87b3aa48fd85c0281f9b9a8becd6dc1c` 的 **54 个文件**已整批推送至 `codex/migrated-window-attention`。[完整托管验证 37368014184](https://github.com/fenghengzhi/krkr2-web/actions/runs/37368014184) 首次唯一身份查询为 **pending／conclusion=null**。原响应保存于 `out/verification/github-actions/37368014184/initial-run-discovery.json`，仅确认运行与提交身份，不是通过结果。本轮不再查询 jobs／artifacts，下轮补取 104／105 未报告范围及本批固定结果。交接文档另以 `[skip ci]` 提交，不是另一轮验证。

本地仅源码检查和编辑、Git 操作，以及历史原件下载、解包、校验和解析。没有运行测试、构建、类型检查、浏览器或候选执行探针。各次固定回收不刷新；本批整批推送后只记录一次运行身份，下轮取回结果。

## 固定证据及完整性

104／`37359511361` 和 105／`37364141321` 的 run、jobs、artifacts 各取一次。104 为 in_progress，32 jobs 为 **22 success、6 failure、1 cancelled、3 running**；105 为 pending，**0 jobs、0 artifacts，没有执行证据**。仅另取已冻结的 Node job 原始日志说明取消情况，没有再查状态。**30 份原 ZIP、361,278,446 字节**全部匹配 API 大小和 SHA-256，十份复用重核、二十份新取。总表为 `out/verification/github-actions/106-archive-summary.{json,md}`。

104 构建通过。主 Node TAP 没有 footer，仅有 **2862 ok、113 not-ok 原始记录**，其中一条是整个 menu-modal worker 的 SIGABRT，不能将该文件当成只有一个测试。另行解析独立 `node-execution-events.jsonl`，取得 **3486 个已排队 child、3465 个已完成 child（3308 passed、157 failed）**；余下 21 个属于 menu-modal：前三个通过，第四个开始后进程崩溃，另二十个未开始。这个事件库存也不是全部测试声明的总数。两个证据流各自保留，不拿较小的 TAP 流当最终全集。独立 JSPI 栈池 **6/8**、随机数 **8/16**。

Node 原日志在 19:18:59 记录取消，job 时长与二十分钟配置吻合，但原日志未明确写出 timeout；不补造取消原因。停止前 system-application 子进程没有退出记录，保留运行中的边界和 runner 后续终止日志。

Chromium 主浏览器 **845 expected、62 unexpected**；Firefox 第一主分片 **434 expected、20 unexpected、1 skipped**，其余三个主分片仍运行、未报告。Chromium PWA **19/20**，其他两个 PWA **20/20、19/19**；三个 library 各 **19/19**。可信生命周期 **4 expected、15 unexpected**，直接 runtime 的六个后端／浏览器组合均在事件资源基线失败。

三浏览器兼容各 **32/32**；两种 heap 模式各三组二十轮正常结束，范围限于对应受控诊断。双 Windows 原件各 343 个，cursor strict **1076/1076 matched、0 failure、5578 uncompared**，mask **3770/3770**，portable 已比较 **173/173** 但仍为 partial。历史失败、未比较、未报告与取消继续保留，这些局部成功不是完整运行通过。

## 容器工厂的真实退休

104 RandomGenerator 失败的八个定义都在最终清理时报告 **9 个 live dispatch 对象**，并非 MT 序列不匹配。实际 `serialize()` 调用 `TJSCreateDictionaryObject`，其函数静态 holder 把 Dictionary 类及原生方法一直持有到进程／模块退出；`krkr_destroy` 后仍有这组根。Array 的同类工厂也有相同退休边界。

现在仍在引擎存活期间复用同一工厂，保持方法身份；引擎 Cleanup 在 globals 和 script cache 释放后、全局字符串注册释放前撤销两个工厂根。先清空缓存指针再 Release，便于失败清理和后续重新创建。Dictionary 创建路径初始化输出指针、检查 CreateNew 状态，只在成功后发布 classout 的额外引用。不是逐次重新创建类，也没有放宽终态清零断言。

新增真实容器回归用宿主 ScriptList／ScriptRecord、原生 Random.serialize、重复分配和 collect 验证稳定库存，两个并存 Module 交错调用，一方销毁后另一方继续。最终每个模块 live dispatch 必须为零。同一组定义额外经 JSPI 内核运行。原 16 个随机数定义完整保留。

## 应用事件的私有上下文

104 浏览器原始错误上下文明确记录 `Member "application" does not exist`。事件泵返回的 TJS 函数直接引用了已返回工厂的局部参数；TJS 不会按 JavaScript 的词法闭包保留该局部。激活事件因此抛错、停用事件派发，影响应用事件、后台活动、模态生命周期和部分退出场景。

事件泵现在以 `incontextof` 绑定私有 Dictionary，显式持有原生 application 回调；宿主调用和公共 System 查询明确从 global 取值。临时入口仍从 System 和 global 删除，不增加游戏可见接口。原生回调继续在事件发生时读取当前 global.System，保留绑定 receiver、属性 getter 的日志边界、事件异常处理、暂停／替换／Stop 的原有行为。既有十二个实际 application 定义和关联浏览器场景重新验证；首个串行场景在再次投递前明确检查 eventDisabled，避免前一错误变成无诊断的等待。

## 文本流消息的实际调用点

依据固定 2.32stable `TextStream.cpp`，区分无效 cipher、写入模式和压缩失败。格式层只产生有限的 `TextStreamError` 类别，宿主在实际文件调用点映为 `TVPUnsupportedCipherMode`、`TVPUnsupportedModeString`、`TVPCompressionFailed`。没有按英文内容判断，也没有把平台缺失、内存分配、Web 预算或取消错误统一改名。

原 Win32 unsigned long 的 32 位长度边界先于较小的 Web 64 MiB 限制；uint32 范围内超 Web 预算仍是预算错误。仅压缩 reader 的真实数据失败和明确解压长度失配有 compression 品牌，checkpoint 的异常原样传播。模式错误在创建流和定位写目标之前发生，不能留下排队写入。

文件名按原调用链区分：Array 文本读取使用请求名；Scripts.execStorage／evalStorage 和启动脚本先定位，再以已定位的公共 storage 名创建 reader。compileStorage 扩展仍用其请求名。KAG、帮助文本与 Sound 的 `.sli` 解码也在各自真实文本读取边界映射；SLI 语法和音频其他错误不包入此分类。无脚本栈可恢复的末尾写入沿 105 的纯原生 formatter 保留 cause。

新增实字节验证覆盖未知 cipher、坏 BOM、真实 zlib checksum、长／短解压输出、c0／c1／z 的正常恢复、Array 内容保留、无编译输出、写入预检和压缩失败重试。受控压缩故障只在显式 codec 依赖注入，不伪造宿主 TVP 异常。

## 全屏方法与回归夹具

Window.beginMove 和 showModal 使用原 `TVPInvalidMethodInFullScreen`，与属性 setter 的 holder 分开。showModal 的 fullscreen 检查恢复到 visible／modal 状态检查之前，对齐原 WindowImpl 的调用顺序；失败前不打开模态、发移动请求或改变输入状态。新增实际 TJS 源码／字节码和浏览器全屏往返验证消息赋值与恢复。

部分失败来自旧夹具与现有合同冲突，本批明确修订而不删断言：

- 事件、声音和视频生命周期的真实 50 ms 系统维护任务与用户 Timer 分开计数；仍核对用户资源恢复、后台任务存在，以及 Stop 后全部清零。
- help-native 单独验证一次携带原生 ScriptObject 的 bindCompact 初始化；真正帮助调用的 string／arity 约束保持。
- 栈池终结器明确使用 global.PoolFinal／grow，避免类内同名构造函数被当成新类；嵌套终结和栈池断言保留。
- 消息夹具实例化真实 TJS 用户类，以触发目标缺失成员错误；不依赖不存在的 JavaScript Object 构造器。
- 单行浏览器表达式框通过带转义换行的 `Scripts.eval` 保留多行表达式及行注释；仍核对实际输入值和真实结果。
- cursor 恢复操作作为同一已编译语句函数执行，不把多语句交给 expression 模式；drop 写入函数显式接收目标参数，不假定 TJS 捕获外围局部。
- DataTransferItem 能力观察在同步捕获期间对真实原型做有界替换并恢复；不能假定两次读取同一 item 返回同一个 JS 包装对象。原目录、容量与原型恢复断言保持。
- 两条过渡恢复夹具在精确 99／100 ms 位置请求真实 Layer／Window 更新，再检查提交画面的独立 RGB 值和回调 0→1；不把读取普通变量当成额外画面提交，也不延长完成期限。冻结期间仍保持原 1000／960 ms，图形生产调度没有为测试改动。

## 视频帧率与独立参考的时间轴

104 的三个视频 catalog 失败都发生在分片封装：原 ffprobe 的 `r_frame_rate` 仍为 12／10，但第一包后的 CTS 间隔增加约 21 ms，`avg_frame_rate` 分别变成 `884736/73991`、`204800/20553`。旧算法将这段封装时间计入名义帧长。固定原版从 DirectShow 的 AvgTimePerFrame 取 FPS；固定 FFmpeg H.264 parser 从 SPS VUI 的 `2*num_units_in_tick/time_scale` 取名义时钟，展示时间轴是另一件事。

现在对 progressive avc1 的全部实际使用 sample descriptions 读取有界 SPS/VUI；支持的 SPS 必须一致才采用编码时钟，不要求 fixed_frame_rate_flag 为真。读位、Exp-Golomb、scaling list、emulation-prevention 和元数据总量都有边界。未知 profile、无时序、interlaced、avc3 或不同描述时序不能猜测，保留明确的 sample-average 后备路径。**CTS、edit list、定位和展示顺序不变。** 旧 VFR 验证继续逐帧比较时间戳，并以 avc3 描述明确覆盖平均后备；旧 x264 特殊 SEI 时钟修正仍是未实现边界，也不声称所有 DirectShow filter 都按同一策略解释任意视频。

原浏览器比较把 interleaved 文件在 1 s 的画面与 regular 封装参考在 1 s 的画面相比，两者可能是不同编码帧，不能仅用像素容差掩盖。保留旧两个 regular 参考，Actions 另生成四种容器 × 两个视频轨的八个独立 FFmpeg stream-copy 参考；用原容器 packet 的 SHA、size 和精确有理 PTS／DTS 核对，再由浏览器选择对应容器的参考进行完整 RGBA 与图层区域比较。新增八份 packet 报告和 SPS trace_headers 原日志。新产物尚未在本地生成，不宣称其实际大小或通过。

## 崩溃证据边界

menu-modal 的原回溯为 glibc `corrupted size vs. prev_size`，发现位置在 `node::RegisterDestroyHook` 的分配过程。第四个测试开始后崩溃，不足以定位此前的写坏来源，也不能归因于某个 WASM 函数或宣称已修。104 发布的三十份 ZIP 中没有原始 core 字节，只有 core SHA-256 和完整原回溯；这些原件继续保留。后续 workflow 单独上传 `out/native-cores/` 的完整 core，同时保留现有回溯和进程边界，补足未来诊断证据，不改写历史缺失。

本批新增 **32 个常规 Node 定义、每浏览器 8 个定义**：文本流 16 Node／4 browser，容器工厂 4 Node，全屏方法 6 Node／4 browser，维护任务与声音 2 Node，AVC timing 4 Node。同一组容器工厂 4 定义另经同次构建的 JSPI 内核执行。旧失败的断言修订与加强不算新定义，新增数也不是通过数量。

本批所有修订和新增定义仍待托管执行。下轮补取 104 未完成的三个主浏览器分片和终态、105 的结果，并回收本批固定结果。崩溃根因、未报告范围、历史浏览器失败、未迁移的其他原生错误分支（包括部分文本短读）、其他非插件功能和更多真实游戏验收仍待完成。

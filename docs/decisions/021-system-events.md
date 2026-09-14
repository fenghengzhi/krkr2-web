# System 事件、连续回调与 Web 派发

`System.eventDisabled` 控制事件派发，和用户、页面、GPU 暂停分开。脚本仍可以执行表达式、读取资源、操作媒体并把事件重新启用；AudioWorklet 和视频播放时钟也不因该标志停止。

## 实现边界

- `engine/scheduler/system-events.ts` 维护 exclusive、input、normal、idle 队列、连续回调注册表、原生 generation 截止值和防重入状态。
- `engine/scheduler/events.ts` 保留 Timer/AsyncTrigger 的源对象、容量、缓存替换和取消语义，统一向 System 队列提交。计数只包括尚未取出的事件，不包括正在执行的回调。缓存替换物理移除旧任务，避免长期禁用时堆积无效队列项。
- `engine/tvp/system.ts` 在原有 TJS 栈中调用事件和异常处理函数；`System.eventDisabled=false` 可同步派发已排队事件，不需要另起 VM。
- `engine/session.ts` 把独立菜单、输入、声音与视频通知接入相应优先级和有效性检查。浏览器菜单与快捷键同时检查页面可见性；排队菜单保存输入 epoch，隐藏再显示后不重放旧点击。
- WASM **ABI 2** 新增精确闭包身份读取，以及只返回原生调用状态、不读取用户返回值的调用方式。闭包身份同时包含函数对象和绑定的 `this`；同一方法在两个实例上注册是两个回调。跨线程协议为 **6**，快照携带 `eventDisabled`。

这些结构仍以 TypeScript 和 Web API 为主体。C++ 只补 TJS VM 必须提供的闭包与调用语义，不把参考引擎整体搬入 WASM。

## 已实现的事件语义

| 情况 | 行为 |
| --- | --- |
| 禁用后新 Timer tick、可丢弃输入移动 | 丢弃 |
| 普通 AsyncTrigger、不可丢弃键盘/输入、异步媒体结束 | 排队等待 |
| 菜单通知、同步媒体状态、视频帧/周期脚本通知 | 禁用时不调用 |
| 显式弹出菜单选择 | 可结束 popup 并返回命令 ID；禁用时不通知 onClick |
| `eventDisabled=false` | 在当前 TJS 栈同步处理可派发事件；不凭空产生连续 tick |
| 用户/页面/GPU 暂停 | 由原暂停门控制 VM 和媒体，并补偿连续回调剩余期限 |
| 停止会话 | 取消等待、清空队列和闭包注册，释放原 VM |

同一批 exclusive/normal 完成当前可派发组后才检查新 exclusive；input 每次回调后检查。idle 后已存在连续通知时，允许先执行一个连续回调再响应 exclusive。嵌套派发使用原生的全局 generation 行为，连续回调有独立防重入状态，避免在 handler 内重新启用事件时递归调用自身。

连续注册按活列表遍历：新增回调可在本轮执行，删除未来回调立即生效，重复闭包不重置时钟。删除使用空槽并依照原生观察空槽的时机压缩；最后一个回调自删除可能需要下一次空轮收尾。无法调用或已失效的回调按原生失败状态移除；回调返回负数本身不代表调用失败。

`System.setArgument(name,value)` 修改会话参数。`-contfreq` 在下一次唯一注册时按 TJS 整数转换读取；单独修改参数或重复注册不会重启计时。间隔使用 16 位毫秒小数，第一次唤醒采用参考实现的向下网格点。禁用期间只保留一个连续通知，恢复不追赶每个错过的 tick。Web 计时器的后台节流和实际精度仍由浏览器决定。

## 异常

事件回调抛出的值交给当前 `System.exceptionHandler`，返回真表示已处理；未处理则禁用后续事件，保留会话和表达式控制台。抛错的连续回调移出注册表，其他注册保留。异常处理函数自身抛错时同时报告原异常与处理异常。显式设置的禁用状态不被“已处理”结果自动清除。

处理函数先读取到局部闭包再调用，避免 Dictionary 成员直接调用提供错误的 `this`；对象方法的已有绑定保留。读取一次也避免重复执行脚本属性 getter。TJS 的对象 typeof 文本为 `Object`；脚本可抛出字符串等普通值，诊断转换不能假定异常必有 message。缺失、null 和非对象处理函数按未处理对待。

该处理路径覆盖当前接入的事件队列，尚不代表所有原生错误对话框、启动异常、立即事件异常捕获和窗口更新尾部的完整控制流一致。

## 预算和验证

队列最多 65,536 项，连续注册最多 65,536 个有效闭包、262,144 个原始槽位，嵌套派发最多 64 层。频率接受整数 0–65,536,000 Hz；0 表示不指定频率。超出会导致原生零/负间隔的问题值明确拒绝，不复制原生挂死。连续的短回调链每约 8 ms 让回宿主事件循环；长 TJS 指令循环沿用原生预算检查，因此停止命令可以进入。

`tests/probes/system-events-native.py` 从只读参考仓库抽取 10 个事件函数，以平台和回调桩编译并启用 AddressSanitizer/UndefinedBehaviorSanitizer，生成 10 组参考轨迹。真实 TJS/WASM 集成测试复现同样输入，覆盖优先级、嵌套 generation、连续增删、防重入和禁用时入队。该 oracle 不包含实际原生 GUI、完整 TJS、时钟或窗口更新，不能据此声称全部原生事件一致。

其他定向测试覆盖频率更新、暂停期限、异常上下文、容量、7 万次缓存替换、菜单旧 epoch、popup 返回和无限回调停止。浏览器测试在 Chromium/Firefox/WebKit 的 Asyncify/JSPI 中检查相同用户入口和真实媒体位置。独立 ABI 更新探测使用保留的 ABI 1 发布包和当前 ABI 2 发布包；外部 KAG 探测继续使用参考模板原有脚本。

完整 `npm run check` 已通过 260 项引擎/集成测试和 462 项浏览器测试；独立 ABI 1 → 2 离线探测的三浏览器双后端共 6 个案例也已通过。外部原 KAG 的 XP3/ZIP × 三浏览器 × 双后端 × 输入/存读档/转场共 36 个案例全部通过。由 `tests/probes/system-events-matrix.mjs` 将源码、测试、构建、WASM、参考函数和结果哈希写入 `out/verification/system-events-matrix.json`。未覆盖的原生窗口/IME、全部立即事件异常时序、Timer 隐式所有权、字体、流式媒体和其他非插件接口继续列在 [非插件进度](../non-plugin-progress.md)。

依据：[KRKR2 System](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_System.html)、[连续回调](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_System_addContinuousHandler.html)、[事件禁用](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_System_eventDisabled.html)，以及参考仓库 `cpp/core/base/EventIntf.cpp`、`ScriptMgnIntf.cpp`、`SystemIntf.cpp` 和 `cpp/core/base/impl/EventImpl.cpp`、`cpp/core/utils/TimerIntf.h` 下的事件/时钟实现。抽取函数哈希保存在 `tests/fixtures/system-events/events.json`。

已知输入边界：`Window.cursorX/cursorY` 当前取自已派发的鼠标包。禁用事件而丢弃移动包时，查询可能保留旧位置；应在后续窗口输入实现中区分物理位置观察和脚本事件派发，并验证坐标缩放与后台 epoch。

# 105 原生 TVP 消息与真实异常路径

状态：开发候选，尚待 GitHub-hosted Actions 验证。从 `88c234f` 继续，整体目标仍是完成插件以外的 KRKR2 Web 模拟器，未完成。本批补充原生消息库存及真实异常消费者，并按新取回的原版证据修订菜单打开时的异步退出。协议 **41**、TJS ABI **5**、字体 ABI **2**、`nativeSystem:5`、`nativeRandom:1` 保持，新增独立门禁 **`nativeMessages:1`**。私有 Reply 的类型增加不改变 Session RPC。

实现提交 `34aca0ddc9594618a284d8c1f29eef96eed75898` 的 **52 个文件**已整批推送至 `codex/migrated-window-attention`。[完整托管验证 37364141321](https://github.com/fenghengzhi/krkr2-web/actions/runs/37364141321) 首次唯一身份查询为 **pending／conclusion=null**。原始响应保存于 `out/verification/github-actions/37364141321/initial-run-discovery.json`，只确认提交及运行身份。本轮不再查询 jobs／artifacts，下轮补取 104 未报告范围及本批固定结果。交接文档通过 `[skip ci]` 单独提交，不是另一轮验证。

本地仅检查和编辑源码、操作 Git，以及下载、解包、核对和解析历史原件。没有本地运行测试、构建、类型检查、浏览器或可执行验证探针。整批推送后只记录一次运行身份，下轮取回结果，不实时监控。

## 本轮固定回收

103／`37355736416` 与 104／`37359511361` 各取一次 run、jobs、artifacts。**23 份原 ZIP、58,782,497 字节**全部匹配 API 大小和 SHA-256，十一份原包复用重核、十二份新取。总表为 `out/verification/github-actions/105-archive-summary.{json,md}`，历史失败与旧快照保留。

103 已终态 failure，20 jobs 为十成功、四失败、六跳过。构建保留两条 TS7022，应用 Node／浏览器等跳过；两处类型注解已在 104 修改。双 Windows 完整 343 光标库存的 strict 各 **1076/1076 matched、0 failure、5578 uncompared**，mask 各 **3770/3770**，portable 为 partial、已比较 **173/173**。未比较范围不算通过。

104 固定快照仍 in_progress，13 jobs 为九成功、一失败、三运行。构建及双光标未结束，没有对应 ZIP；**随机数及其余 Node、浏览器、兼容、直接 runtime 等应用结果未报告**，不再刷新。两轮原生池双 sanitizer 各六场景正常退出，身份诊断每后端六十条无失败记录，仍仅覆盖受控原生范围。

104 Win2022 beginMove 的 caption-left-up 在调用 SC_MOVE 前失败：中性鼠标消息已到达正确对象，坐标、焦点、capture、命中和按钮条件均满足，但 `GetMessageExtraInfo` 为 0，而不是所需标签 1263357782。因此没有注入左键按下，没有调用 SC_MOVE；超时和完整清理记录保留。其余六项及 Win2025 七项有观察结果。本批没有放宽门禁，也没有将输入前置失败算作窗口移动语义失败或成功。

## 消息属于实际原生 holder

固定 2.32stable 源包含 **138 个可注册 TVP holder、六个 CONST**。保留原 CP932 字节、许可证和 SHA-256 清单，并以机械转录生成原生日文默认表达式及 TypeScript ID 类型。Actions 在构建前检查原件和生成文件，即使命中内核缓存也执行；CMake 同时保留依赖检查。原编译日期／时间表达式保持。TS 不维护另一套翻译字典。

创建 TJS 后、运行脚本前初始化 holder，接入已有原生 mapper。`System.assignMessage` 直接更新这些 holder，CONST 继续不可赋值，未知 ID 不创建条目。不同 WASM Module 的消息隔离；Stop 后新建 Session 使用新模块默认值。消息库存包含原版插件相关名称，仅为保留原命名空间，不表示已实现插件。

格式化区分原来的零／一／二参数重载：零参数逐字返回，包含 `%%`、`%1`；有参数时仅扫描模板，处理 `%%`、`%1`、对应的 `%2`，插入参数不再扫描。先精确计数，再一次填充，使用既有 16 MiB 临时分配预算，避免原始重复占位符估算不足。不是整个堆的 16 MiB 限制。既有 JS→TJS 字符串传输在 NUL 截断，因此模板 `left:%1:right` 配 JS 参数 `A\0B` 得到 `left:A:right`；不改变传输语义。

## 异常携带 ID，到返回 TJS 时读取当前文本

引擎 `TvpError` 保存不可变 ID 和零至两个字符串参数。原 Web 诊断供没有 VM 的边界使用；实际运行时只识别该类，私有 Reply kind 10 把原参数交给原生格式化。没有通过英文子串推断消息类型，也不让脚本对象的 getter 或转换参与格式化。

三个输入错误入口统一处理：普通 host dispatch、嵌套返回、文本／二进制存储回调。消息在恢复原 TJS 栈时读取当前 holder。异步操作、真实 Array 流和写入预检都沿同一路径。末尾写入、弱对象通知等没有待恢复脚本栈时，通过纯格式化导出生成 `ScriptError` 并保留原 `TvpError` cause；主脚本错误和末尾写入错误并存时保留两者。若格式化自身超预算，聚合保留原描述和格式化失败，不能把后备文本当成成功。

纯格式化导出不接收 VM 指针、不执行脚本、不排空待释放句柄、不消费其他清理错误。暂停的 host 回调与销毁尾部可以安全读取模块仍持有的消息。公开已销毁 Runtime 仍拒绝调用。取消优先级和对象生命周期保持。

本批迁移有原调用点依据的分支：

| 消费者 | 原消息合同 |
| --- | --- |
| Scripts 查找、Array 文本／结构读取、UPDATE 预检 | 区分 CannotFindStorage 与 CannotOpenStorage，保留请求名 |
| Storage AutoPath、媒体名、归档写入、getLocalName | 原参数数量；UnsupportedMediaName 接收去冒号的小写媒体名 |
| fullscreen setter、Window 遮罩缺主 Layer、Menu.remove 非子项 | 对应零参数 holder，在变更之前拒绝 |
| Layer 主层移动／可见性／opacity、父层和排序 | 按原守卫及先后顺序返回对应消息 |
| 图层图像和 drawText | 区分目标不可绘制与源没有图像；保留 drawText 方法参数 |
| mask／province 尺寸 | mask 零参数，province 接收原文件名或已定位 companion 公共路径 |

同时补原版明确拒绝的 Layer 自己作为父层、自己作为排序相邻项、无兄弟排序及零宽／高图像请求。零尺寸失败具有原版的部分副作用：先收缩显示矩形及调整偏移，再拒绝改变图像；旧 bitmap、province、clip 保留，原显示面积仍需重绘。函数及 imageWidth／imageHeight setter 都保留这一顺序，不能把异常理解为全部回滚。相同图像尺寸仍是 no-op；内部空 Bitmap 用途不受该公共图层守卫影响。`assignImages` 仍允许复制无图状态，与绘制读取源图像不同。

原生流的两处遗留短读调用恢复为 `TJSReadError`，与固定原版一致；`TVPReadError` 是不同消息，不能替代。测试用实际截断 KBAD 数据验证 Array／Dictionary 的 serializer 路径。更多解码、文本加密、媒体和其他错误分支尚未迁移；Web 专有预算、取消、命名空间和不支持功能诊断也不按相似英文统一替换。完整注册库存不等于所有 TVP 消费者已完成。

## 菜单与异步 terminate

104 双 Windows 固定原版退出参考各有七个被动场景，以及一个**经过受控关闭菜单之后**结束的场景。Timer 调用 `System.terminate` 并返回后，菜单保持至少 505／508 ms；对已核验归属的菜单发送一次 WM_CANCELMODE 后，原版记录 modal-after 并以 0 退出。不是菜单自动退出的证据，103 的 C# setup 失败和更早超时仍保留。

据此 Web 的 pending terminate 不再自动取消菜单等待；真实菜单结果或用户关闭使外层 TJS 返回后，再执行退出。应用自己的模态循环仍按原取消规则处理，Stop／`System.exit` 的即时取消保留。新增测试必须先观察菜单持续打开，再由实际 dismiss／Escape 结束；另外验证 Stop 和迟到结果不能复活会话。

## 托管验证与后续

候选新增 **31 个常规 Node、每浏览器 10 个定义**：原生消息边界 17、实际消费者 10、菜单退出 4；浏览器消息 6、菜单退出 4。相同的 17 个原生消息定义另用同次构建的 JSPI 内核执行，保存独立 TAP、日志和崩溃诊断。浏览器覆盖实际 Worker、源码／字节码、Asyncify／JSPI、事件错误、Stop 重开和缺失／0／2 版本门禁。旧测试按实际 holder 更新为明确 sentinel 或原日文断言，保留状态、像素和资源归属检查。这些是待执行定义，不是通过数量。

下轮补取 104 构建、应用、双光标与终态，并回收本批固定结果。历史浏览器失败、构建后的真实应用回归、未迁移的消息消费者、更多媒体和字体／图形兼容、系统边界及更多真实游戏验收仍属于完整非插件目标。源码审计保存在 `out/verification/system-messages/105-audit.md`、`out/verification/tvp-messages/105-bridge-audit.md` 与 `out/verification/system-termination/105-menu-termination-audit.{json,md}`。

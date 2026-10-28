# 111 浏览器生命周期、窗口几何与真实图像夹具

状态：开发候选，等待 GitHub-hosted Actions。目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。本轮从干净的 `ae649dc` 继续；前一轮只有目标说明，归类为无新增进展，因此重新核对工作树并处理已有原件中的失败。协议 **42**、TJS ABI **5**、字体 ABI **2** 和能力版本保持。

本地仅做源码读改、Git，以及历史原件下载、解包、哈希核对和解析；没有运行测试、构建、类型检查、浏览器或候选探针。107–110 的 run、jobs、artifacts 端点各取一次并冻结，不实时刷新。整批推送后只记录一次新运行身份，下轮取回执行结果。

## 本轮固定证据

保留 **65 个原 ZIP、841,856,164 字节**，全部与固定 API 的大小和 SHA-256 相符；其中 33 个新增、32 个复核。另取回 11 份失败／取消作业原日志，复用 8 份已存原日志。索引为 `out/verification/github-actions/111-archive-summary.{json,md}`，各运行另存 `111-snapshot-summary`。端点独立取回，不能称为原子快照。

107／`40773899535`／`ff9a73ed0213b50f03b342d5cb4f3cbb44955629` 已 completed／failure，35 jobs 为 23 success、10 failure、2 cancelled。三个完整主浏览器 JSON 和两个取消分片的逐项原控制台，合计计划 **2775 项：2184 pass、117 fail、2 skip、472 未报告**。取消的 Firefox 第二分片只有 192 pass、18 fail，剩余 252 未报告；WebKit 第二分片只有 197 pass、45 fail，剩余 220 未报告。它们虽有原 trace ZIP，却无最终 `results.json`；不能用部分结果填成通过。

108／`40776092450`／`3e246bf771af3c2f84a1a4a94679449997a9016c` 仍 in_progress，34 jobs 为 22 success、7 failure、5 running。构建成功，常规 Node **3594 项：3532 pass、62 fail**；可信生命周期 17 pass／2 fail，Library 56 pass／1 fail，PWA 59 pass。兼容报告 90 pass、6 未报告；五个主浏览器作业尚无产物。Library 的失败在夹具启动等待 `zip-ready:42:0` 时发生，尚未执行元数据回滚断言，不能称为回滚产品缺陷。

109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba` 和 110／`40781763654`／`260cb0aae2ef649b62962618911bbb3fd6698383` 都是 pending、零 jobs／artifacts。它们的修复与新增定义仍未验证。保留此前全部失败、取消、skip、未比较及未报告记录；有界菜单诊断不能关闭历史堆崩溃根因。

## 页面生命周期

启动失败会退休 Player，但保留失败 snapshot 供查看诊断。旧 `update()` 无条件用该 snapshot 的 debug 状态覆盖页面状态，导致脚本曾隐藏的控制台／控制栏无法重新打开。现在仅在 Player 仍存在时同步引擎的 debug 状态；退休后由页面拥有面板。原错误文本、失败状态和禁用的 VM 控件保留。已有双后端测试增加实际可见性、展开状态、反复开关及 Worker 已退休的断言。

startup-policy 测试原先对失败启动点击已经禁用的 Stop，造成四个 120 秒超时。现在直接检查禁用 Stop、导入控件恢复、窗口和 Worker 已清除，仍保留失败状态。终止持久化测试改用应用的真实重新开始按钮，重载完全相同的资源。旧 helper 每次生成不同脚本 marker，改变游戏内容哈希，使第二次导入进入另一个存档命名空间；原存档、源／字节码和 posted terminate／immediate exit 的顺序检查保持。

显示配置测试补装其启动 helper 必需的 ResizeObserver 观察器。原 trace 的首因是 `systemDisplayObserverScope is not a function`，随后 finally 的空 cleanup 数组覆盖首因；现在启动和清理失败独立收集并保留首因，13 个非法配置、部分构造释放、全新有效 Player 和零资源泄漏的断言保持。

ResizeObserver 的后台几何请求只归属于捕获的页面 generation、Player 和 surface epoch。Stop 不再接纳新后台刷新，已退休请求的迟到拒绝不写入替代会话的日志；其他用户／脚本动作及仍存活的几何失败保持报告。新增四个源／字节码、Asyncify／JSPI 浏览器定义：真实 CSS 改变触发 ResizeObserver，实际 Worker 已执行的刷新 RAW 回复被明确扣留，然后 Stop 退休待应答 RPC；要求 Worker 清除、原回复身份匹配及无虚假的 disposed-client 日志。

107 嵌套对话框 JSPI/source 的主行为断言已通过，退出时出现 disposed-client 日志。原件不足以确认具体 RPC 来源，因此本批不宣称关闭该历史根因；为所有对话框场景附加被动 RPC 记录，保存未应答的方法、退休次数及记录丢弃数。既有无错误、焦点、选择区和模态清理断言不变。

## 后台几何事务

原 popup trace 在启动 ready marker 之前已记录 `Window geometry destination changed`，随后输入顺序检查通过。后台 ResizeObserver 请求等待测量时，真实脚本可能改变主 Layer 或菜单，使候选 signature 过期。现在用专用 stale 类型区分这一情况；每个后台请求等待旧事务结束后重新测量，最多尝试两次。两次均过期时不提交旧结果、不标记 signature 完成，下一脚本同步点或宿主通知继续取得最新几何。脚本 setter 的失败合同保持。

刷新不能仅按 Window ID 复用未完成的结果：新 surface 的请求可能先于旧测量回复到达 Worker，而旧回复无论成功还是失败都不能替代新 surface 的测量。现有串行语义保留，每次请求都取得当前宿主；新增重叠替换场景检查不同 epoch 的测量和提交。背景刷新与脚本同步点还共享滚动重置判定，避免后台抢先提交新主 Layer signature 后，脚本同步跳过本应发生的滚动归零。

本地 Window 退休使用 `WindowGeometryRetiredError`；只有窗口确已退休时，后台请求才将其作为生命周期结束处理。宿主返回相同文字的普通错误不能冒充该类型，存活窗口及窗口退休后的真实宿主拒绝仍保留原错误。类型只在本地 Port／Headless 对象使用，没有新增跨 MessagePort 字段，因此协议保持 42。

新增源／字节码集成覆盖非零滚动下的真实脚本尺寸改变、重叠 surface 替换、窗口退休、真实宿主错误、两次连续过期后的脚本同步，以及 Stop 清理；通道测试另检查宿主错误文字不能冒充本地退休。旧签名无提交权限，新的 paintBox 尺寸、版本和零所有权清理均有严格断言。

## 物理坐标与拖放证据

fonts／layer-cursor／multiwindow 的原 trace 显示：测试在真实画布事件后点击页面下方的表达式控制台，页面滚动并发出真实 mouseleave。原来读取的物理坐标因而已改变，字体测试中的 `90,1417`／`90,1428` 不是字体变换的证据。新读取 helper 仍提交应用实际表达式按钮，但用 `focus({preventScroll:true})` 和程序激活避免额外鼠标移动，并严格检查读取前后 scroll 与 canvas 矩形不变；该程序激活不算物理游戏输入证据。

另被动记录真实 canvas move／leave、可信标记和坐标。多窗口测试在真实 onClick 内保存原字面坐标，再独立核对离开后的最新物理点及整数投影；不会把 A 窗口离开时的新样本当成旧点击。custom-cursor-host 也按 move 和 leave 共用的序列发送新 marker，继续拒绝过期 revision／epoch。原坐标、像素和生命周期用例均保留，审计为 `out/verification/browser-regressions/111-coordinates.md`，原 22 个浏览器案例提取另存 JSON。

107 Chromium 的四个 file-drop 失败原件已经收到真实 Worker 的 accepted ACK，但脚本构造的 DataTransfer 仍返回 `dropEffect=none`。[固定 Blink 源码](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/core/clipboard/data_transfer.cc) 显示这种对象使用 copy/paste 模式，原生 setter 忽略 drag-drop effect 写入。因此仅为该测试对象观察应用实际请求的 copy／none 并委托原生 setter，保留原 getter 结果作为证据。真实 File 能力、顺序、只读字节、BMP 像素、懒归档和暂停／隐藏拒绝断言不变；没有把构造事件称为 OS 文件管理器拖放验证。

## 图像夹具迁移

108 的严格后缀／格式选择拒绝 `.bin` 图像和伪 PNG，旧测试因此到不了自造完整解码器的等待点。本批将省份加载、异步重绘、公平性及扩展名省略场景换为实际有效 PNG；通过生产 inflate 依赖显式挂起，再委托真实解压与 PNG 扫描线处理。省份索引仍是 7／19，旧主图／mask／clip、暂停／取消、迟到失败、句柄和 bitmap 所有权断言保留。

缺失资源改用原生消息 holder 的明确 sentinel，BMP 短读检查当前精确错误。真实 PNG 的成功迟到在扫描线处理处检查取消，因此 Stop 后该分支要求 `ExecutionCancelled` 类型；真实迟到解压失败要求原 Error 对象身份，不能用缓存 disposed 文本替换其根因。测试 helper 明确释放等待点并观察已启动操作，不放宽生产格式选择或添加伪格式回退。

本批直接迁移对应原 27 项失败的四个旧测试文件，新增图像定义为零。另 14 项 companion 失败保留 109 已有候选修复；其中两项是缩小显示尺寸后缺少一帧，不能笼统归为错误文案。109 的 LayerTree 新图尺寸钳制修复仍待执行，原 before+1 帧及像素检查没有改动。完整映射为 `out/verification/image-loading/111-fixture-migration.md`。

## 托管执行覆盖

新增 **17 常规 Node 定义、每浏览器 4 个定义**，其余为原用例迁移和更强的观察／清理检查。几何、页面生命周期和图像夹具经过独立静态复核；复核发现的滚动重置、surface 替换及测试清理问题均在提交前修订。所有候选尚无执行通过结论。

107 Firefox／WebKit 的第二分片均约在 45 分钟预算边界取消，原日志记录 `The operation was canceled`。本批把这两个浏览器的主套件各从两个分片改为四个独立 GitHub-hosted runner，保留单 worker、测试文件顺序、原断言时限和 45 分钟 job 预算，减少失败较多时尾部未执行的范围。没有删除失败用例或把中断改为通过，也不保证新分片一定全部结束。

## 未完成范围

新候选尚无执行通过结论。109 的异常处理上下文／失活整理和 110 的成品缓存仍待结果；新回收的 WebKit OPFS、菜单光标、Library 启动、取消分片中的视频／音频失败及原 KAG 诊断缺失仍需继续定位。图像部分目的地写入、JPEG 原版精确性、历史堆崩溃、完整非插件功能与真实游戏验收均未完成。

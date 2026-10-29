# 113 图像加载的部分写入与失败边界

状态：候选，等待 GitHub-hosted Actions。从干净的 `75e2d61` 继续；整体目标仍是完成插件以外的 KRKR2 Web 模拟器，未完成。本批补主图／遮罩解码失败之前已经发生的目的地写入，并区分解码、正常图像处理完成、伴随省份及最终更新四个阶段。协议 **42**、TJS ABI **5**、字体 ABI **2** 和已有能力版本保持。

本地只做源码读改、Git、历史原件下载与解析，没有执行测试、构建、类型检查、浏览器或候选探针。108–112 的 run、jobs、artifacts 各读一次后冻结；整批推送后只查询一次新运行身份，下轮回收，不实时监控。

## 本轮固定结果

保留 **64 个原 ZIP、832,292,225 字节**，其中 32 个新增、32 个复核，全部匹配固定 API 的 SHA-256 和大小。保留五份新增失败／取消作业日志及九份原日志。入口为 `out/verification/github-actions/113-archive-summary.{json,md}`；各 endpoint 的固定读取不是原子快照，未刷新状态，也未重查已终态 107。

108／`40776092450`／`3e246bf771af3c2f84a1a4a94679449997a9016c` 已终态 **failure**：35 jobs 为 22 success、11 failure、2 cancelled。主浏览器计划 **2787：2207 pass、138 fail、2 skip、440 未报告**。其中 Chromium 896 pass／33 fail，Firefox 第一分片 451 pass／15 fail／1 skip，WebKit 第一分片 448 pass／18 fail／1 skip；两取消分片只有部分控制台结果和 traces，不能计为完成通过。新取 TLG 三条失败仍保留，原 marker 与附加异常栈的读取问题尚未定位，不据此直接判定解码缺陷。

109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba` 固定时仍 **in_progress**：34 jobs 为 27 success、1 failure、6 running。构建通过，Node 完整 **3612：3585 pass、27 fail**。按精确标题逐项对照 108 的 62 个失败，**35 个在 109 已通过、27 个仍失败、零缺失／重名**；原对照为该运行目录的 `113-node-regression-comparison.json`。剩余是 province-loading 16、redraw-fairness 2、redraw 8、window-layers 1，均对应 111 已迁移但尚未执行的旧图像夹具，不能提前记作修复通过。

109 已报告可信生命周期 **19/19**，独立 JSPI TVP **17/17**、pool **8/8**、random **16/16**、factories **4/4**，Library 57 pass、PWA 59 pass、直接 runtime 6 pass；Chromium／Firefox 兼容各 **32/32**，包括两个内核的原 KAG 诊断。五个主浏览器作业与 WebKit 兼容没有报告。当前 Win2022 beginMove 成功只覆盖本次结果，不抹掉历史输入前置失败。

110／`40781763654`、111／`40785212878`、112／`40787500591` 均 **pending、零 jobs／artifacts**。其精确实现 SHA 分别为 `260cb0aae2ef649b62962618911bbb3fd6698383`、`de046be70c7a9517e9b9d35a0a8baaf8afcac1d1`、`22d09757467f30273546eed72255fa8f0d644f01`。112 关于 Library 的勘误保持：108 回滚断言通过，失败在重载后的第二次启动。历史失败、取消、skip、未报告、未比较及 heap 根因未闭合范围全部保留。

## 原版阶段与本次实现

固定原版 KRKR2 2.32stable 提交为 `dec49af97e174d31059c3ccd7efc700ba3c6b788`。已有 `GraphicsLoaderIntf.cpp`、`LayerBitmapImpl.cpp`、`LayerIntf.cpp`、`LoadTLG.cpp` 及匹配 libpng 源码支撑此次阶段对照。具体路径、行号和限制见 `out/verification/image-loading/113-native-partial.md` 与 `113-loader-partial.md`。源码审计不是原二进制执行结果。

原 size callback 的 `Recreate` 即使尺寸相同也重新分配主图。完成一行后才执行字面 RGB key 和横纵重复；mask 先核对尺寸，随后把已完成的灰度行绑定到主图 alpha。完整主图 handler 返回后才做自适应 key、发现省份名、读 mask、执行 matte，全部正常处理成功后才可进入成品缓存。

`Layer.LoadImages` 的主图调用在后续 try 块之前。主图或 mask 出错时，已经改变的 bitmap 尺寸和像素保留；显示尺寸、偏移、clip、旧 province 和 `imageModified` 不执行成功阶段更新，也没有最后的 `Update`。候选通过同步 size／row 通知传递这些已发生的写入；尚未写入的 Web 分配区明确置零，这是安全边界，不声称等同原生未初始化内存。

正常图像处理成功后，`InternalSetImageSize/ChangeImageSize` 在省份解码之前执行：收缩显示矩形及偏移、调整旧省份、重置 clip、设置 modified。省份失败再释放仍属于本次加载的省份，主图保留；最终成功才安装结果并请求最后更新。显示尺寸变化本身可能较早产生更新。旧 province 异步测试六个定义按这一原版边界修正，保留晚错误、目标更改和 Stop 的严格断言；它们在 109 的原断言通过不证明旧中间态符合原版。

Layer ticket 跟踪当前 bitmap、revision 和 province generation。外部像素写入、替换、尺寸变化或 Layer 退休会使旧加载失去目的地权限，后续行和失败清理不会覆盖新状态。图像专用暂停屏障在异步 I/O／inflate／host decode 恢复和缓存发布前等待；暂停允许私有 I/O 完成，恢复前不写入实时 Layer，Stop 继续取消。没有改变其他图形操作的全局调度。

## 格式与缓存边界

BMP 按原版最多八个文件顺序行整组读取，组不完整时不发布该组已存在的零散行，保留此前组；正高度图按 bottom-up 对应目的地行号。PNG 非交错图逐完成行发布，已识别的非 IDAT 尾部错误在这些行之后抛出；交错图必须完成像素和尾部校验，才复制任何目的地行。TLG5／6 按完整分量块／八行组处理后发布，SDS 尾部标签失败保留已经解码的原始图像。回调抛出的原错误对象单独穿透，不会误变换为 codec 的 TVP 错误。

每个活动 normal cache flight 只保留一张当前 partial RGBA，精确 key 的后加入者可重放当前行，无需重新读取；partial 从不等于成品命中。每个消费者收到独立行副本，单个目的地失败不破坏其他消费者的真实解码结果。clear／compact 保留实际活动负载及 pending 计数并撤销成品发布，dispose 立即退休消费者但保留原有迟到解码失败。即使退休发生在通知或重放回调内部，后续接收者和行也不再收到通知。

活动 partial 和保留成品共享 **64 MiB** 驻留负载限制，并保留独立的 64 个实际活动处理器上限。成功的 normal 输出使用 buffer ownership transfer：移动该 flight 自己的紧凑 buffer，detach 生产者旧视图，再转为成品归属，避免成功阶段同时持有两张 48 MiB bitmap。不同来源输出先退休 partial 再复制；外部调用者始终得到独立副本。该计数是 cache 持有的 payload／名称／metadata 等逻辑驻留负载，不是进程 RSS，也不把 codec 临时数据或调用者副本伪装成缓存条目。

## 验证定义与剩余工作

新增 **56 个常规 Node 定义**：codec 12、loader/cache/Layer 24、真实 source／bytecode 集成 20；另新增 **每浏览器 4 个定义**，覆盖 Asyncify／JSPI 与 source／bytecode。浏览器用例在失败后通过脚本显式 `Update`，严格比较实际提交 canvas 的完整像素；不假称失败自身请求绘制。现有省份测试只迁移六个异步定义，总数不增加。全部新定义待托管执行，源码交叉审查不算测试通过。

以下仍是明确缺口：整块 inflate 接口不能提供 zlib 失败前的可信行前缀，IDAT CRC／压缩消费时机尚非完整 libpng 流式等价；host JPEG 失败没有原生 header／scanline 进度及完整数值诊断；ERI 仍明确不支持；部分原生短读消息和畸形输入细节未对齐。当前工作不等于所有图片格式完全兼容。

下一批先取回本批与前面未完成运行的固定结果，按真实失败继续修订；视频 readback、菜单 marker、OPFS、历史 heap、其余非插件接口与真实游戏验收仍未完成。整体验收目标保持 active，不因单批提交或排队而结束。

## 推送与交接

候选提交 `2f38ee94b686cbfa487f6137ea44d026af53cd16` 共 **21 个文件**，已推送到 `codex/migrated-window-attention`。[Full test suite 40791060043](https://github.com/fenghengzhi/krkr2-web/actions/runs/40791060043) 首次唯一查询为 **pending／conclusion=null**，精确 head SHA、push 事件、workflow 路径及 attempt 1 匹配。原响应保存在 `out/verification/github-actions/40791060043/initial-run-discovery.json`。本批不再查询其 jobs、日志或产物；下批补取 109 未报告范围及 110–113 结果，已终态 108 不需要刷新。完整目标继续 active。

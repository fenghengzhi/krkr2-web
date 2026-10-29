# 115 PNG pull 解压与原始写入阶段

状态：候选，等待 GitHub-hosted Actions。上一轮 114 已实际提交推送，本轮从干净的 `99f3c24` 继续，整体目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。本批接入实际应用的 PNG 逐行解压、IDAT 消费时点和原始写入／行完成分离，并扩展同源原生差分。协议 **42**、TJS ABI **5**、字体 ABI **2** 保持；独立图像 zlib 模块 ABI 为 **1**。

本地只做源码读改、Git、原件与参考源码下载／哈希／解析；没有执行测试、构建、类型检查、浏览器或候选探针。109–114 的 run、jobs、artifacts 分别各读一次后冻结，已终态 107／108 不再查询。整批推送只取一次新身份，下批回收，不实时监控。

## 固定回收与实际进展

保留 **65 个原 ZIP、879,147,392 字节**，其中三十二个新增、三十三个复核，全部匹配 API SHA-256 和大小；五份新作业日志与四份旧日志保留。入口为 `out/verification/github-actions/115-archive-summary.{json,md}`，不同 endpoint 不是原子快照。

109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba` 已终态 **failure**，35 jobs 为 28 success、5 failure、2 cancelled。主浏览器计划 **2811：2245 pass、136 fail、2 skip、428 未报告**。两个取消分片仅有控制台结果和 traces：Firefox 第二分片 195 pass／19 fail／252 未报告，WebKit 第二分片 234 pass／56 fail／176 未报告。三浏览器原 KAG 兼容 96/96 等已有结果继续保留，不覆盖这些失败和缺失。

110／`40781763654`／`260cb0aae2ef649b62962618911bbb3fd6698383` 固定时 **in_progress**，34 jobs 为 27 success、2 failure、5 running；build success，Node **3664：3637 pass、27 fail**。独立连续事件流 12496 条且 sourceEnded=true，逐定义证实新增成品缓存 **52 项全部通过**：processed-image-cache 15、processed-image-loading 19、集成 processed-image-cache 18。精确事件证据在该运行的 `115-processed-cache-definitions.json`。TAP 标题新增 56／消失 4 包含旧用例改名，不能误报为 56 个新定义。

剩余 Node 失败仍是 province-loading 16、redraw-fairness 2、redraw 8、window-layers 1；其 111 迁移尚未执行。本批随着实际解码依赖更换继续迁移这些等待入口，不减少原断言。110 JSPI TVP 17/17、pool 8/8、Random 16/16、factories 4/4 通过。可信生命周期为 **18 pass／1 fail**：原附件证明错误是启动 ready 之前的 `Window geometry destination changed`，后续恢复和 F8 回调已发生；不能把搜索命中的 disposed-RPC 断言参数当成真实日志。原件位于 `115-trusted-decoded/`，本批没有据猜测改几何实现。

111／`40785212878`、112／`40787500591`、113／`40791060043`、114／`40794100263` 都仍 **pending、零 jobs／artifacts**；114 原生 PNG 参考没有运行结果。历史 failure、cancelled、skip、未报告、未比较、Library 勘误及 heap 根因未闭合范围继续保留。

## 独立、受控的 PNG 解压内核

新增独立 WASM zlib 模块，不混入 TJS 或 FreeType 的 ABI／生命周期。固定 Emscripten **6.0.9**、zlib **1.3.2** 的版本和源归档 SHA-512，构建清单保留 port、所有实际 C／头文件、内核源码和产物 hash。原生参考使用同一归档的 C 源；原生与 Emscripten 的 zconf.h 配置差异分别记录。它是可复现的同源对照，不声称确认原 `deelibpng.lib` 所链接 zlib 的二进制身份。

每次同步 step 固定 `Z_PARTIAL_FLUSH`，显式返回已消费输入、已产生输出、状态及真正的 `z_stream.msg`。失败也可能产生私有输出，调用者必须按原 libpng 时点决定是否写入图像，不能把“已有输出”当作完成一行。每流输入窗口最多 8192 字节，输出最多 32769 字节；每 Session 最多 64 个流，zlib 分配有每流 128 KiB／合计 8 MiB 硬限额，WASM 线性内存上限 64 MiB。共享临时输入／输出窗口不会为每流复制，内存增长后重取 HEAP 视图，输出不会泄露原生别名。

实际 App 和 headless Session 都持有自己的延迟加载 provider。并发首次加载共享初始化；初始化真实失败不成为永久失败缓存，后续可重试。暂停在恢复执行／发布前等待，Stop 关闭已拥有流，迟到模块或流不会重新进入会话；原失败与清理错误分别保留。ZIP／文本和通用图片的原完整缓冲依赖不被改成这条图像专用路径。

独立产物加入生产 Vite、离线清单／哈希检查、许可证、内核缓存和精确 build artifact；四个单独编译 Session Worker 的 embedding 夹具也加入真实生成 manifest 的常量。完整 App 的 selected PNG 使用新 provider；未提供 provider 的旧自定义 embedding 保留已有完整缓冲入口，不能据此声称其具有本批流式行为。

## 读取、写入与完成

新的准备阶段在首个完整 IDAT header 停止并调用 size，不先拼接全部 IDAT 或检查它们的 CRC。解码按原 8192 字节输入窗口消费，只有旧输入耗尽且当前 IDAT 没有剩余字节时，才检查该块 CRC 并要求下个 IDAT。零长度块也保留 CRC 和协作式取消检查。每行只保存当前过滤输入和上行，不再先分配整张 16 位展开缓冲；编码源目前仍由已有 `Resource.read()` 完整读入，受原单资源限额约束，不宣称存储 I/O 已流式化。

普通 PNG 行先过滤、转换并写入 caller，之后 `png_read_finish_row` 可能读取压缩尾部并失败，最后才到 scanline 完成通知。新增可选 `write` 通知描述已发生的原始写入，既有 `row` 继续表示完成。主图原始写入只覆盖 source 行，未完成时不执行颜色 key 或横纵重复；mask 的原始写入属于临时行，只有完成才绑定 alpha。当前 partial bitmap 仍能向精确 key 的后来读者重放实际已有内容，失败结果不进入成品缓存。

最后一行的额外字节检查、剩余压缩数据、zlib 原原因与 IDAT CRC 都按对应阶段处理。Adam7 先完整解码到私有图像，压缩结束和 read-end 成功后才逐行发布。原版未知 filter 只警告并将行的首样本字节置零，新流式路径按此处理；旧真实消费者不再把它误断为解码失败。已有 size／clip／province／modified／Update、目的地 revision、暂停和 Stop 的保护保持，通用 PNG 入口原语义保留。

## 托管验收定义

新增 **17 个常规 Node 定义**：11 个实际 WASM 内核／provider 定义、2 个 pull decoder 定义、4 个真实 source／bytecode 消费者定义；新增 **每浏览器 4 个定义**。完整 PNG corpus 按八字节 signature 选取 **102 个原始输入**，明确覆盖全部原 depth／color type／Adam7 组合并比较独立 RGBA 与完成行；其它定义覆盖真实堆增长、字典／错误／OOM 状态、隔离和退休、三阶段 consumer 错误身份与流关闭。

消费者使用独立 stored-DEFLATE 行块和分离 Adler IDAT：前块 CRC 在最后 raw row 后失败，主图保留未 key 的末行，而 mask 不绑定未完成末行。成功控制检查完整画布、缓存命中不再 open、独立目的地以及失败重读。旧异步夹具转为持有已打开的真实 WASM 流，Stop 即时 close，迟到错误仍保留原对象；不制造展开字节或绕过 handler。

独立 C 参考保留原 47 个输入，新增 **30 个流式输入，其中 9 个有效控制**，总计 **77**。目标以 0xa5 sentinel 初始化，逐次记录原始目标、完成行快照、错误阶段、每次读取及实际短读，Adam7 staging 与最终目标分开。两处已知原库临时块泄漏和六个 palette-key 调查继续单列，不把不安全或未比较结果算作干净成功。

新的 `png-stream-comparison` 作业依赖同次 build 和原生参考产物，核对精确提交、输入 hash、同源 zlib 清单后，让真实 WASM／生产 parser 对 **30 项逐项必比**：完整 sentinel 目标、每次完成行快照、完成数、精确 codec 原因或结构化短读、阶段及零资源遗留。缺失、基础参考失败、未比较或任一差异均使总门禁失败。逐 warning 序列和全部逐 read 序列没有声称逐项等价；它们仍作为原件保留。mask 临时行与手工 palette-gray 不属于这组 C normal-main 对照，实际 mask 消费者另验。

所有新定义和差分均尚未执行；源码交叉审查不算通过。原件及设计分别见 `out/verification/image-loading/115-zlib-kernel-audit.md`、`115-native-stream-reference.md`、`115-stream-consumer.md`。

## 后续仍需完成

下批先回收本批与此前未完成运行的固定结果，修订真实差异。原 `deelibpng` 二进制身份、palette key／palette+tRNS 灰度的特殊行为、部分头部／ancillary 非法输入和 TJSReadError 消息映射、JPEG 原生失败进度、ERI、统一会话内存预留、历史几何／媒体／菜单／heap 回归及真实游戏验收仍未闭合。整体验收目标保持 active，不以这 30 项差分替代完整非插件范围。

## 推送与交接

实现提交 `5784993da5a6e5d48fc0e7cd92ad133ddab57930` 共 **47 个文件**，已推送到 `codex/migrated-window-attention`。[Full test suite 40798634885](https://github.com/fenghengzhi/krkr2-web/actions/runs/40798634885) 首次唯一查询为 **pending／conclusion=null**，精确 head SHA、push、workflow 路径及 attempt 1 匹配。原响应保存在 `out/verification/github-actions/40798634885/initial-run-discovery.json`。不再查询其 jobs、日志或产物；下一批固定回收110尚未报告范围及111–115结果，已终态109不再刷新。完整目标继续active。

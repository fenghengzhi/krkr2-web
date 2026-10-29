# 117 PNG 调色板行为与托管运行时对照

状态：候选，等待 GitHub-hosted Actions。从干净的 `96232b4` 继续，上一轮116已实现并推送，属于实质进展。整体目标仍是完成插件以外的 KRKR2 Web 模拟器；本批不是完整兼容性验收。协议 **42**、TJS ABI **5**、`nativeMessages:2`、字体 ABI **2**、图像内核 ABI **1** 保持。

所有测试、构建、类型检查、浏览器与可执行探针仅在 GitHub-hosted runners。此次本地只读改源码、Git、下载／核对／解析历史原件；111–116 的 run、jobs、artifacts 各固定读取一次后冻结。整批推送后只取一次初始运行身份，下次再回收，不实时监控。

## 固定回收与两个不同的崩溃

保存 **62 个原 ZIP、712,209,187 字节**，29 个新增、33 个复核，API SHA-256／大小全部匹配；十份新失败日志和三份旧日志保留。汇总为 `out/verification/github-actions/117-archive-summary.{json,md}`。

111／`40785212878` 已终态 **failure**，39 jobs 为28 success／11 failure。九份主浏览器报告全部到齐：**2835：2724 pass、109 fail、2 skip、0 未报告**。原 Node 为3681实际定义中3673 pass／8未报告，另有失败文件容器；原1.32GB WASM JIT SIGTRAP core继续保留。

112／`40787500591` 新发生 **malloc SIGABRT**：`window-main-window.test.ts` 子进程7607，原回溯为 `corrupted size vs. prev_size` → `unlink_chunk` → `_int_malloc(40)` → `operator new` → `node::RegisterDestroyHook`。完整 core **1,339,576,320 字节**，SHA-256 `c49a55f74ee2b665b9a089254150bd52bd2ecf211dad1f9a3beb00ac81f90dc3`，与托管摘要一致。该次崩溃属于另一种原生堆失败，不能与111的ThreadIsolation断言混为同一根因。

112独立journal注册3681实际定义：**3667 pass、14未报告、0已报告断言失败**，另有一个失败文件容器。111八个未报告activity定义在112均有明确pass，但这不能消除先前SIGTRAP。112 build和可信生命周期19/19成功，主浏览器尚无结果。run端点为queued/null，而同轮jobs已有18 success、2 failure、16 in_progress、2 queued；保留非原子快照差异，不将queued误解成从未执行。Win2022的受控beginMove输入前置失败独立保留。

113–116仍pending、零jobs／artifacts；114／115的原生PNG参考与差分尚未执行，没有据此宣称调色板结论已经验证。原失败、取消、skip、未报告、未比较和Library勘误继续保留。

## 按原版处理调色板字节

原 `TVPInternalLoadGraphic` 把 `clPalIdx` 的低八位交给handler，PNG并没有随后通用的索引透明化。新增内部 `selection.paletteKey` 传递这个值，PNG完成行保留handler输出，其他格式原处理保持。原libpng 1.0.6的 `png_set_tRNS` 只更改info结构，不同步reader状态；有文件tRNS时仍使用原文件alpha，key 0／1／255均不能替代它。成品缓存仍按完整原请求key分别计项，命中结果拥有独立目的地。

没有文件tRNS而指定索引键时，原分支实际将 **3W BGR字节写入4W目标行**。候选复现已定义的前缀并转成引擎RGBA传输格式；尾W使用既有Web新位图零初始化政策。原尾字节未初始化，不能声称这些零与原版相等。非交错的原始前缀在finish-row检查之前可见；Adam7等待全部解码及read-end成功后才复制完整行。

原palette grayscale先展开为BGR或BGRA临时行，再由 `TVPBLConvert24BitTo8Bit` 按连续三个字节读取前3W字节。带tRNS时，后续组包含前一个像素的alpha和错位色彩，并非每像素独立加权。候选按实际字节步长转换，使用逆序写入避免覆盖还未消费的源字节；不增加整图临时副本。只有read-row成功后才转换和发布灰度，失败的末行不能绑定mask；Adam7在read-end之后转换。规则图、mask、cache及实际Layer／canvas均走这条路径，通用PNG API保留标准语义。

## 独立参考与应用验收

固定C参考保留原47项及30项流式合同，新增 **30项调色板输入，20个有效控制**，总计 **107**。使用固定原 `tvpgl.c` 的哈希和精确函数片段执行手工灰度转换；不是拿产品转换函数充当参考。原六项palette调查和两个原库临时块泄漏合同不改变分类。

新对照中20项具有完整定义输出，另10项只比较各行已定义3W前缀，明确排除未初始化尾W；Web零尾另行断言。严格比较最终目标（含失败前raw写入）、每次已完成行快照、完成数、精确错误阶段／原因和清理结果。逐read／raw-write事件仍保存，但不声称全部事件一一对齐。已知损坏Adler／critical CRC的十个非控制输入必须报告错误，不能把双边意外接受算作通过。缺项、未比较、基础参考失败和任一差异均使门禁失败。

新增 **15个常规Node定义**：7个实际PNG内核／解码／规则消费者定义、8个source／bytecode真实Session定义；新增 **每浏览器4个定义**，覆盖Asyncify／JSPI与source／bytecode。应用定义检查真实RGBA、mask灰度、独立缓存目的地、失败重读与不缓存、部分写入和Stop后的资源清零。浏览器用两个真实Layer分别显示加载RGB和实际mask字节，以完整canvas读回核对透明RGB，避免合成舍入遮掉数据。旧索引键和palette灰度夹具按已核源合同修订，未放宽像素比较。

## 崩溃对照与已定位浏览器回归

新增独立activity诊断，固定111的commit、锁文件、15个原定义和原test-build归档。源码、Node24.19.0二进制、生成模块／WASM与build-info逐哈希核对，不能混用117新runtime。两臂分别为默认设置与同一二进制的 `--no-wasm-code-gc`，先记录实际托管V8选项；不支持或身份不符即失败，不静默跳过。每臂预先计划16个新进程、240项既有定义观察，合计480，零新增常规测试定义。两臂使用相同的被动进程观察import和显式无秘密环境；这与111完整套件调度不同，已明确记录。

每次有60秒期限、5秒清理宽限、16MiB日志预算、实际进程组身份与清理确认；原始core单独完整保存90天，磁盘保留不足时停止后续尝试并计未报告，不删除先前证据。注册、dequeue、完成、断言失败、文件容器、trap与未报告分别计数。即使某臂全部通过也只是有界观察，不是根因闭合；主Node版本、主套件命令和旧malloc诊断保持。精确历史构建依赖若失效会明确失败，不能自动换“最新成功”构建。

111两个system-lifecycle浏览器失败的trace确认第一次Stop后又点击一次，随后按钮已禁用。该场景改为请求一次Stop再等待原退出条件，Worker、挂起reply、错误日志和清理断言都保留。另一个音轨切换失败的原暂停时钟差在十进制上为1µs，JS差值略超原阈值；trace没有setter参数，不能据此断言浏览器量化机制。实现保留原始DOM秒数直接传给新元素，避免秒→毫秒→秒损失一ULP；新增被动setter实参证据，原1µs门槛、完整图像比较与回滚合同保持。这些是候选修复，尚无新执行结论。

## 后续

下一批先回收112尚未报告范围及113–117结果；已终态111不再刷新。两类Node原生崩溃、未解决浏览器回归、PNG其他ancillary／低位灰度边界与原二进制身份、JPEG原生失败进度、ERI、统一内存预算和真实游戏验收仍需完成。完整非插件目标保持active。

## 推送与交接

实现提交 `32a1945fc88b0acccf3aab90ab7f1d7e9548d0fd` 共 **31个文件**，已推送到 `codex/migrated-window-attention`。[Full test suite 40805119639](https://github.com/fenghengzhi/krkr2-web/actions/runs/40805119639) 首次唯一查询为 **pending／conclusion=null**，精确SHA、push、workflow路径及attempt 1匹配。原响应保存在 `out/verification/github-actions/40805119639/initial-run-discovery.json`。不再查询新运行jobs、日志或产物，下批固定回收112未报告范围及113–117结果，完整目标保持active。

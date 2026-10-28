# 107 消息表构建修复与验证证据保全

状态：开发候选，尚待 GitHub-hosted Actions 验证。从干净的 `94b2c1a` 继续。106 已提交实际代码、回归和交接，属于有进展的一轮；本轮取回结果后发现应用验证仍被阻断。整体目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成，不能把本批构建修复或有限诊断替代整个目标。协议 **41**、TJS ABI **5**、字体 ABI **2** 及已有能力版本保持。

本地只做源码检查／编辑、Git 操作和历史原件下载、解包、校验、解析。没有执行测试、编译器、生成器验证、浏览器或候选探针。每个历史 run／jobs／artifacts 端点本轮各取一次，不刷新；整批推送后只取一次新运行身份，下轮回收结果。

## 三批最终结果与缺失范围

104／`37359511361`、105／`37364141321`、106／`37368014184` 均已终态 failure，提交身份吻合。104 的 33 jobs 为 **22 success、8 failure、3 cancelled**；105 的 20 jobs 为 **8 success、4 failure、2 cancelled、6 skipped**；106 的 20 jobs 为 **6 success、2 failure、6 cancelled、6 skipped**。

当前固定清单 **20 份 ZIP、130,843,361 字节**全部匹配 API 大小和 SHA-256，十二份新下载、八份复用。另二十二份 104 历史 ZIP 按之前的 API 清单重新核对，**308,178,502 字节**保持；合计保留 **42 份原 ZIP、439,021,863 字节**。总表为 `out/verification/github-actions/107-archive-summary.{json,md}`。当前未列出的原件不能因新的清单没有它们就从本地删除。

105／106 的主 build 均取消，job 没有报告步骤或分配到的 runner，日志请求各一次返回 404 BlobNotFound。不能声称普通 WASM 构建或 TypeScript 检查执行到哪个阶段。Node、浏览器、直接 runtime、兼容、可信生命周期和 heap 诊断均 skipped。两个运行的**独立 JSPI identity 编译**则有完整原日志，均明确报告本批修复的 C++ 语法错误；identity sweep 自身未执行。

104 原 Node 独立事件流保持 **3308 passed、157 failed、21 未报告**，只表示该流的已排队 child 库存；有序 TAP 仍是部分输出。补回三个浏览器 job 的文本日志：WebKit 第一分片 **430 pass／24 fail／1 skip**；WebKit 第二分片在取消前 **263 pass／74 fail／115 未报告**；Firefox 第二分片在取消前 **182 pass／22 fail／248 未报告**。连同已有两份完整报告，五个主浏览器 job 的 2721 项计划库存为 **2154 pass、202 fail、2 skip、363 未报告**。这三个 job 的原 ZIP 已不在当前清单，本地也没有其 trace 原件；恢复文本不等于恢复原 JSON、截图或 trace。

五份可取得的 Windows cursor 原包各有 343 个输入，固定 strict 范围各 **1076/1076 matched、5578 uncompared**，mask **3770/3770**，portable **173/173** 仍为 partial。106 Win2025 cursor 取消、无原件，不推断其通过。可取得的原版退出报告仍是七个被动场景与一个受控关闭菜单后结束的场景；不是菜单自行退出或 Web 等价证明。其他仅有 job conclusion、没有 case 原件的参考作业不补造场景成功数量。

## 修复确定的消息表编译错误

独立 105／106 JSPI 编译日志都在 `TvpMessages.generated.inc:7` 报 `unterminated function-like macro invocation`。首项 TVPAboutString 的原表达式末尾有 `//` 注释；生成器对 body 做 strip 后直接追加 `)`，于是宏右括号进入了注释。现有 `--check` 只能证明生成器与已提交输出一致，二者恰好一致地生成了非法 C++。

统一的 `render_native_entry` 现在在 body 后先输出换行，再输出右括号。全部 144 项按同一规则机械同步，不改原字面量、注释、CP932 原件、来源哈希或 TypeScript ID 清单；仍为 138 个可注册 holder 和六个 CONST。

新增四项托管预检：原件及两个输出的精确一致性、带末尾行注释的多行字面量、实际完整 catalog 的 C++20 compile-only 检查，以及旧版同一行右括号必须编译失败的负控。实际 catalog 使用真实 `tjsTypes.h`／TJS_W，并有条目数量和独立日文字面量断言。每次编译子进程上限三十秒。

主 build 在恢复／构建内核前运行这些检查，命中缓存也不跳过。CMake 的 catalog 前置依赖也加入同一实际 translation unit 的 compile-only 检查，覆盖独立 allocator／identity 构建。它们不链接或执行引擎，不能代替后面的真实 WASM、Node、浏览器和游戏验收。源码审计在 `out/verification/system-messages/107-generation-audit.md`。

## 批次排队与产物保存

原 workflow 只有 `cancel-in-progress: false`，这会保留正在执行的运行，却仍使用默认的单个 pending 槽位。按 GitHub 当前正式支持的配置，本批增加 `queue: max`，保留多个等待批次，继续逐批运行；没有主动取消或重跑任何历史运行。这是防止未来 pending 被替换的配置修订，**不是对 105／106 具体取消原因的追认**。[GitHub 并发队列说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[正式发布记录](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/)。

仓库 workflow 中原十四／三十天的产物保留期统一改为九十天，已有九十天配置保持。这样以后隔较长时间回收时仍有更大的窗口；该修改不恢复已经缺失的原件，也不改变旧运行结论。GitHub 支持在 upload-artifact 中设置保留期，仍受仓库／组织限制。[GitHub 产物保留说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)。本地已有原 ZIP、失败日志和固定摘要全部保留。

## 菜单堆崩溃的有界追查

104 menu-modal 第四个普通取消定义开始后发生 SIGABRT。原回溯在 `node::RegisterDestroyHook` 的分配中检测到 glibc heap 损坏，不能由检测位置确定此前的写坏来源。原始 core 字节没有发布，当前静态检查也没有证实新的重复释放路径，因此没有推测性修改产品或放宽清理为零的断言。

新增独立 reusable workflow，以同次构建和精确 Node 24.19.0 跑原 menu-modal 文件：default／liftoff-only 两模式各固定三次独立进程，每次完整二十四个定义，合计最多 144 个有界观察。原用例的六十秒上限保持，单次进程另有总时限；诊断记录每定义注册、开始、通过／失败、异常和真实进程参数，并为普通取消路径增加仅诊断时启用的操作边界。

超时或退出后清理本次拥有的进程组，记录未完整退出的情况；任意一次失败、缺失、超时、异常 core 或清理不完整均使诊断 gate 失败，不做重试到绿。保存每次完整 stdout／stderr、记录、精确 Node／内核 SHA、运行来源，以及完整原 core、SHA 和 backtrace。该 job 加入 All tests，原完整 Node 文件和测试仍照常运行。即使有限重复均正常，也不证明历史 heap 损坏根因已解决。

## 原版图像合同的后续范围

本轮只读核对了完整图像加载链，未改图像产品行为。原版无后缀补全优先顺序是 `.tlg6,.tlg5,.tlg,.eri,.png,.jif,.jpg,.jpeg,.dib,.bmp`，不会先读裸文件；显式后缀先选择 handler。格式、normal／grayscale／palettized 模式、伴随资源、缓存与 transition rule 错误转换必须一起处理，不能只换一条 missing 错误文本。当前 sniff、部分 TLG rule 行为、ERI、TJS 短读及其他 decoder 错误仍有差异。

固定源及哈希、六类缺口、文件/API 方案和旧夹具迁移清单保存于 `out/verification/image-loading/107-image-handler-audit.md`、`107-image-handler-gaps.json` 和 `107-source/manifest.json`。它们是后续工作的依据，不是已实现或已验证清单。

本批没有新增普通 Node／浏览器测试定义；新增四个早期生成／编译预检，以及原二十四个菜单定义的独立有界重复诊断。全部仍待托管执行。下轮回收本批结果，继续处理应用回归、未闭合的崩溃、图像合同、其他非插件缺口和真实游戏验收；整体目标保持 active。

## 推送与下一轮交接

实现提交 `ff9a73ed0213b50f03b342d5cb4f3cbb44955629` 共 32 个文件，已推送到 `codex/migrated-window-attention`。[Full test suite 40773899535](https://github.com/fenghengzhi/krkr2-web/actions/runs/40773899535) 的首次唯一发现为 **queued／conclusion=null**，精确 head SHA 与 push 事件吻合，attempt 1。原响应保存在 `out/verification/github-actions/40773899535/initial-run-discovery.json`。此后不取 jobs、不轮询日志或 artifacts；下轮再回收固定结果。静态审查与 Git 差异检查不能计为托管执行通过，本批所有执行结论仍未报告。

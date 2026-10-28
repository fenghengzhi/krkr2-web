# 110 成品图像缓存

状态：开发候选，尚待 GitHub-hosted Actions。109 的实际实现及交接已推送，上一轮属于有进展的一轮；本轮从干净的 `2098b33` 继续。目标仍为完成插件以外的 KRKR2 Web 模拟器，尚未完成。本批实现 109 已完成源码审计的成品缓存合同，协议升至 **42**，新增缓存驻留负载统计；TJS ABI **5**、字体 ABI **2**、`nativeSystem:6` 和其他能力版本保持。

本地只做源码读改、Git 操作和历史原件下载／解包／校验／解析，没有执行测试、构建、类型检查、浏览器或候选探针。107／108／109 的每个 run、jobs、artifacts 端点本轮各取一次，冻结后不刷新；整批推送后只取一次新运行身份，下轮回收。

## 固定结果与未报告范围

107／`40773899535`／`ff9a73ed0213b50f03b342d5cb4f3cbb44955629` 仍 in_progress，34 jobs 为 23 success、8 failure、3 running。本轮新增 Chromium 主报告 **896 pass／29 fail**，Firefox 主第一分片 **451 pass／11 fail／1 skip**；合计仅这两份完整报告的 **1347 pass、40 fail、1 skip／1388**，另三个主浏览器作业仍未报告。Firefox 的 skip 是旧文件系统能力分支，不计通过。之前完整 Node 3520 pass／29 fail、可信生命周期及兼容缺失记录保持。

两份新 browser ZIP 和三十份旧包重新核对，合计 **32 原 ZIP、379,883,100 字节**全部与 API 大小／SHA-256 相符；两份新失败 job 日志保存，六份已存原日志复用，旧快照不删除。总表为 `out/verification/github-actions/110-archive-summary.{json,md}`。四十项失败和一项 skip 的原附件／trace 已解码并索引于 `40773899535/110-browser-decoded/index.json`。

共同失败涉及字体坐标、多个窗口的输入坐标、图层光标及 custom cursor；Chromium 还报告 lifecycle、termination、drop effect、System events、popup 与部分清理错误。原件显示字体坐标预期 `90,60`，实际为 `90,1417` 或 `90,1428`，不能把实际值缺失与不同值混同；两项 popup 原错误为 `Window geometry destination changed`。107 的 System events 仍观测 `caught,goodCalls=0,1`，109 修复尚无执行结论，不能先改写历史结果。

108／`40776092450`／`3e246bf771af3c2f84a1a4a94679449997a9016c` 与 109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba` 均 pending、零 jobs／artifacts，不能推断其构建、修复或新增测试已通过。本轮不根据旧 107 的失败另行改动未经证实的浏览器行为；原件用于后续回归处理。

## 原版五元 key 与成品存储

依据固定 KRKR2 2.32stable `dec49af97e174d31059c3ccd7efc700ba3c6b788`，缓存 key 是规范化请求、color key 的 32 位位型、mode、期望宽和高。先规范化并查缓存，只有 miss 才做后缀推断、存储查询、资源打开、解码与伴随图发现。不同请求别名、color key 或请求尺寸独立，即使最后找到同一个资源或产生相同实际尺寸。

生产 ImageLoader 改用独立 ProcessedImageCache，移除生产路径中的 raw-source retention。旧 ImageCache 仅保留其独立单测 API 和无状态尺寸校验，不能形成第二层成品／源数据缓存。normal entry 存已经过 key、mask、matte 的 RGBA、metadata 和发现的 province 名，不保留源 palette indices 或独立 mask entry；grayscale／palettized entry 真正只存一字节平面。返回数组和 metadata 都隔离复制，调用者不能污染下次命中。

图像按每一轴 `max(source, desired)` 平铺扩展，绝不为了满足省份尺寸而裁剪较大源。普通图成功后立即缓存，再由 Layer 加载省份；省份失败不会丢掉已成功主图。省份解码／平铺成功后也先缓存，较大源造成的外层尺寸拒绝不把它变为 decoder 失败。原 completed-main partial 错误及目标变更／Stop 检查保留。

universal rule 通过 SceneTransitions 和 Session 传入实际源图宽高，用原 key `0x02ffffff` 和 grayscale 模式缓存。规则 RGBA 仅为消费者临时展开，缓存保持 packed 8-bit；自动及直接省份使用 key 0、当前主图尺寸，保留各自原诊断名称。

## 预加载、限额与生命周期

TouchImages 对每个成功结果累计 `width*height*4`，包括重复命中；mask、metadata 和省份像素不另计为预加载成品字节，失败项不累计。预算／timeout 只在下一项开始前判断，当前整图处理完成。最后反向触碰已尝试的原列表前缀，包括重复和失败项，只改变仍在缓存中的条目顺序，不做 I/O、预先保护或复活已经淘汰的条目。

软限额按原版在插入新图之前整理旧总量，因此最多可超过配置值一个最后插入图，hit 不触发整理，修改限额则立即整理。另保留独立 Web 硬边界：64 MiB 驻留负载、4096 entries、64 个实际未结束 processor、既有图片尺寸及 codec 限制。即使 clear 撤销了 flight 的查找槽，实际未结束操作仍占 pending 名额，不能反复 clear 绕过并发限制。不能容纳的单项仍可返回调用者，但不留在缓存。

`imageCacheBytes` 现在表示原版成品像素账：normal 每像素四字节，其他模式一字节。新增 `imageCacheResidentBytes` 另计本缓存拥有的平面、UTF-16 名称／metadata／key／依赖以及引用账面负载；它不宣称是 V8 Map 开销、完整 VM heap 或 RSS 的精确测量。硬边界和 native 软限额是两个不同机制。

clear、namespace change、内容写入撤销旧 flight 的发布，旧 finally 不能删除新 flight；compact 释放条目但可共享已拥有的在途工作，迟到结果不回填。dispose 禁止新读，观察已开始的 processor 到结束：真实迟到失败原样传给原拥有者，成功迟到则拒绝发布；不让合成 disposed 错误抢掉历史省份失败原因。Session 的 cancelable 边界继续保证 Stop 无须等待外部 codec 返回。

## 存储、写图与 Web 边界

AutoPath add/remove 保留已存成品命中，普通 storage placement 查询仍立即看到新路径；显式 graphic clear 后下一次图像 miss 才选新路径。异步 miss 遇 namespace 变更会撤销回填，不能用旧搜索结果发布新的缓存 entry。现有 Web 规范请求拼写保持，未只对 key 擅自小写而合并可区分资源；原版 ASCII 归一差异仍明确保留。

保存内容的不可变 token 和实际／缺失候选、canonical 名、archive container、basename 组成失效索引；命中不重新查存储。普通 SaveOverlay 写入按依赖作保守失效，保留无关条目，并撤销在途发布。只保留内部 token 代表，不强持 Resource、read/source capability 或外部 token 捕获的输入。该 freshness 是现有 Web 内容替换边界，比原 generic stream 的 graphics 失效更主动，不能冒称完全相同的同步文件系统。

写图先验证 source bitmap、format 和 writable target，在 encoder 前清整个 graphic cache。原版在成功打开输出流后全清；Web 保存是原子替换，本批把上述验证完成作为逻辑 open 边界，失败 encoder 不恢复旧缓存但保留旧保存文件。PNG／TLG 扩展 writer 采用相同边界。运行时 drop 发布新不可变 namespace 前同步清图像缓存，既有 Session mount 也全清；日志在进入成品缓存事务前先 materialize，避免旧待写日志自行撤销刚创建的 image flight。

## 托管验收与后续工作

新增 **52 常规 Node 定义**：十五个 cache 生命周期／预算、十九个完整 ImageLoader 顺序／plane／preload、十八个真实源／字节码集成；另新增**每浏览器四个定义**，覆盖 Asyncify／JSPI 与源／字节码组合。包含零 lookup 的成品命中、五元 key、metadata／像素隔离、packed 字节、独立 mask 与省份失败、AutoPath hit／clear、损坏归档、原 LRU／重复计费、先保存后编码失败、候选更新、实际 drop、暂停时 token 替换与真实画布红／绿切换。

旧 cache／archive／project／KAG 测试按固定原合同迁移，先保留旧像素命中，再明确 clear 后验证新 placement；原补丁优先级、原 KAG 源程序、像素、存档重启、暂停／Stop 和所有权断言不删除。相关审计为 `110-processed-cache-audit.md`、`110-loader-audit.md`、`110-cache-fixture-migration.{json,md}`，位于 `out/verification/image-loading/`。

本批仍无执行通过结论，也不声称图像或整体目标全部完成。原 main／mask 失败的部分目的地写入、历史 JPEG 精确像素／数字错误、TJS 短读消息、Web 与原版大小写／原子写入边界、历史 heap、浏览器实际回归及真实游戏验收继续未完成。下轮补取 107／108／109 未报告范围并回收本批结果，不实时监控。

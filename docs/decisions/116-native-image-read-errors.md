# 116 原版图像短读错误

状态：候选，等待 GitHub-hosted Actions。整体目标仍是完成插件以外的 KRKR2 Web 模拟器，让资源加载、TJS／KAG、画面、输入、音视频、存档和退出贯通，并经过兼容性和真实游戏验收。本批只关闭其中已核对的图像短读消息边界，整体目标未完成。

从干净的 `78c078f` 继续。协议 **42**、TJS ABI **5**、字体 ABI **2**、图像内核 ABI **1** 保持；`nativeMessages` 升至 **2**。本地仅源码读改、Git 和原证据下载／哈希／解析，没有执行测试、构建、类型检查、浏览器或候选探针。110–115 的 run、jobs、artifacts 各读取一次后冻结，不实时刷新；本批整批推送后只保存一次初始运行身份，下批回收结果。

## 固定证据

回收 **68 个原 ZIP、909,737,714 字节**，其中 38 个新增、30 个复核，全部匹配 API SHA-256 和大小；九份新失败／取消作业日志与两份旧日志保留。入口是 `out/verification/github-actions/116-archive-summary.{json,md}`；各 endpoint 独立冻结，不伪称原子快照。

110／`40781763654` 已终态 **failure**。主浏览器计划 **2823：2265 pass、135 fail、2 skip、421 未报告**，取消分片的原控制台结果和 traces 仍保留。其 Node 27 个旧图像夹具失败在 111 已逐标题核对为通过，不再视为当前未修复项。

111／`40785212878` 出现新的 **Node 24.19.0 SIGTRAP**。完整 `core.MainThread.5676` 为 **1,320,726,528 字节**，SHA-256 为 `502a437786af1b64047be0fbf22a8c65070520e240fcc36fe1065ed5e5a1c1a0`，与托管 digest 一致。原回溯指向 WASM JIT wrapper 代码释放路径，断言 `jit_page_->allocations_.erase(addr) == 1`；它与旧 malloc SIGABRT 分开记录，不能根据相似上游报告宣称本仓库根因已闭合。本批保留主 Node 版本和执行参数，后续再以独立托管对照验证。

官方 [Node 同栈问题](https://github.com/nodejs/node/issues/66366)及 [V8 wrapper 引用修复](https://github.com/v8/v8/commit/9b8ca54d5a6b6c615eb7ad6d9e2bdca7f8cb1a81)提供了可检验线索。只读核对的固定 Node 24.19.0 源码仍有先 AddRef、再检查 is_dying 的对应路径；当前失败使用 Asyncify，第八项内部在哪个 VM 阶段出错仍未知。原源码／hash 和下一批同 Node 默认设置与禁用 WASM code GC 的有界托管对照方案保存在 `out/verification/node-wrapper-crash/116-audit.md`。该方案尚未执行，不改变本批主验证合同，也不把今后的偶然通过当作本次崩溃已解决。

111 独立连续事件流共有 **12552** 条，注册 **3681 个实际定义：3673 pass、8 未报告**；另有一个失败文件容器。TAP 的 3674 包括该容器，不能当作完整定义总数。`activity.test.ts` 前七项通过，第八项 `page suspension removes queued timer ticks…` 已 dequeue、没有结果，后七项也未报告。

111 Firefox 前两分片合计 **472 pass、2 font fail、1 skip**；原十三个失败中十一项 cursor／坐标已明确通过，两项字体失败仍保留，112 路由修复尚未执行。可信生命周期 **19/19**、三浏览器原 KAG **96/96**，另七个主浏览器作业未报告。Win2022 beginMove 的受控输入前置失败独立保留，不并入 V8 崩溃。112–115 仍 pending、零 jobs／artifacts，原生 PNG 参考仍无执行结果。历史失败、取消、skip、Library 勘误与未比较范围不被覆盖。

## 只映射真实源读取

新增 `ImageReadError` 保存 format、源 offset、requested、actual 和原诊断。只有已选择 BMP／PNG／TLG handler 的真实源 ReadBuffer 不足才产生它。通用解码 API 的诊断保持；解压后的内存数据、格式校验和 Web 资源预算不因此成为源短读。

BMP 按原字段顺序读文件头，再读取 palette，最后在 size 后按最多八个 file-order 行一批读取像素，完整批次才发布。即使调用者没有 progress observer，也执行相同读取边界。TLG5 跳过原版不读取的 block-size 表，之后的实际读取才可失败；TLG6 的四字节 mark 是一个完整读取。SDS 的 rawLength 是解码后的 seek 目标，不人为截断 raw 子流；末尾一到三个 chunk-name 字节属于普通 Read 的 EOF，未知 chunk 仅 seek，tags 的大小和 payload 才使用要求完整的读取。已读入 tags 的内部解析错误不重标成 TJSReadError。

PNG 保留原拉取式 IDAT／CRC／read-end 边界，补签名和已核对头部字段的短读。先判断原版可在 payload 前拒绝的 IHDR 长度／重复、缺失 IHDR／PLTE 和过早 IEND，避免把已知格式错误误标成读取不足。旧完整缓冲入口保留原可见诊断及其已有能力边界；未核对的 ancillary handler 读取粒度不声称已与原版完全一致。

selected decoder 只在 codec 创建和推进边界把真实短读转换为 `TjsError('TJSReadError')`，结构化原因仍保留在 cause。宿主读取、调度器、inflate/open/step、size/write/row 回调与 cleanup 的异常保持原对象；即使它们主动抛出外观相同的错误类也不被重新归因。暂停／Stop 关闭被委托的 generator；真实主错误与 cleanup 错误同时存在时分别保留。

## 原生 holder 与实际消费者

新增私有 reply kind 11 和 literal formatter，精确白名单只有无参数的 `TJSReadError`。它使用当前 VM 模块的既有 TJS holder，区别于 TVP catalog 的 `TVPReadError`；`%s`、`%1`、`%%` 均按字面保留。它不注册新脚本 API，不重入 VM、不排空释放队列。现有 typed TVP reply kind 10 和 144 项 catalog 保持。

runtime、普通 host 调用、预检、排队写入、collect／console／dispose 和 Session 错误文本接通该描述符；holder 在真正消费错误时解析，重赋值和独立 VM 不相互污染。能力门禁拒绝缺失、0、1、3 版本及缺失 formatter，避免新 JS 配旧 WASM。

新增 **36 个常规 Node 定义**：10 个源读取与错误来源边界、6 个 PNG 头部／读取边界、8 个原生 VM 消息定义、12 个 source／bytecode 真实消费者；新增 **每浏览器 4 个定义**。既有消息文件自动进入原 JSPI sweep，两个浏览器能力门禁扩展旧版本拒绝。旧 partial／province 夹具只迁移已改变的真实 VM 消息预期，保留像素、中间态、缓存、暂停和 Stop 断言。字体 Worker 文件路由补入新增的 BMP 运行时依赖。

这些定义均未在本地执行，静态复核不是通过证据。下批先取回未完成运行，继续处理真实差异；Node 新 SIGTRAP、历史 heap／几何／菜单／媒体回归、PNG 特殊 palette 路径与原二进制身份、JPEG 原生失败进度、ERI、统一内存预算和完整游戏验收仍需完成。

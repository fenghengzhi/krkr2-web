# 109 托管事件回归与 portable BMP

状态：开发候选，尚待 GitHub-hosted Actions。108 的实际实现及交接已推送，上一轮属于有进展的一轮；本轮从干净的 `f809097` 继续。完整目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。协议 **41**、TJS ABI **5**、字体 ABI **2** 保持，`nativeSystem` 升至 **6**，生产入口拒绝旧版本。

本地只读改源码、操作 Git 和回收／解包／校验／解析运行原件，没有执行测试、构建、类型检查、浏览器或候选探针。107／108 每个 run、jobs、artifacts 端点本轮各取一次并冻结，不实时刷新；推送后只取一次本批运行身份。

## 固定托管证据

107／`40773899535`／`ff9a73ed0213b50f03b342d5cb4f3cbb44955629` 的 run 仍 in_progress；已出现的 34 jobs 为 23 success、6 failure、5 running。主 build 已成功，不能将先前没有步骤的取消记录改写为曾经构建通过。108／`40776092450`／`3e246bf771af3c2f84a1a4a94679449997a9016c` 仍 pending、零 jobs／artifacts，尚无本批执行结果。

固定三十份原 ZIP、**299,316,342 字节**全部与 API 大小／SHA-256 一致，二十一份新下载、九份复用重新核对，六个失败作业原日志各保存一次。总表在 `out/verification/github-actions/109-archive-summary.{json,md}`，各运行保留原响应及 `109-snapshot-summary`，历史缺失／失败不删除。

107 主 Node 完整 **3549 项：3520 pass、29 fail、零 cancelled／skipped**。独立事件流序列连续并报告结束，与 TAP 完整库存吻合。失败分为：事件异常处理十七项、省份图失败后的显示几何八项、原脚本异常文本预期两项、排队写入测试两项。同一消息专项 JSPI 十七项中十五 pass、两项相同文本预期失败；JSPI 栈池八、随机十六、容器四项均有通过报告。

可信生命周期十九项中十八 pass，一项报告 deactivate callback 观察序号早于 compact。兼容库存为 Chromium 30 pass／2 未报告、Firefox 29 pass／1 fail／2 未报告、WebKit 30 pass／2 未报告；三个 KAG debug 探针因预期对话框未出现中止，没有生成双 backend 的完整诊断，不能把六个未报告项改写为六次已执行失败。Firefox 的另一失败是 JSPI Help 截图超时。主浏览器五个 jobs 仍运行而无报告，不推断其结果。library 57、PWA 59、直接 runtime 6 项仅在各自完整报告范围通过。

两种菜单模式各三次、每次二十四定义都有完整 register/start/pass、exit 0、正确运行模式和进程组清理、零 core，合计 144 次有界观察；Layer 两模式各三次、每次二十定义也完整。没有本批 raw core 原件不代表历史 SIGABRT 根因闭合。双 Windows 光标 strict 各 1076/1076 matched，5578 uncompared、portable 173 partial 保持；Win2022 beginMove 的输入标签前置失败原样保留。

## 事件异常处理的确定修复

106 为保留应用回调，将事件泵绑定到私有 Dictionary。TJS 的未绑定 `handler(error)` 会把调用方 objthis 传给处理函数；Dictionary 在缺成员时返回成功的 void，阻断原全局对象回退。因此使用全局计数器的匿名 exceptionHandler 没有更新原变量，而已有绑定 receiver 的处理函数仍能工作。十七项异常相关失败中，十五项涉及该调用链；另两项 System application 场景先停在 getter 日志的原异常前缀预期，不能把它们也归为已证明的上下文失败。

固定 `ScriptMgnIntf.cpp:764–845` 先取一次 handler closure，再用 `clo.FuncCall(..., NULL)` 调用。原 `tjsVariant.h` 会保留 ObjThis，未绑定时回退到函数对象；把调用简单改绑 global 会改变显式 this 和函数自有成员的优先级。本批增加短小的私有 native helper，按该原规则在当前 TJS 栈内调用，保留原异常、挂起和资源计数边界。bootstrap 捕获它后删除临时 System 成员，handler getter 仍只读取一次。

新增源／字节码及真实浏览器回归，字面核对全局计数、函数自有成员、未绑定函数对象和绑定 receiver 的 this、getter 次数、匿名／绑定／匿名恢复顺序及 Stop 清理。TJS 严格对象相等同时比较 Object 和 ObjThis，因此未绑定 handler 与其 this 的 `===` 本来为零；测试另用规范化 closure 的严格相等及普通相等证明函数对象回退，不能混用 JavaScript 的对象规则。原处理函数调用／恢复／清理断言没有放宽。来源审计在 `out/verification/system-exception-context/109-source-audit.{json,md}`。

## 显示几何、失活顺序与夹具

`LayerTree.image` 安装新 Bitmap 后调用公开 `resizeImage`，后者因尺寸已经相同而提前返回，漏掉原 LoadImages 总会执行的 InternalSetImageSize 显示矩形／偏移调整。本批在图像替换后直接执行对应四项 clamp，保留公开同尺寸 setter 的早退行为、完整新主图以及失败时省份清理。原八项几何／画面边界断言保留。

失活通知可能在正在执行的事件回合内到达，外层 compact 队列尚未运行，而同回合可先取得 application job。现在在实际 onDeactivate 之前，通过当前 native 栈上的 host reply 消费待执行的原 compact 方法；事件禁用时已有独立 compact 请求仍可执行。新增两个确定性场景，在真实 Timer 的宿主调用尚未返回时投递失活，要求 compact:10 严格早于 callback、只执行一次且不调用被脚本覆盖的方法。可信浏览器观察另增加同一 BroadcastChannel 的 marker 基线，避免旧回调消息尚在传输时与下一次 compact 配对；不改变真实焦点操作或严格顺序断言。旧浏览器失败是否同时受该观察边界影响，尚不能仅凭一个序号断定。

夹具按已确认的实际边界修订：消息聚合中的主异常保留原 `script exception : script-primary` 前缀及全部 cause／tail 检查，System application 的 native getter 日志也保留相同 VM 前缀（其后 TJS handler 接收的原异常对象仍使用原 message）；排队压缩失败测试消费 `Storages.isExistentStorage` 返回值，防止原只读 native 方法跳过被丢弃的结果而没有触发宿主 flush；省份异步取消夹具改用真实 indexed PNG 的 inflate 依赖，代替 108 严格 handler 后不再可达的伪 PNG 字节／host fallback。迟到失败、目标修改、Stop、原像素和所有权断言继续保留。

## BMP 真实解码与后续缓存合同

新增 portable CORE 和 BI_RGB 15／16 位分支，真实游戏不再依赖浏览器是否接受这些合法 BMP。RGB555 按原五位复制扩展，灰度直接使用原五位公式 `(56R5+187G5+21B5)>>5`；不能先扩展 RGB 再套八位公式。原 CORE 分支 memset 清掉 biSize，后续实际按四字节 palette 读取，本批 selected decoder 按固定实现的可界定字节行为处理，direct embedding 仍按标准三字节 CORE palette。原本会跨越十五位行缓冲的尺寸明确拒绝，不复制越界读取；短读、预算和未核对 decoder 错误不伪装成已知原生消息。固定来源与剩余边界见 `out/verification/image-loading/109-bmp-audit.md` 和 `109-source/manifest.json`。

新增十二个 BMP conformance 定义，覆盖 header、palette 重叠、原灰度、行序、行距、模式及旧 corpus；另用源／字节码和实际画布验证 CORE 主图、RGB555 遮罩与 indexed CORE 省份的同一完整链。原 CORE mock-host 测试改为真实 portable 输出，host 一旦被调用就失败，原字面灰度预期保持。

本轮完整审计 processed graphic cache，**尚未实现**。实际 key 包括规范请求、color key、mode、期望宽高，命中在存储查询之前；主图成功缓存后省份失败不移除主图，省份解码成功但外层尺寸失败也不等于缓存失败。原 TouchImages 对重复命中仍累计成品图字节，LRU 在插入前整理并可能多保留最后一图；universal rule 还传 `0x02ffffff` 和源图实际尺寸。完整安全边界、写入／AutoPath 失效、原始／实际内存计费及后续验收方案保存在 `109-processed-cache-audit.md`，不能用半套 `(name,key)` 缓存替代。

本批新增 **18 常规 Node、每浏览器 8 定义**；旧 capability 拒绝矩阵增加版本 5，可信生命周期定义数量不变。所有新执行结论仍未报告。下轮补取 107／108 未报告范围并回收本批结果；继续处理实际回归、完整缓存、JPEG 精确性、历史 heap 和真实游戏验收，整体目标保持 active。

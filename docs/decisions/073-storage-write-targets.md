# 073 — UPDATE 存在性与写入目标绑定

2026-10-04 候选实现，未取得本切片 Actions 通过结果。TJS ABI 保持 5、会话协议保持 22，`nativeTextStreams` 提升为 **2**。071 的模式解释和短覆盖算法继续适用；本切片接续其未完成的 UPDATE 路径合同。

## 来源与 Web 边界

固定原版 [TextStream.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/TextStream.cpp) 按是否出现小写 `o` 选择 UPDATE；[StorageIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/StorageIntf.cpp) 的 UPDATE 通过 placed path 选定已有目标。这里是固定源码推断，没有在本机执行原版参考。旁边 kirikiroid2 工程已改写过偏移判断，不能替代这份 KRKR2 合同。

本实现保留 Web SaveOverlay copy-on-write：可修改游戏资源的保存层副本，不写回导入文件或 OS 文件。绑定的是虚拟文件名称，不是 OS 句柄、锁或创建时字节快照；不承诺并发跨流事务、原版构造期 BOM／截断或原文件共享语义。

## 创建与写入

文本预检仍先校验编码／模式，再校验路径。二进制入口仍不解释文本 c/z 编码。两个预检现在返回已解析的目标字符串，native 必须收到非空字符串 value reply 才能构造 writer，并将该目标保存在流中；错误、空值及其他 reply 不能产生延后写队列。

- 含显式 `o` 的模式必须找到已有目标，包括 `o0`、空 `o` 及追加组合 `ao0`。按现有 direct-first、最后注册 autoPath 优先的查找顺序，选定 overlay 或挂载资源的真实名称。
- 普通 WRITE 只在直接路径上寻找已有拼写，不搜索 autoPath。大小写折叠唯一时沿用原名字；exact 名称优先，非 exact 的歧义拒绝。不存在直接目标时，按请求路径创建。
- Web 追加扩展 `a` 无 `o` 时仍可创建缺失文件；命中已有资源时同样绑定真实名称。
- 显式 archive 成员、包括 autoPath 解析得到的 `archive>member`，继续拒写。067 中既有的平面 archive alias 仍允许 copy-on-write，不将此策略冒充原版归档写入。
- 尾部合并只按绑定目标查找 overlay／mount，不再搜索 autoPath。偏移覆盖保留前缀／后缀，追加选 EOF，预算检查与显式失败重试保持不变。

新宿主依赖 native 保存预检结果，因此生产 loader 同时拒绝缺失能力及旧 `nativeTextStreams:1`，不能让旧内核静默使用请求名称。

## 验收定义与状态

新增真实 native VM 边界检查覆盖五条保存入口、绑定名称与请求名称不同、非法 reply／宿主异常无排队、恢复及句柄回收。Session 定义覆盖源码／字节码的缺失 UPDATE 当场捕获、挂载／存档 autoPath 绑定、direct 优先、大小写唯一／歧义／exact 双名、普通 WRITE 不搜索、二进制覆盖、append、archive 拒绝与持久存储重新载入。

浏览器定义覆盖三种浏览器、两个后端及源码／字节码，检查真实导出路径集合和字节、Stop／reload 后新 Worker 的实际读取。manifest 介入检查缺失／旧能力拒绝，并恢复精确原始 manifest 后继续运行。原 KAG BMP offset 追加场景仍由已有兼容探针覆盖，不以这些新定义替代。

本机只进行源码编辑和静态审查，所有类型检查、构建和测试均交给 GitHub-hosted Actions。前轮 `37162952459@f976640` 在构建阶段失败，Node、浏览器及直接运行时作业均未执行，不能作为 072 或本切片的验证。官方注释指出旧 `storage-selector-kag.ts` 的 provenance 数组缺少显式类型，已并入本批修正；完整日志 ZIP 尚未取回，API 下载返回 401。

# 072 — 脚本退出与尾部写入的错误保留

2026-10-04 候选实现，尚待 GitHub-hosted Actions 验证。

真实 native 文本流可在脚本退出前将写入放入 runtime 队列。此前 `run()` 在 `consumeReply()` 的 `finally` 中执行 `flush()`；如果脚本异常与写入失败同时发生，写入错误会覆盖原来的 ScriptError、源码位置及 trace。

现在先读取执行结果。脚本与写入同时失败时，以 AggregateError 的 `errors` 顺序保存 `[ScriptError, writeError]`，`cause` 指向原 ScriptError，顶层 message 保留原脚本消息。只有脚本失败时仍抛出原 ScriptError；只有写入失败时仍抛出原写入错误。失败的写入仍留在队列中，可显式重试；成功的写入不会重复提交。现有 Stop 取消优先级不变，这项修订不声称覆盖取消与写入同时失败的全部排列。

新增八个真实 Asyncify VM 用例，覆盖源码／字节码 × 脚本成功／失败 × 尾部写入成功／失败。真实 Array.save 产生文本流写入，宿主边界注入持久化失败；检查脚本位置、错误身份和顺序、重试内容、执行锁恢复及句柄释放。该宿主边界不证明 IndexedDB 本身的持久化行为，也不替代浏览器双后端回归。

此修订与迁移后接续的 SessionClient.stop／LibraryClient.cancel watchdog 结算修订组成同一验证批次。未执行本地测试、构建、类型检查或探针；候选尚未合入已验证 main。

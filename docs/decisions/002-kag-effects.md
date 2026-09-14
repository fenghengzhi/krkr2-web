# KAGParser 的 TypeScript 状态机与 TJS 回调边界

状态：已实现并通过真实 WASM 与浏览器测试，完整原引擎差分仍在进行。

`engine/kag/` 负责 UTF-16 场景词法、位置、标签索引、条件、宏展开、调用栈与保存恢复。`engine/tvp/kag.ts` 只负责 TJS 类接口、活字典及表达式/回调执行；游戏原有的 Conductor 和 KAG 框架继续运行。

解析器以 generator 产生效果：读取场景、执行表达式、通知宿主、查询/修改宏和宏参数。KagService 处理文件读取，其余效果以结构化值交给 TJS trampoline。TJS 执行完成后，用带 parser ID 和单调 token 的 continuation 恢复状态机。异常会移除对应 continuation，避免失效结果再次推进场景。

这个边界保证 TJS 表达式使用原 VM 与子类实例上下文，避免 JavaScript 在 WASM 挂起期间再次进入同一个 VM。JSPI 和 Asyncify 共用实现。解析循环会定期返回 trampoline，配合原 VM 的指令预算允许取消。

宏定义和宏参数的可变字典归 TJS 持有；参数的源顺序单独存储，用于 `*` 转发和保存。TS 读取参数时显式复制原生 Array/Dictionary 数据。值桥不自动把脚本对象转换为 JSON，也不执行脚本 getter；其余对象继续通过显式引用句柄传递。循环数据、非数据对象和超出预算的复制会失败。

`getNextTag` 复用返回字典与 taglist。标签恢复与精确克隆分开：`assign` 复制当前文本位置；`store/restore` 遵循当前检查的 KAGParser 原实现，以标签恢复场景并保留调用栈。调用返回根据标签及相对行号恢复，并校验原始调用行内容，避免资源变化后跳到错误位置。

证据：`tests/integration/kag.test.ts`、`tests/conformance/tjs.test.ts`、`tests/browser/kag-menus.spec.ts`；本地 `kag3_template.xp3` 的原有 `Conductor.tjs` 通过 `tests/probes/kag.ts` 验证宏、等待、异步继续和 call/return。原始 API 见 [KAGParser 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_KAGParser.html)。这不是完整 KAG 画面或商业游戏兼容的证据。

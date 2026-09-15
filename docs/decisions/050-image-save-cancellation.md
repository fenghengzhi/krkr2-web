# 050 — 图像保存取消的触发时序与编码检查点

状态：实现与测试已补充，GitHub Actions 验证待运行。不得将后续未修改测试的绿色重跑解释为本次浏览器竞态已经修复。

## 已有失败证据

[Actions 34929264074](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929264074)，源码 `259c8924877d2e5bd7b9181b7b09498d04c0e9c6`，`Browser / webkit / browser (macos-15)` 的 Asyncify PNG 保存取消测试失败。该失败记录保留。

归档：`out/verification/github-actions/34929264074/complete/browser-results-webkit-browser/test-results/image-writing-asyncify-sto-91f6d--discards-unfinished-output-webkit/trace.zip`，SHA-256 `753b8c9d22b8e1d0338161d367e4f3405c32f8826c738ccb514c5c17b9938153`。其中 `1-trace.trace` 的 SHA-256 为 `01dcf23ebc8a5884dc63c08f3815fc29178e2cad93f7190aa062bc63e116144d`。

主检出目录另保存静态分析及机器可读时间线：`out/verification/layer-neutral-color/png-stop-34929264074.md`、`png-stop-34929264074.timeline.json`。

| 观察                                                    | Trace 单调时间 / ms |
| ------------------------------------------------------- | ------------------: |
| 浏览器端 `encode-start` 文本断言成功                    |          380288.034 |
| 断言结束快照只包含 `encode-start`                       |          380701.565 |
| Playwright 发起 Stop click API                          |          380827.718 |
| Stop 元素定位完成                                       |          382045.993 |
| 点击前的 action 快照已包含 `encode-finished` 和会话就绪 |          382098.102 |
| Playwright 开始实际点击动作                             |          382183.185 |
| 点击动作完成                                            |          382190.368 |
| Stop 禁用断言成功                                       |          382220.343 |

完成记录在实际点击前至少 **85.083 ms** 已出现在快照；从浏览器端开始标记断言成功到实际点击间隔 **1895.151 ms**。UI 日志的开始/结束时间分别为 `04:40:36`、`04:40:40`，仅精确到秒。Trace 未记录精确编码入口、完成瞬间或 Worker 收到 Stop RPC 的时间。

这次失败证明操作先于点击完成，不能证明运行时丢失了已经到达的取消请求，也不能据此宣称取消逻辑已验证。

## 修改

浏览器测试沿用 `image-loading.spec.ts` 的测试侧 MutationObserver：上传前监听日志，看到 `encode-start` 后直接调用真实 Stop 按钮的 `click()`，避免额外的 Playwright 请求、定位及稳定性等待。按钮仍经过应用原有事件处理函数。测试记录开始观察、按钮点击和完成观察的顺序及 `performance.now()`，并以 `image-stop-order` JSON 附件保存。

保留未完成日志不得出现、Worker 不得超时退出、Stop 在 1.8 秒内禁用的检查。原来的完整编码、导出、重新载入用例继续使用真实 `locator.click()`，覆盖普通控件点击路径。图像尺寸和等待时限没有增加。

`encode-start` 在 `saveLayerImage` 调用前，因此浏览器观察器只证明及时请求了真实停止处理函数，**不作为已经进入编码器的检查点证据**。它也不是对真实用户控制延迟的基准测量；历史 Trace 中的定位延迟仍单独保留。

集成测试通过已有 `SessionDependencies` 注入机制控制第一轮真实 `finishGraphics` 调度，无需生产测试开关：

1. 完成会话初始化和可选字节码编译后开始保存脚本。
2. 在 `encode-start` 事件之后才启用检查点。该夹具没有帧驱动、用户计时器或中间宿主调用；后续第一个零延迟调度来自 `saveLayerImage` 编码器已经执行生成器步骤后的 `finishGraphics` 让出。
3. 持有该调度回调，断言开始事件、编码检查点按序发生，取消尚未请求，存档字节没有改变。
4. 暂停会话并释放回调，确认暂停期间没有完成或提交，再调用 `stop()`；检查点恢复后必须观察取消。
5. 断言执行以取消异常结束、停止成功、句柄归零、所有存档和开始前逐字节一致，且没有编码完成日志。

矩阵为源码/字节码 × `png`、`png24`、`png32`、`tlg`、`tlg5`、`tlg524`、`tlg6`、`tlg624` × 覆盖已有目标/写入新目标，共 32 项。覆盖目标保留原有字节；新目标不得产生不完整文件。BMP 使用同步编码路径，不在此检查点取消矩阵中。

## 验证边界

本改动只修改浏览器测试、集成测试和本记录。没有生产代码修改，没有新的运行时测试钩子，也没有新增本地测试或探针执行。所有构建、类型检查和运行验证交由 GitHub-hosted Actions。

新增矩阵和观察器的宿主执行结果：**待验证**。既有取消测试通过只支持其原有范围；本次源码/字节码和 PNG 扩展需要新的执行证据。后续可把同一依赖注入夹具打包为独立浏览器 Worker，通过检查点已到达 → Stop 已接收 → 释放检查点的消息顺序验证 Worker 调度；无需修改生产接口，也不把它混同于真实页面按钮的延迟测试。

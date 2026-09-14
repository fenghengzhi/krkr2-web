# 私有解压流清理与 WebKit 锁等待

字体阶段的完整回归发现 PNG/TLG 存档用例偶发卡住。相同场景在 Asyncify 和 JSPI 均复现；最后一条脚本日志没有出现，不能由此判断启动脚本尚未执行。

## 定位证据

过程记录显示，启动脚本已进入第一张 PNG 的 `Layer.image`，解压的 `reader.read()` 已经完成，随后 Worker 心跳停止。加入较多记录会改变执行时序，有些重复批次全部通过，另一些仍失败。

最终在不改应用脚本的失败现场采集 macOS 进程栈。卡住的 Worker 在 757 个采样中停留在同一路径：`ReadableStreamDefaultReader.releaseLock` 调用内部 JavaScript，创建 TypeError 时触发 GC；GC 的 reader visitor 随后等待同一读取器的内部锁。

所测 WebKit 为 Playwright revision 2359、WebCore 626.1.6+。栈中合并符号通过该实际二进制的符号表和反汇编定位为 `JSReadableStreamDefaultReader::visitAdditionalChildrenInGCThread`。外层 releaseLock 与 visitor 都访问读取器偏移 0x28 的锁；外层在调用内部函数时尚未解锁。公开 WebKit 源码的 releaseLock 同样在 `m_streamLock` 作用域内调用 internal reader。证据保存在 `out/verification/fonts/reader-release-deadlock/` 及 `reader-*-disassembly.txt`。

这与该现场的浏览器内部锁死相符；没有证据将它归因于字体画布、PNG 数据、GPU 绘制或单一 WASM 后端。单独运行生产压缩/解压函数的 3,000 次浏览器往返没有复现，不能用这组隔离通过否定完整会话的失败。

## 实现

`blob-source.ts` 的压缩与解压函数各自拥有流和读取器，不把它们交给其他消费者，也不再读取一次。现在区分 EOF 和异常：EOF 已关闭生产端，函数直接返回；异常、输出越界或 checkpoint 取消时仍等待 `reader.cancel()`，终止上游。

这两个私有读取器不再调用 `releaseLock()`。流及读取器在完成后均不可达，由垃圾回收处理；省略释放锁不意味着忽略取消，也不改变输出大小验证。共享流、可接续消费者和其他存储句柄的清理没有采用这个规则。

修复后的原图像存档场景在 WebKit 两后端各重复 25 次，50 项均通过；35 项资源和图像定向测试通过。`streams-lifetime.ts` 用真实 Node Web Streams 检查 64 次往返与四种异常/取消路径，133 个观察到的读取器均在 V8 GC 后回收。这证明 JavaScript 可达性，不测量 WebKit 的内部内存。完整检查结果与最终构建由字体阶段矩阵记录。

诊断用例位于 `tests/probes/startup-diagnostic.spec.ts`。`KRKR_STARTUP_TRACE=0` 禁用过程注入，只在失败后采集进程栈；进程采样限定 macOS 的 Playwright WebContent。诊断不会随产品构建发布，也没有修改浏览器超时或用例选择。

依据：[WebKit reader 实现](https://github.com/WebKit/WebKit/blob/868a13beabdb7370beac344bf37a931351567395/Source/WebCore/Modules/streams/ReadableStreamDefaultReader.cpp)、[内部读取器调用](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/bindings/js/InternalReadableStreamDefaultReader.cpp)、[Streams 的读取器和取消语义](https://streams.spec.whatwg.org/#generic-reader-cancel)。公开源码与现场二进制分别作为结构参考和直接证据；固定源码版本和现场二进制哈希保存在 `reader-release-diagnosis.json`。

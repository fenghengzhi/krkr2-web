# 原生调用栈与脚本调试

`Scripts.getTraceString(limit=0)` 使用原 TJS 调用栈。参数省略、void 或 0 返回全部当前调用；其他参数使用原生整数转换，正数限制帧数，负数与原生实现一样返回一帧（避免 INT_MIN 自减溢出）。字符串保留原文件名、行号、上下文名称和 ` <-- ` 顺序；try 子执行帧按原算法折叠。

原接口要求启动时的 `-debug=yes`。播放器增加“脚本调试”复选框，在下一次启动/重新开始时生效；EngineSession 同样读取创建时的参数。游戏在启动后用 `System.setArgument` 修改该值，不会改变已创建 VM 的调试模式。默认模式返回空串。浏览器选择通过可选初始化字段传递，旧字段契约和协议 9 保持兼容。

## 挂起和原生方法

参考快照在 Emscripten 下禁用了栈记录。原记录保存指向 `ExecuteCode` 局部 `codesave` 的指针；Asyncify 挂起后 C++ 栈可能已被展开，宿主分配对象时的调试记录仍可能访问它。现在每条指令在检查时间片前复制相对 CodeArea 的整数偏移，记录继续持有上下文引用，不保留临时栈地址。嵌套调用保留父调用位置，恢复后下一条指令更新位置。

`Scripts.getTraceString` 直接绑定原生 `tTJSNativeClassMethod`，使用原 TJS 参数转换和 Function 身份。调用期间不经过 JS 宿主，也不增加 TJS 包装函数帧。绑定对象通过新值描述传递，宿主仍不能重入正在执行的 VM。

调试选项在 `tTJS` 创建前设置，由其原生命周期成对管理 ObjectHashMap 和 StackTracer；不在执行中切换。删除中对象的警告纳入已有栈清理边界，防止观察者抛错留下帧。调试模式额外错误输出的两个入口也保留主要异常，即使输出观察者再次抛错。全 VM 停止时不调用用户 finalizer 的既有规则保持不变。

## 发布与验证

`krkr_create` 新增调试参数，值桥新增原生方法构造，因此 TJS WASM ABI 升到 **4**。字体 ABI **2**、会话协议 **9** 不变。ABI 3 样本来自通过的 GitHub Actions `34809918318` 的 `test-build/dist`，只重新封装文件；原发布树及构建哈希由上一阶段报告固定。

验证在 GitHub Actions 执行，新增真实 WASM 的源码行号、参数限制、try 栈折叠、大量宿主对象分配、异步源码/回调、字节码、错误恢复、暂停取消和销毁后新 VM 检查。浏览器覆盖三引擎双后端的开关/重新开始及冷离线启动；兼容工作流增加 ABI 3→4 的旧/新 Worker 离线执行。测试结果待本阶段云端运行记录补齐。

原生错误界面的自动打开策略、全部隐式回收路径与其他非插件能力仍未完成。

参考：[KRKR2 getTraceString 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts_getTraceString.html)、原 ScriptMgnIntf.cpp 中的初始化与 getTraceString、vendored tjsDebug.cpp 和 tjsInterCodeExec.cpp；原始来源哈希见 `third_party/tjs2/source.json`。

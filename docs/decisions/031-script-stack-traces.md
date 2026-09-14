# 原生调用栈与脚本调试

`Scripts.getTraceString(limit=0)` 使用原 TJS 调用栈。参数省略、void 或 0 返回全部当前调用；其他参数使用原生整数转换，正数限制帧数，负数与原生实现一样返回一帧（避免 INT_MIN 自减溢出）。字符串保留原文件名、行号、上下文名称和 ` <-- ` 顺序；try 子执行帧按原算法折叠。

原接口要求启动时的 `-debug=yes`。播放器增加“脚本调试”复选框，在下一次启动/重新开始时生效；EngineSession 同样读取创建时的参数。游戏在启动后用 `System.setArgument` 修改该值，不会改变已创建 VM 的调试模式。默认模式返回空串。浏览器选择通过可选初始化字段传递，旧字段契约和协议 9 保持兼容。

## 挂起和原生方法

参考快照在 Emscripten 下禁用了栈记录。原记录保存指向 `ExecuteCode` 局部 `codesave` 的指针；Asyncify 挂起后 C++ 栈可能已被展开，宿主分配对象时的调试记录仍可能访问它。现在每条指令在检查时间片前复制相对 CodeArea 的整数偏移，记录继续持有上下文引用，不保留临时栈地址。嵌套调用保留父调用位置，恢复后下一条指令更新位置。

`Scripts.getTraceString` 直接绑定原生 `tTJSNativeClassMethod`，使用原 TJS 参数转换和 Function 身份。调用期间不经过 JS 宿主，也不增加 TJS 包装函数帧。绑定对象通过新值描述传递，宿主仍不能重入正在执行的 VM。

其他 TVP 接口仍有 TJS 桥接函数，它们实际在栈上执行时会出现在结果中；本实现不按文件名过滤这些帧，否则会隐藏真实用户调用。完整宿主原生类/方法迁移仍属于后续兼容工作。

调试选项在 `tTJS` 创建前设置，由其原生命周期成对管理 ObjectHashMap 和 StackTracer；不在执行中切换。删除中对象的警告纳入已有栈清理边界，防止观察者抛错留下帧。调试模式额外错误输出的两个入口也保留主要异常，即使输出观察者再次抛错。全 VM 停止时不调用用户 finalizer 的既有规则保持不变。

## 发布与验证

`krkr_create` 新增调试参数，值桥新增原生方法构造，因此 TJS WASM ABI 升到 **4**。字体 ABI **2**、会话协议 **9** 不变。ABI 3 样本来自通过的 GitHub Actions `34809918318` 的 `test-build/dist`，只重新封装文件；原发布树及构建哈希由上一阶段报告固定。

验证在 GitHub Actions 执行，新增真实 WASM 的源码行号、参数限制、try 栈折叠、大量宿主对象分配、异步源码/回调、字节码、错误恢复、暂停取消和销毁后新 VM 检查。浏览器覆盖三引擎双后端的开关/重新开始及冷离线启动；兼容工作流增加 ABI 3→4 的旧/新 Worker 离线执行。[完整回归 34815634377](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815634377)已通过 351 项 Node、609 项浏览器（486 常规、57 游戏库、59 PWA、7 原生生命周期）及 6 项直接运行时检查，所选用例无失败、跳过或 flaky，未使用测试重试。

[兼容性运行 34814325349](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814325349)已通过全部 72 项：原 KAG 36 项、菜单 6 项、异常恢复 6 项、TJS ABI 1/2/3→4 各 6 项及字体 ABI 1→2 共 6 项。三份 TJS 旧发布均实际在服务器关闭后重新创建 Worker；新 ABI 4 还检查了启用调试后的原生调用栈。

完整检查中的 [运行 34814477725](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814477725)有 1 项既有 Chromium 后台输入测试失败，其余 350 项 Node、608 项浏览器和 6 项直接运行时检查通过。该测试在 `onMouseDown/root.focus` 尚未建立脚本焦点时立即隐藏页面，失败 trace 中输入模式一直为 none；后台按既有规则丢弃未完成的输入，所以恢复后合成文字没有接收图层。原测试现先等待来自脚本焦点状态的 inputmode=text，再开始组合输入与后台清理；原有提交文字、按键、捕获与点击断言保留，不增加超时或测试重试。

[输入时序专项 34815498178](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815498178)通过确定性阻塞 VM 的焦点检查，以及三浏览器双后端各 5 次、合计 30 项原清理场景。确定性检查证实旧鼠标回调被丢弃时不会建立焦点，新鼠标回调执行后才接收文字；没有修改播放器输入实现。更早的历史输入失败没有足够记录确认同一原因，继续保留为未定位历史事件。

最初的 `34813848305` 在切换到修正了启动日志等待的测试提交后被工作流并发策略取消；已完成的子作业及中断材料已归档，不视为完整通过。

[最终阶段报告 34816691294](https://github.com/fenghengzhi/krkr2-web/actions/runs/34816691294)已在云端核对全部结果与源代码，写出 `out/verification/stack-traces-matrix.json`，SHA-256 为 `9babc637693f500efb1a04399f246f037ee5f32ba16090d78d2ab6113ec0a9df`。报告绑定 503 份证据，包含 116 份持久 context 预算、6 份媒体时钟和一次 21,060.3 ms 的可信冻结记录。本阶段没有重复上一阶段独立的三次长冻结；两阶段结果分别保留。

生成报告时提交为 `813bdf2`；本次文档更新不改变应用与测试。完整产物已下载到 `out/verification/github-actions/34816691294/`，云端构建的 `.generated` 与 `dist` 已同步回工作区，旧本地产物另存于 `out/verification/stack-traces/prior-local-artifacts/`。没有在本机运行测试或探测。

原生错误界面的自动打开策略、全部隐式回收路径与其他非插件能力仍未完成。

参考：[KRKR2 getTraceString 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts_getTraceString.html)、原 ScriptMgnIntf.cpp 中的初始化与 getTraceString、vendored tjsDebug.cpp 和 tjsInterCodeExec.cpp；原始来源哈希见 `third_party/tjs2/source.json`。

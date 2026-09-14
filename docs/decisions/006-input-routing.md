# 输入、焦点与脚本回调

输入语义由 `src/engine/input/` 的 TypeScript 控制器负责；DOM 事件与文字输入由 `src/backends/input/browser.ts` 适配。TJS2 VM 继续执行游戏事件处理函数。引擎不依赖 DOM，也不通过同步跨线程调用读取页面状态。

## 事件经过的边界

```text
浏览器鼠标 / Pointer Events / 键盘 / textarea
  → InputPacket，经会话 RPC 保序传递
  → EngineSession 的 VM 执行队列
  → InputController，计算窗口事件、命中、捕获和焦点变化
  → InputService，将生成器的下一步转换为 TJS 对象和参数
  → TJS 输入 trampoline，调用 Window / Layer 事件
  → 返回控制器继续处理
```

脚本在事件中改变层次、隐藏图层、切换焦点或取消捕获时，后续步骤读取更新后的引擎状态。宿主返回 `invoke`，由 WASM 内部执行 trampoline，避免从 JavaScript 宿主导入重入正在运行的 VM。每个嵌套操作都有独立 token，异常会退出相应生成器并释放焦点锁。

物理按键集合经独立 RPC 更新，`System.getKeyState` 读取当前集合。排队较久的按键回调不能把已经松开的键重新标为按下。`Window.postInputEvent` 使用 VM 队列投递异步按键事件，不修改物理按键集合；旧窗口被销毁后，其待处理事件不会交给新窗口。接口依据 [Window.postInputEvent](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Window_postInputEvent.html)。

## 图层规则

- 窗口回调先执行，再向图层分发；重写窗口回调不要求调用 `super` 才能让图层收到事件。
- 图层按前到后检查可见范围和 mask/province。像素命中后才调用 `onHitTest`，脚本通过 superclass 的第三个参数否决命中。禁用图层的有效命中会挡住下层。依据 [Layer.onHitTest](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Layer_onHitTest.html) 和参考实现的 `GetMostFrontChildAt`。
- 图层 opacity 不决定是否能命中；province 命中要求非零省份像素，不受 mask 的 hitThreshold 控制。
- 鼠标按下后捕获目标；拖动与抬起继续交给捕获层。普通点击要求抬起位置仍命中捕获层，避免拖到另一个控件时误点。
- 焦点先执行 `onBeforeFocus`，允许重定向，再依次执行旧层 `onBlur` 和新层 `onFocus`。后两个回调中再次切换焦点会报错；异常不永久锁住焦点。
- Tab/方向键默认行为遍历 focus chain；隐藏、禁用或分离当前焦点层会重新寻找有效目标。
- 模态栈参与 nodeEnabled、命中与焦点判断；setMode/removeMode 的焦点选择与启用通知顺序按已检查的参考 LayerManager 实现处理。
- 触摸捕获按 contact ID 分开，`releaseTouchCapture` 只释放对应接触点。

## 页面适配

浏览器通过 Pointer Events 捕获鼠标和触摸。单指操作同时产生原始触摸与一次兼容鼠标操作，使已有 KAG 点击处理可继续使用；第二指加入会取消兼容点击。移动事件可合并，按下/抬起和文字提交保持顺序。

游戏画布关联一个透明 textarea，用于接收已提交的文字。composition 期间不分发中间文本，结束后提交一次；键盘事件保留虚拟键、修饰键和重复状态。菜单快捷键在事件捕获阶段识别，允许来自游戏 textarea 的快捷键，同时避开页面普通输入框。命中的快捷键不会再分发为游戏 keyDown。

光标和 hint 从当前悬停层更新；字体候选位置按焦点层的 attention 坐标转换到页面。会话停止移除 textarea、DOM 监听器和待发送事件。

## 验证与未完成项

6 项真实 TJS 集成测试覆盖焦点对象身份、before-focus 重定向、锁恢复、模态/隐藏处理、拖拽、禁用遮挡、脚本命中、province、异步按键和独立触摸捕获。三种浏览器、两种 WASM 后端验证拖动、Tab、物理键状态、提交文字、合成输入、单指点击及清理，另保留原有菜单快捷键回归。

测试中的 composition 事件为浏览器内构造的事件，不等于已经验证所有操作系统输入法；触摸点击使用 Playwright 的浏览器触摸输入。尚未实现旋转/缩放手势、完整 IME 模式、光标资源、系统连续事件和多窗口输入。所有图像/几何变动引起的悬停重算、异常中的原生通知顺序及任意嵌套回调仍需扩大差分验证。Layer 对象目前由宿主保留，隐式回收语义不能以显式 invalidate 测试替代。

参考 KAG 模板已在浏览器显示首段文字；`tests/probes/kag-browser.ts` 会保留最终状态、日志和截图。带 `flow` 参数的探测另载入本项目的 `tests/fixtures/kag-input.ks`，使用参考模板的原有 KAG 脚本执行输入流程。Chromium、Firefox、WebKit 的 Asyncify/JSPI 六种组合都完成了换行、历史层打开/关闭、翻页、文字链接与目标标签验证。KAG 会读取物理按键状态过滤过期事件，因此按键测试在处理完成后才松开按键。该探测不随应用分发参考游戏资源，也不代表完整游戏兼容。

# Debug 调试面板与页面控制

原 KAG 的 Debug 菜单通过 `Debug.console.visible` 与 `Debug.controller.visible` 打开调试窗口。此前这些对象不存在，菜单回调会抛错。本阶段提供稳定、只读的对象入口，并把它们接到实际 HTML 面板。

## 对象与状态

`Debug.console` 与 `Debug.controller` 分别保持同一对象身份，提供可读写的 `visible` 属性；不能通过给 Debug 属性赋值替换对象，也不暴露全局 Console/Controller 构造器。属性值在 TJS 内按原有布尔转换处理。隐藏界面不清空历史、不停止文件日志，也不暂停游戏。

`engine/diagnostics/panels.ts` 管理两个独立的布尔状态；TJS 属性、浏览器按钮和会话快照都使用这一份状态。读取快照得到副本。相同值不重复发送状态更新。每个新会话独立创建对象与状态；本项目默认显示两个面板，沿用 Web 调试界面的默认布局，不复刻 Windows 对话框的初始显示偏好。

Console 对应运行记录、清空按钮和 TJS 表达式输入。Controller 对应运行信息及暂停、重新开始、停止、显示恢复控制。游戏画面下方始终保留两个重新打开按钮，它们不属于可隐藏的控制区；即使启动脚本处于可让出的长循环，也能打开控制区并停止会话。

页面操作通过独立 RPC 更新引擎状态，不排队等待被暂停的 VM。RPC 返回完整快照，页面按会话 generation 和快照 revision 拒绝过期结果。暂停与失败状态仍允许打开面板；重新载入游戏后使用新会话状态。隐藏当前操作所在的面板时把焦点移到重新打开按钮。手动隐藏和表达式提交显式管理焦点，避免 WebKit 点击按钮时未获得焦点导致操作位置丢失。

## 平台边界

会话快照增加 `debug`，RPC 增加 `setDebugVisibility`，因此会话协议从 **8 升到 9**。TJS WASM ABI **2**、字体 ABI **2** 及其所有发布字节保持不变。运行时、脚本对象和显示状态都留在现有 TypeScript/TJS 边界内，没有新增原生库。

Web 的 Controller 是页面内控制区；它不会移动操作系统窗口。Console 和 Controller 独立显示，与原生两个窗口的独立开关一致。原生错误 UI 自动打开策略、完整 VM `iTJSConsoleOutput` 入口、`Scripts.dump` 及所有异常/析构路径仍需后续实现；本阶段不表示 Debug 或非插件目标整体完成。

更细的对象语义仍有已知差异：原 `DebugImpl.cpp` 返回原生类对象，`tTJSNativeClass` 的 `IsInstanceOf` 同时识别 Class 和自身类名，且有 `CreateNew`/静态成员复制规则。当前 TJS 适配器使用实例承载显示属性，因此 Class 身份、通过 Debug 属性进行构造和静态成员语义尚未对齐。文档中的“无全局构造器”不能作为这些行为等同的证据；后续原生桥阶段必须补齐，现有对象身份测试也需随之修正。

## 验证

新增 Node 集成检查稳定身份、只读入口、无公开构造器、TJS 布尔转换、暂停中的浏览器更新、快照副本、失败后打开和新会话隔离。浏览器检查脚本/页面双向更新、焦点、隐藏期间日志、暂停、替换游戏、失败诊断和长循环停止。

原 KAG 专项直接使用模板的 `Menus.tjs` 与 `MainWindow.tjs`。测试只打开模板中现有的 Debug 菜单项可见/可用开关，实际点击原菜单并使用 Shift+F4/Shift+F1；没有替换菜单回调。三浏览器双后端共 6 项已通过，截图在 `out/verification/debug-panels/kag-panels/`。

WebKit 初次专项检查的两次焦点失败保存在 `out/verification/debug-panels/focus-before/`。修正后原来的严格焦点断言保留，12 项显示/长循环专项通过。最终 `npm run check` 通过 **331 项行为/集成与 579 项浏览器测试**（462 常规、57 游戏库、53 PWA、7 原生生命周期），无失败或跳过；原生 trusted 冻结实测 **21,055.2 ms**。权威日志为 `out/verification/debug-panels/check.log`。最终构建另通过 **36 项原 KAG 综合场景、6 项调试菜单/快捷键、6 项 TJS 跨 ABI、6 项字体跨 ABI 和 6 项协议 8→9 离线升级检查**。110 份持久 context 记录保留独立的 30 秒准备/清理与 30 秒正文预算，四套浏览器配置和媒体断言保持不变。

`out/verification/debug-panels-matrix.json` 绑定源码、测试、文档、发布字节、历史失败和外部探测；`out/verification/debug-panels/reverification.json` 记录独立哈希复核。保留的协议 8 发布目录与前一 Debug 阶段构建逐字节一致，离线时旧、新页面分别启动自己的 Worker。

第一轮完整回归中，后台切回后的输入法检查有一次控制台求值返回 false，其余 461 项常规浏览器检查通过。该 trace 没有记录 TJS 收到字符的时刻，无法仅凭一次读取确认字符丢失；增加实际 `onKeyPress` 日志后，12 次原时序复测均通过。浏览器输入与控制台求值经过不同队列，测试现先等 TJS 回调确认，再保留原来的字符、物理按键和误点击断言。没有修改生产输入实现，也不把未复现的原失败称为已定位的产品缺陷；原日志、trace 和复测记录在 `input-before/`。

参考：[Debug.console](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_console.html)、[Debug.controller](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Debug_controller.html)、[Console](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Console.html)、[原 KRKR2 DebugImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/utils/win32/DebugImpl.cpp)。原生源码保留在前一 Debug 阶段的参考目录；本地参考 fork 的注释空实现未作为行为实现依据。

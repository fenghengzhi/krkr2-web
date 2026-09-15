# 058：System 消息与文字输入对话框

本阶段把 `System.inform` 的日志占位改为真实消息对话框，并实现 `System.inputString`。脚本在调用处等待结果，同一 TJS 栈上的模态事件循环继续处理计时器和事件。代码与测试正在实现，尚无本阶段 Actions 通过结果；没有运行本地构建、测试、类型检查或浏览器探针。

## 原版合同

参考固定官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable。原始文件和 SDK 文档保存在 `out/verification/system-dialog/reference/`，哈希见其中 `source-manifest.json`。

- [SystemImpl.cpp:611](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L611)：`inform` 至少一个参数，标题省略或为 `void` 时默认 `Information`，显式空字符串保留，返回 `void`。SDK 手册写标题默认空字符串，与实际绑定有差异；这里采用实际绑定。
- [SystemIntf.cpp:123](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/SystemIntf.cpp#L123)：`inputString` 至少三个参数，分别为标题、提示与初值。确认返回字符串，空字符串也属于确认；取消返回 `void`。显式传入 `void` 满足参数数量要求，经 TJS 字符串转换得到空字符串。
- [SystemImpl.cpp:43](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp#L43)：两条平台路径分别调用 Win32 MessageBox 和 VCL InputQuery，没有事件禁用包装。[EventIntf.cpp:561](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/EventIntf.cpp#L561) 的事件投递没有总递归锁，MainForm 的 SystemWatchTimer 仍可投递事件。因此不能把对话框等待实现为全局暂停脚本事件。

参数转换在 TJS 中执行，保留 `ttstr` 的格式与转换错误，不使用 JavaScript `String` 替代。原版平台 UI 经过 ANSI 编码；Web 对话框保留 Unicode，不复刻代码页丢失。源码支持事件重入，但不证明两个原版模态泵具有相同的计时器频率、全部输入消息或焦点细节；原版托管 Windows 观测另行保存，不能用 Web 测试代替。

## 模态与宿主分工

`SystemDialogs` 只保留基本值、调用身份和单调请求 ID。请求里的临时 TJS 对象由挂起的调用者持有；宿主不额外保留脚本对象。UI 回应只能选择当前顶层请求的首次结果，结果在它自己的模态等待边界结束。子 Window 或子对话框必须先完成，父调用才恢复。打开期间发布失败、原生释放失败和 Stop 都有独立清理路径。

会话协议升级为 **12**。`system-dialog` 事件包含当前可交互请求及全部仍存活的请求 ID；UI 可区分暂时被子窗口遮挡与真正退休，保留父输入框的编辑内容与选择范围。`selectSystemDialog` 直接接收宿主结果，不排到已经被模态调用占用的 VM 队列之后。旧请求、重复结果、旧会话、暂停、页面不可见及字体选择期间的结果不会完成当前请求。

Window 输入阻塞按模态栈从顶向下决定：System 对话框阻塞游戏 Window，较新的模态 Window 可以接收自身输入，菜单不覆盖这一关系。进入 System 对话框会取消旧窗口输入、释放捕获并结束旧弹出菜单；计时器、脚本事件与媒体不因此全局暂停。已有事件禁用和页面生命周期规则继续生效。

浏览器使用原生 HTML dialog、真实表单控件和文字节点，支持确认、取消、键盘和输入法，并提供对话框内的停止游戏入口。焦点只恢复到仍存在、可见且可交互的目标。应用按会话 generation 隔离对话框，停止或重启会清除旧 DOM 和编辑记录。

## 验证边界

新增纯状态机、真实 TJS 源码／字节码及三浏览器 Asyncify／JSPI 用例，分别检查请求与 LIFO 生命周期、参数和返回值、Timer 重入、嵌套 Window／对话框、实际文字编辑与停止。所有可执行验证只在 GitHub-hosted Actions 进行；结果完成后按精确提交与构建记录。

本阶段不实现 Clipboard、Pad、整个 System 原生类身份、任意操作系统命令或插件。原生对话框 owner、ANSI、VCL 焦点及全部消息细节有平台差异。完整非插件目标仍在推进，不能凭这两项 API 宣称完成。

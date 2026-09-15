# 051 — 同一会话中的多个窗口

状态：实现接线完成，等待 GitHub-hosted Actions 的类型检查、构建和回归。当前主分支已验证范围仍见阶段 050；本文件不得当作多窗口已经通过的证据。

## 结构

保留一个 Worker、TJS VM、系统事件队列与音频混音器。Window 登记、mainWindow 和当前活动窗口分开管理；每个 Window 分别拥有 Layer 输入控制器、菜单根、视频显示平面和 OffscreenCanvas Renderer。页面内窗口宿主提供标题、拖动、大小调整及全屏协调。

画布通过独立 MessagePort 动态连接，以 generation、windowId、surfaceEpoch 标识生命周期。首次连接和第一帧之前使用 restoring/pending 状态，不暂停其他窗口的脚本或媒体。真正的图形故障及恢复仍沿用会话整体暂停策略；晚到的连接、输入、菜单选择和视频请求不能重新建立已关闭窗口。

脚本 close 销毁指定窗口。用户关闭主窗口会销毁，用户关闭普通窗口则隐藏；onCloseQuery 可拒绝。System.exitOnWindowClose 默认为 true，主窗口开始原生失效后，在当前 VM 操作结束时请求退出。设置 false 可继续运行其他窗口；关闭主窗口不会把现有普通窗口提升为 mainWindow，所有已登记窗口关闭后新建的窗口才成为新的主窗口。原生依据见 [048](048-multiwindow-plan.md)。

程序关闭的查询默认允许。用户关闭具有独立的待答复状态，等待期间重复关闭请求和脚本 close 不再次查询；调用基类 onCloseQuery 才提交允许或拒绝，可以延后答复。该规则同时见于[官方 Kirikiroid2 Cocos 路径](https://github.com/zeas2/Kirikiroid2/blob/d1c2b1259423542c893e0b65eaeb46c848848f2b/src/core/environ/cocos2d/MainScene.cpp#L1280-L1367)和[原 krkr2 2.32stable](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp#L400-L506)。

## Actions 记录

[首轮 Node 诊断 34935450884](https://github.com/fenghengzhi/krkr2-web/actions/runs/34935450884)，提交 `4ac589f`：原生内核构建完成，应用类型检查因遗留的未使用单窗 pointer 字段失败（TS6133）。Node、浏览器和直接运行时测试均未运行，不能计为通过。完整日志和 run.json 已保存在 `out/verification/github-actions/34935450884/`。修订删除该旧字段，保留每个窗口独立的 physical pointer。

[第二轮 Node 诊断 34935871336](https://github.com/fenghengzhi/krkr2-web/actions/runs/34935871336)，提交 `ae3abe0`：应用与 Worker 类型检查通过后，测试类型检查发现三处错误：输入包判别联合缺少 key 字段收窄，以及两个测试生成器缺少返回值。Node 和浏览器案例仍未运行；本轮完整日志单独归档。修订只完善测试类型，不放宽行为断言。

[第三轮 Node 诊断 34936005894](https://github.com/fenghengzhi/krkr2-web/actions/runs/34936005894)，提交 `36316b7`：类型检查及生产构建通过；Node **1,286 项中 1,276 通过、10 失败、零取消／跳过**。失败分为：1 项虚拟鼠标键被测试输入的零 shift 清掉、2 项旧 blur 寿命场景关闭主窗口后继续求值、4 项菜单寿命基线差异（scriptObjects 1007 对 982，其余所有权计数为零）、1 项旧 Renderer 测试假设每次帧都有 Layer、2 项新视频测试调用不存在的 getPixel。完整测试日志、TAP、构建和 run.json 单独保留在该 run 的归档中；浏览器和直接运行时未运行。

菜单基线的 25 个对象来自首次 `TJSCreateArrayObject` 创建的原生 static Array 类：类本身、构造器、21 个方法和 2 个属性（`third_party/tjs2/tjsArray.cpp`）。新的自动激活通过 InputService 的 `scriptList` 触发 `native/tjs2/bridge.cpp` 的容器创建，旧夹具只初始化脚本 global.Array。修订使用既有 Debug.getLastLog 的原生 varargs 路径提前初始化该共享类，保留所有精确计数断言，并新增源码／字节码各三轮可见窗口、真实激活与菜单清理检查。其余修订保留原像素、alpha、焦点和生命周期预期，不把未运行测试或本轮失败改写为通过。

## 验证范围和边界

新增单元、源码／字节码集成及浏览器场景覆盖窗口身份、动态画布、渲染隔离、输入队列与物理按键、菜单选择身份、视频路由及关闭清理。旧寿命测试仅在有意关闭主窗口后继续检查清理结果的路径明确设置 exitOnWindowClose=false，默认退出行为另有独立用例。

所有执行验证仅在 GitHub-hosted Actions；本地仅源码编辑、阅读与格式化。待运行、失败、取消和未报告的案例均不计为通过，历史验证记录继续保留。

当前窗口宿主是同一页面内的桌面，单一初始窗口保留响应式嵌入布局。浏览器独立 popup、Window.showModal 的原生嵌套消息循环以及完整非插件能力尚未完成，不能凭本阶段实现声明完整商业游戏兼容。

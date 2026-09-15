# 047 — Window.mainWindow 的实例查询

本实现已随组合版本 `f1f6a3d` 通过[完整回归 34931803098](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931803098)：14 个作业全部成功，**1,118 项 Node、846 项浏览器和 6 组直接运行时**通过，所选测试零失败、取消、跳过、flaky 或重试。该结果同时覆盖阶段 047、049 与 050；不覆盖独立分支中尚未验证的 051 多窗口实现。

[兼容检查 34931188627](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931188627) 在 `54ecd16` 使用[构建 34931093453](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931093453)的精确产物通过 78 项。该提交至 `f1f6a3d` 的应用、原生源码、依赖和构建配置没有差异；这是同应用源码的兼容证据，未重跑最终完整回归的构建。历史页面崩溃和 Node 诊断失败仍按下文保留。

`Window.mainWindow` 返回实际主窗口对象或 null，替代固定的 true。它是与接收者无关的类级查询：创建窗口之前为 null，派生类实例创建成功后返回该实例，隐藏窗口不会改变身份。类、派生类和实例都可以读取；属性没有 setter，普通赋值会被 TJS 拒绝。

原生 [mainWindow getter](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L1604-L1623)从 TVPMainWindow 取得 owner，返回以该 owner 为接收者的对象闭包。源码注释将其称为 static，但通过普通属性注册宏安装，因此本阶段保留类与实例的访问形式。现有 TJS 类属性机制已经支持这两种访问，无需引入额外原生类或修改 WASM ABI。

WindowService 的 `main` 从已有活动窗口记录返回 ScriptWeakObject；登记本身不持有窗口。宿主桥将观察令牌还原为正常 TJS 对象值，不创建额外的长期宿主句柄。脚本保存查询结果时产生普通强引用；临时结果在求值显示、丢弃和 collect 后释放。保存从 Window 类取得的属性引用只保存查询方法，不保存当时返回的 Window。

生命周期采用已有阶段 042 的登记边界：

| 时点                                  | mainWindow                               |
| ------------------------------------- | ---------------------------------------- |
| 成功构造并登记                        | 实际 Window／派生实例                    |
| 隐藏窗口或直接调用 finalize 方法      | 保持登记                                 |
| 脚本 finalizer 抛错，尚未进入原生清理 | 保持原窗口，允许重试                     |
| 原生 invalidate 开始                  | 立即撤销登记，先于媒体等待和托管对象清理 |
| 托管对象清理期间创建替代窗口          | 指向替代窗口；旧窗口 finish 不撤销它     |
| 原生清理失败后的重试                  | 不恢复已经撤销的旧登记                   |
| 构造回滚、最后引用释放、会话终止      | 撤销相应登记                             |

这些顺序依据 [窗口列表登记／撤销](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L33-L70)和 [Invalidate 首先注销窗口](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp#L181-L205)。清理中的旧对象仍可能因脚本引用而存活，但不能重新成为主窗口。

当前仍只允许一个活动 Window。第二个活动实例的构造保持原有错误；已进入清理的旧记录和新的活动实例可以短暂并存。该查询修正没有实现多窗口显示、焦点分发或原生操作系统窗口策略，完整非插件目标仍在进行。

新增 `tests/integration/window-main-window.test.ts` 的源码／字节码用例，验证身份、只读、查询引用的释放、失败重试、构造回滚和替代窗口。`tests/browser/window-main-window.spec.ts` 在双后端源码／字节码组合中覆盖实际会话的身份、弱引用与清理时序。

首轮 [Node diagnostic 34929268155](https://github.com/fenghengzhi/krkr2-web/actions/runs/34929268155) 的构建和类型检查通过，1,065 项测试中 1,063 项通过、2 项失败，没有取消或跳过。失败来自新增测试：TJS 全局槽位读取会自动调用存储的属性 getter，`*mainAccessor` 因而对已经返回的 null 再解引用。测试改用 `*(&global.mainAccessor)`，并增加局部寄存器访问器及隐式／显式只读写入对照；弱引用、替代窗口和回收断言保留。失败记录及完整产物已归档，后续重跑记录如下。

本地仅阅读、编辑与格式化；所有构建、类型检查、测试和可执行探针由 GitHub-hosted Actions 执行。其他阶段的历史结果不代替本实现的验证，当前组合版本的证据见本文开头。

后续 [Node diagnostic 34930018485](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930018485) 的 1,065 项测试通过。[完整回归 34930203580](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930203580) 使用提交 `60737a26e78830456f2b07c77a05b7eba57e8aa1`，Node 1,065 项和 6 项 direct runtime 通过，浏览器为 821/822（含 7 项原生活动检查）；新增 Window 查询测试全部通过，完整回归仍是失败结果。

唯一失败是 WebKit JSPI 的既有 `player.spec.ts` 示例场景。该作业使用一个 worker、Playwright 1.63.0、WebKit 26.6/build 2359 和 GitHub-hosted macOS 15 ARM64。测试在 2026-09-15 04:55:03.062 UTC 开始，能力检查返回 JSPI 与 WebGL2 可用；点击“运行示例”后约 164ms，页面在首次“会话就绪”之前报告 `Page crashed`，尚未进入输入、暂停、停止或重启步骤。网络 trace 保存了成功返回的 Worker、manifest、JSPI 模块和 WASM；这些信息不能确定崩溃的原生执行位置。浏览器启动进程随后在失败后的清理中正常退出，也不能据此判断页面崩溃原因。

本次完整产物及失败日志已独立保留。它们没有 macOS `.ips`／`.crash` 报告，因为原工作流没有收集 `DiagnosticReports`；目前没有该次原生堆栈可以归因。此事件不与历史 WebKit 崩溃合并判断。`webkit-diagnostic.yml` 新增 `player-restart` 场景，复用匹配的原构建，在 hosted Mac 上对原测试的两个后端各重复 10 次，保留 JSON、浏览器／协议日志及运行标记之后新生成的原生崩溃报告。

[原场景重复诊断 34931403366](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931403366) 在 `9f4bdc4` 使用构建 `34930203580` 的精确产物，通过全部 **20 次**。原生崩溃收集 manifest 为 `reports: []`、`errors: []`：没有收到新报告，也没有记录收集错误。该重复结果和最终组合回归均不能证明原 Page crashed 的根因已定位或修复；首次完整回归仍为失败，原始材料继续保存。

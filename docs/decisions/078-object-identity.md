# 078 — 原生对象身份观察与首次 down 自失效捕获

状态：实施候选，尚无本批执行结果。以下数量是已定义的验收库存，不是通过数。构建、类型检查、测试、浏览器操作与可执行诊断只在 GitHub-hosted Actions 运行；本地只编辑与静态审查。批量提交后，下次工作时取回固定 run 和 artifacts，不实时监控。

整体目标仍是可实际运行原 KAG 游戏的非插件模拟器。此切片补齐一个原生所有权缺口，并修复同批确认的字符串自追加缺陷；不代表其他兼容差异或整体目标已经完成。077 的执行结果另行回收，不在本文推断。

## 问题与固定依据

077 保留了首次 `onMouseDown` 回调 self-invalidate 后新建 capture 的缺口：原版先保存命中 Layer 的裸指针，回调正常结束后仍可能取得尚未析构的 invalid Owner；Web 的 LayerTree 与资源 weak 注册已经退休，无法从原有弱引用重新取得它。延长所有 callback 临时强引用会改变 drop-last-reference 行为，因此不能用来替代正确的对象身份观察。

固定原版为 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 2.32stable 分支。原字节与 SHA-256 清单位于 `out/verification/custom-cursor/source/manifest.json`，逐项审计保存在 [077 身份缺口记录](../../out/verification/mouse-manager/invalid-owner-identity-audit.md)。主要依据是：

- `LayerManager.cpp:356–379` 的 PrimaryMouseDown 在目标回调后采样 `ReleaseCaptureCalled`，先释放不同的旧 capture，再写入新槽并 `Owner->AddRef()`；没有回调后重新命中。
- `LayerManager.cpp:551–563` 的 ReleaseCapture 先清空槽，再 Release Owner，允许终结器观察旧槽已空。
- `LayerIntf.cpp:455–508` 的 Invalidate 先置 Shutdown、释放并清空 Manager，随后 Part；Owner 未清空。非 primary 的 Part 因 Manager 已为空而不触发 NotifyPart，父 SeverChild 也不代替 ReleaseCapture。
- FireMouse* 仍按 Shutdown 抑制事件。能保有 invalid Owner 的身份，不等于重新开放已失效对象的方法、成员或资源。

原版裸指针不构成恢复已析构对象的依据。此实现仅能取得仍存在的对象；一旦实际删除已经确定，所有身份必须先失效。

## 独立身份与资源 weak

新增 `ScriptObjectIdentity` 和原生 `tTJSObjectIdentityObserver`，与 039 的资源观察分开。资源 `ScriptWeakObject` 仍在成功 script/native invalidate 的资源边界过期；`LayerService.finish()` 仍删除 tree 注册并撤销资源 token。没有移动其通知时机，也没有修改 Timer、事件源等服务的弱引用语义。

身份观察不 AddRef，不保存 host 强句柄，不占 native-instance 槽。对象显式 invalidate 后，只要普通脚本引用或既有 VM ownership 仍持有实例，身份继续存在。`tTJSDispatch::Release()` 执行 BeforeDestruction 后检查剩余引用：合法 finalize 复活增加真实引用时保留身份；确定 delete 时先关闭身份链再析构。custom-object 和基类析构入口提供兜底，深层释放队列在仍拥有最终引用时不提前关闭身份。

关闭先把对象身份标记为不可升级，再逐个 unlink observer 和发通知；通知可以撤销自身或其他 token，不能执行 TJS 或释放被观察对象。原生先清空记录中的 owner 指针，runtime 再清除元数据。VM dispose 在释放根对象前撤销全部身份。token 带 runtime 身份，在单 VM 内不复用，最多同时存在 4,096 个；跨 VM 使用被拒绝，分配失败或预算耗尽是明确异常，不能当成对象已死亡。

接口包括 `observeIdentity`、`identityAlive`、`unobserveIdentity` 与显式 `upgradeIdentity`。观察可来自仍有效的资源 weak 或仍存在的强对象；已经失效的资源 weak 不能生成新身份。函数、原生类、绑定到不同 this 的闭包和已释放 host handle 不是可观察实例。升级取得独立强句柄时调用者必须释放；输入路径直接把 descriptor 写入 native reply，避免额外 host 句柄。过期 descriptor 写成 script null，仍存在的 invalid descriptor 写成同一 closure，但不恢复对象有效性。

**TJS ABI 保持 5，字体 ABI 保持 2，会话协议保持 25；manifest 新增必需能力 `objectIdentity: 1`。** 生产 loader 缺失能力时拒绝启动，runtime 同时检查实际 identity exports，禁止旧 WASM 静默退回原资源 weak。HostContext 的可选接口仅兼容明确不建模原生身份的低层测试适配器；真实 Runtime 必须实现完整接口。

## Input ownership 提交与清理

InputService 在实际解析 Layer.onMouseDown callback 时，从有效资源 weak 建立本次 operation 的身份观察。身份元数据不拥有对象，callback 的 target/args 仍在原 `__krkrInputClearStep` 时点释放。若 callback 删除最后一个实际引用，对象按原时点终结，后续身份已过期，不能新增 capture。

回调结束后，仍在 tree 中的目标沿原 ownership 路径获取；tree 已退休的目标通过本 operation 的 identity descriptor 获取。流程为：释放旧 capture → 检查 Window/controller 代际 → 将仍存在的对象写入 VM ownership Dictionary → TJS 回传实际非 null 赋值的 ACK → controller 提交数值 capture。这样 native reply 返回 null 时不会留下非零数值槽。释放队列插入 ACK 与 generator 恢复之间时，ACK 保存在 operation 记录中，直到真正恢复才消费。

候选 acquisition 先登记可清理的 ownership 元数据。过期、赋值异常、未确认便 unwind 或 Window 退休时，finally 释放候选槽；releaseCapture 和抛异常的 down 不执行成功获取。operation 正常完成、guard 取消、异常展开与 dispose 都撤销身份 token。已提交的 capture 是 VM 正当强引用，其存活不依赖 operation token；`inspectOwnership().objectIdentities` 应在每次完成的输入后回到零。

077 已实现的“先有 capture 再 invalidate”继续通过既有 capture 槽向 hover 复制同一引用。Shutdown 对象不派发事件，也不把捕获输入改投给下层。成功 up、显式 releaseCapture、Window 退休及 Stop 按原清理路径释放这些角色。

## 同批字符串 Append 修复

`third_party/tjs2/tjsVariantString.h` 的旧 Append 对 `value += value` 等别名输入不安全。短字符串用 strcpy 向自身尾部复制，会覆盖源 NUL 后继续读取；长字符串 realloc 移动缓冲区后，原 source 指针可能已失效。旧实现还在分配前更新 Length，分配失败会留下错误长度。

修订使用已知追加长度和 memmove，在复制后写终止符；长字符串内部 source 先保存偏移，realloc 后从新缓冲区重新定位；短转长在旧内容仍有效时完成复制。追加长度检查保留终止符的 tjs_int 空间并拒绝负数或加法溢出，只有分配和复制成功后才发布新 Length。既有共享字符串的复制语义保持不变。此检查不等于已完成底层字符串分配器所有容量扩展与字节数计算的极限值审计。

验证分成两层，均尚待本批 Actions：原生 `tests/native/string-append.cpp` 直接包含交付的 inline 实现，在 ASAN/UBSAN 下强制每次长缓冲重分配移动地址，并注入分配失败；WASM `tests/conformance/string-append.test.ts` 通过真实 Session 分别执行 source 与 native bytecode，覆盖短字符串、短转长、共享值、Unicode 和大规模重复追加。这些用例不把探测分配器加入正式内核，也不以单个输出正确代替内存检查。

## 待运行覆盖与诊断矩阵

| 入口 | 当前定义与目的 |
| --- | --- |
| `tests/conformance/object-identity.test.ts` / `tests/helpers/object-identity.ts` | 11 场景 × source/bytecode × debug on/off，共 44 个 Node Asyncify 定义。覆盖显式失效、隐式析构、撤销、通知重入、finalize 复活/异常、部分构造、深层释放、非法观察、VM 隔离和销毁；比较 handles、资源 weak、身份、scriptObjects 与待释放句柄基线。 |
| `tests/probes/vm-runtime-entry.ts` | 复用相同 11 场景；每个 backend/browser runtime 组合执行 44 次。Asyncify 与 JSPI 走各自真实 WASM，JSPI 不支持时按既有能力条件记录跳过，不能计为通过。 |
| `tests/conformance/mouse-capture-lifetime.test.ts` | 保留 077 的 6 个定义，新增 6 场景 × source/bytecode 共 12 个真实 Session 定义，总计 18。新场景覆盖外部仍持有的 self-invalidate、drop-last-reference、releaseCapture、异常恢复、Window 退休和 callback 挂起期间 Stop；正常输入后身份为零，挂起中的当前 operation 可观察到一个身份。 |
| `tests/browser/object-identity.spec.ts` | 2 backend × 2 场景，共 4 个定义；每个浏览器执行。能力干预先删除 objectIdentity 并确认 loader 拒绝及旧 Worker 关闭，再原字节恢复 manifest；真实 DOM 场景分别重启 source/bytecode，鼠标 down 自失效、键盘删除外部引用、拖动不触下层、up 后恢复下层 enter/move/down/up。 |
| `tests/probes/object-identity-allocations.ts` / `.github/workflows/object-identity-allocations.yml` | 两 backend、source/bytecode、debug on/off；对 handle/资源 weak 观察与 live/invalid 升级四类操作，从无故障控制开始逐分配点扫描，直到首次无命中，最多 128 点。另测 4,096 token 预算、撤销与重试。实际注入数由运行证据决定，不提前宣称固定通过数。 |
| `tests/native/string-append.cpp` | GitHub-hosted Ubuntu 使用 `-fsanitize=address,undefined` 编译交付 header；覆盖短/长/子串别名、强制搬移、分配失败后内容/地址/长度不变、负长度拒绝和大重复，最终分配账本为空。 |
| `tests/conformance/string-append.test.ts` | 2 个真实 Session 定义，source 与 bytecode 均检查内容、长度、共享值和后续 VM 可执行性，并在 Stop 后检查资源回收。 |

identity allocator 工作流使用独立诊断构建，记录源码 commit/run、probe SHA-256、完整 manifest、WASM/模块实际 hash、失败位置、注入命中、分配栈与前后账本；每行先写进行状态，再写结果，取消或中断不能缺省为成功。失败路径须在重试和最终 VM disposal 后回到对应控制基线；正式内核不带故障分配器。

浏览器拖动负断言以实际 Window callback log 后的 state 序号作为呈现边界，不靠任意等待。manifest 恢复再次从真实端点取回原 bytes 并核对 hash，恢复响应直接使用原 body。source/bytecode 的输入、捕获与清理都通过真实 Worker/MessagePort/DOM 路径，未将这些断言替换为直接调用 controller。

## 历史结果与剩余范围

076 的固定归档已确认整轮和 Node 作业最终为 **cancelled**。Node reporter 未自然完成；已记录的 2,613 个用例事件中 2,606 个通过、7 个失败，是取消时的局部事件账本，不能写成整套测试通过率或完成数。最终 API 快照、artifact 清单、journal 摘要与原 ZIP 保存在 `out/verification/github-actions/37231345437/`；原先 partial 快照继续保留。

其中 selector bounded(source) 的 journal 显示 call 115 execute 先报 `RuntimeError: memory access out of bounds`，call 117 dispose 随后开始但未返回，进程持续至作业取消。固定 877 字符 source 保存为 `selector-bounded-source.tjs`，其中 repeat 的 `value += value` 与上述可静态证明的 Append 别名缺陷吻合。本批修订尚未执行，不能据此宣称 Node 挂起已被运行证明修复；独立的 layer-neutral-color SIGTRAP/V8 回收栈、其他历史 SIGABRT 及浏览器失败不能归为同一个根因，也不能被后续成功追认为通过。

自定义 CUR/ANI cursor 的解析、热点、动画、AND/XOR 背景运算与资源生命周期仍未完成；077 记录的 click/操作系统入口及其他边界也继续保留。新身份机制专门补齐仍存活的 invalid Owner 获取，不模拟悬空裸指针，不开放失效资源，也不构成整个非插件模拟器完成的证据。执行结论待实际回收本批固定 run/artifacts 后补充。

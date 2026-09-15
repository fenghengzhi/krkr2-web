# 062：System 原生类、虚拟路径与 Web UUID

本阶段将 System 从 Dictionary 改为真正的 TJS native class，补上 UUID、只读路径与版本信息，以及一次初始化的相对存档目录配置。实现仍以 TypeScript 和 Web API 为主；原生边界只负责 TJS 类、静态成员、调用和引用语义。

状态：实现已进入 GitHub-hosted Actions，**首轮组合构建在类型检查失败，普通测试尚未执行，也未验证通过**，详见文末的原始运行记录与修订。没有在本地执行测试、构建、类型检查、浏览器或 VM 探针。此前阶段通过和失败记录保持原样，不能作为这些新改动的通过证据。

## 原版依据与范围

固定依据是 [krkrz/krkr2 的 2.32stable SystemIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/SystemIntf.cpp) 与 [SystemImpl.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SystemImpl.cpp)。原始注册包含 21 个静态方法、23 个静态属性、3 个普通回调槽及 constructor/finalize；这份清单不是本阶段完成全部 System 功能的声明。

本地静态合同、原文及逐文件 SHA-256 保存在 `out/verification/system-core/`。类语义同时核对固定原版的 tjsNative/tjsObject/tjsDictionary；当前工程实际 vendored TJS 版本通过加载的 native 常量取得，不能用固定 SDK 版本替代。

## 类与静态成员

System 现在具有 Class/System/Object 身份。原生工厂拒绝实例创建，包括派生类的实例初始化；`System.System(...)` 和 `System.finalize(...)` 仍为空方法。`exceptionHandler`、`onActivate`、`onDeactivate` 为普通可写成员，初值均为 null。

13 个已有方法通过真正的 native static method 委托继续执行 TJS 函数体；`eventDisabled`、`graphicCacheLimit`、`exitOnWindowClose`、`title` 通过 native static property 委托执行已有 getter/setter。内部 host 调用显式使用 `global.__host`，避免其他接收对象的同名字段截获借用的静态成员。`inform/inputString` 的请求身份、捕获 host、try/catch/dialogAbort 和事件泵继续使用原有实现。

类回复组装时，native 将临时函数/属性 handle 复制为拥有引用的 closure；TS 在原 host 调用 finally 中释放临时 handle。绑定出口只接受 System 工厂、固定成员名、固定 policy 和对应的活 TJS 函数/属性类型，同一项不能重复绑定。未完成的类回复发生错误时释放已组装成员；委托的私有引用也纳入原有 nativeStates 终止清理，以拆开可能的 global→System→delegate→global 引用环。

原生入口执行最少参数数量和非空 receiver 检查，但不要求 receiver 的类身份是 System。`getArgument/createAppLock/getTickCount` 在返回结果未使用时跳过委托；实参仍由 TJS 正常求值，最少参数数量检查也仍执行。其余保留的方法体不在本阶段宣称全部参数转换均与原 C++ 等价。

只读路径和元数据使用实际 Property 对象，其普通 setter 拒绝写入。TJS 的属性地址、强制替换、删除继续存在；没有冻结整个对象。缺失成员普通读取遵守 native class 的 MEMBERNOTFOUND，`typeof` 继续遵守 TJS 的缺失读取规则。

## 路径与启动配置

所有返回路径都是游戏虚拟文件系统中的前缀，不代表宿主系统目录。

| 属性           | Web 值与含义                                              |
| -------------- | --------------------------------------------------------- |
| `exePath`      | `""`，已挂载游戏的虚拟根目录前缀                          |
| `exeName`      | `"krkr2-web"`，稳定的虚拟运行器标识；不伪造可执行文件资源 |
| `personalPath` | `"savedata/"`，当前游戏的存档别名                         |
| `appDataPath`  | `"savedata/"`，相同存档别名；不是跨游戏共享目录           |
| `dataPath`     | 默认 `"savedata/"`，可由启动 `-datapath` 设置相对前缀     |

EngineSession 从注入的 `arguments` 读取 `-datapath`。嵌入 API 的 `PlayerOptions.dataPath` 经 SessionClient/InitializeRequest 传入同一启动参数；普通应用导入界面不增加新的设置控件。可选值在 createPlayer 打开 MessageChannel/媒体 host 之前校验，在 Worker createSession 构造任何 port backend/surface 之前再次校验；EngineSession 构造时保存最终前缀。之后 `System.setArgument("-datapath", ...)` 只改变参数表，不重算存档目录。Player 创建后修改 options 对象不会改变捕获的初始值。

支持 `$(exepath)`、`$(personalpath)`、`$(appdatapath)`、`$(vistapath)` 四个宏。Web 的 exe 宏映射虚拟根，其余三个映射 `savedata`；vistapath 明确使用 appData 的 Web 别名，不探测或伪造 Windows 版本。支持反斜线、点段和尾分隔符规范化；非空目录返回尾 `/`，规范化到虚拟根则返回 `""`。未知/未闭合宏、归档地址、NUL、绝对路径、scheme、越出游戏根目录和规范化后超过 4096 个 UTF-16 单元的目录均拒绝。点段消除后再次检查根前缀，防止 `./C:\\outside` 或 `inside/../https://...` 到下一次实际存储访问才失败。

默认 Debug 文件日志目录同时使用初始化后的 dataPath，沿用已有 `setLocation`、强制日志与 UTF-16LE 输出逻辑。游戏仍可显式设置 Debug 的日志位置。资源读取和存档持久化继续走 StorageResolver、SaveOverlay 和按 gameId 隔离的 IndexedDB，没有新增 Windows 文件系统或后端服务。

## UUID 与版本

`System.createUUID()` 由 native static 入口调用 TypeScript 格式化逻辑，Worker adapter 通过真实 `crypto.getRandomValues` 提供 16 字节。输出是小写 v4 UUID，固定版本和 variant 位，不带大括号；不移植原版环境噪声/MD5 随机池。结果被丢弃时也生成新随机数。多余实参正常求值但不再转换；缺少熵来源或提供方失败会抛可捕获错误，不以 Math.random、时间或计数器替代。[Web Cryptography API](https://w3c.github.io/webcrypto/#Crypto-method-getRandomValues)

`versionString` 从唯一的项目 `package.json` 数值版本生成四段形式，目前为 `0.0.0.0`。`versionInformation` 返回项目标识、该版本、加载内核的实际 TJS 三段版本和 Web 标识，例如 `krkr2-web/0.0.0.0 TJS2/2.4.28 (Web)`。native exporter 直接读取编译进去的 TJSVersionHex；没有硬编码 SDK 的 `2.32.2.426` 或编造编译时间。`platformName/osName` 均为只读 `Web`。项目 JSON 作为静态数据导入，engine 不因此引入 Node 或 DOM API。

ABI 保持 5，manifest 增加 `nativeSystem:1`；生产 loader 必须同时满足此前的 `nativeReleaseState:1`、`nativeClipboard:1` 和新的 System 要求。窄绑定 API 和真实版本出口都由 native KEEPALIVE 导出。与 063 输入路由整合后的会话协议统一为 **16**，包含可选 dataPath 和新的键盘路由／attention 字段。

## 验证定义与剩余范围

源码和 `Scripts.compileStorage` 后执行字节码的真实 VM 定义覆盖：类与派生构造拒绝、回调初值、属性地址/强制替换/删除、只读赋值失败、借用成员与 receiver 同名 host 干扰、最少参数与丢弃结果、确定性 UUID 位布局/错误恢复、部分 class reply 绑定失败回滚、路径实际读写、全新 VM 的存档及 UTF-16 日志恢复、非法配置在 VM 创建前拒绝。

三浏览器定义覆盖实际 Worker、源码/字节码和既有 Asyncify/JSPI 矩阵。UUID 测试透明观察真实 Web Crypto 调用，不替换熵来源；持久化测试经过 Stop、页面重载、实际导出和不同 gameId 隔离；旧 manifest 测试仅移除 nativeSystem 并保留 nativeClipboard，再验证真实内核恢复。嵌入 API 的测试编译真实 createPlayer/Worker 源作为测试入口，直接传入 PlayerOptions.dataPath 并检查配置持久化、默认行为和非法值创建前拒绝。这类测试入口的构建产物与正常应用入口分开记录。

上述仅为待 GitHub-hosted Actions 执行的测试定义，不是通过结果，也不证明随机熵质量、跨进程 UUID 唯一性或原版 SDK 实机行为。每次失败、取消、跳过和未执行的记录按既有要求保留。

静态清单新增 58 个 Node 案例，以及 13 个浏览器测试定义（按三浏览器为 39 项）。嵌入 API 的新增场景使用源码脚本；正常应用路径的身份、UUID、持久化场景覆盖源码和字节码。实际执行数量、跳过情况和结果以 Actions 报告为准。

本阶段不注册 49 个空方法来制造完整表象。`toActualColor`、`doCompact`、线程/处理器与启动退出策略、onActivate/onDeactivate 的自动事件派发、title 的应用页面展示副作用等仍待各自合同实现。OS shell/执行/注册表、屏幕指标、`assignMessage` 和故意崩溃不进入本切片。旧 wrapper 的 touchImages Array 限制、部分 int32/boolean 转换、exit/terminate 的 code 转换和退出流程仍有明确差异；没有顺带重写它们。历史被安全审核拒绝的分配失败复现不属于本阶段验收。

## 首次组合构建结果

[35013970344](https://github.com/fenghengzhi/krkr2-web/actions/runs/35013970344) 在 `8cf6ae9bb1b1b26a0d96cf53ba51f65f4fcf6c2f` 成功编译 Asyncify／JSPI／字体内核，随后在 `web-crypto.ts:5` 类型检查失败：宽泛的 `Uint8Array<ArrayBufferLike>` 可能包含 SharedArrayBuffer，不能直接传给当前 Web Crypto 类型所要求的 ArrayBuffer view。普通测试实际执行数为 **0**，原始构建日志与终态单独保留。UUID 本来就新建自有的 16 字节 ArrayBuffer，修订只把 adapter、Session 依赖和 SystemEnvironment 的对应类型统一为 `Uint8Array<ArrayBuffer>`，没有使用类型断言或替换随机源。修订仍须 GitHub-hosted Actions 验证。

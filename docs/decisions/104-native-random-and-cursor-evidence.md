# 104 原生随机数熵接线与光标证据

状态：开发候选，尚待 GitHub-hosted Actions 验证。本批从干净的 `c0b2cb2` 继续；上一批已实现、提交和推送视频流选择，属于实际进展。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，未完成。协议 **41**、TJS ABI **5**、字体 ABI **2**、`nativeSystem:5` 保持，新增独立能力 **`nativeRandom:1`**。

本地仅检查／编辑源码、操作 Git，以及下载、解包、核对和解析历史原件。没有运行测试、构建、类型检查、浏览器、候选算法或可执行参考探针。整批提交后只记录一次运行身份，下轮取回固定结果，不实时监控。

## 固定回收

102／`37352789584` 和 103／`37355736416` 的 run、jobs、artifacts 每个端点各取一次。**24 份原 ZIP、58,958,213 字节**全部匹配 API 大小和 SHA-256；九份复用原包重新核对，十五份新取。总表为 `out/verification/github-actions/104-archive-summary.{json,md}`。

102 已终态 failure，20 jobs 为八成功、六失败、六跳过。构建保留原七条 `findLast`／移动输入类型诊断；这些错误已在 103 的构建中消失。103 固定快照仍 in_progress，19 jobs 为八成功、三失败、两运行、六跳过；构建仅报告 `video-stream-selection.test.ts` 的两条 TS7022，本批为其加明确 `DataView`／`Uint8Array` 类型。**两轮应用 Node、浏览器、runtime、兼容和堆诊断均跳过，没有应用通过结论。**

102 双 Windows 光标原件完整 **343/343**。固定 32×32、32 bpp、96 DPI 文件加载的 strict 报告各 **1076/1076 matched、0 failure、5578 uncompared**；mask 各 **3770/3770**。portable 仍为 partial，已比较 **173/173**；未比较不能算通过。103 光标作业仍未结束，固定清单没有新 ZIP，不再刷新。此前 477 个严格差异的各次运行原件保持，不用新通过结果覆盖旧失败。

两轮原生池 ASan＋UBSan／TSan 各六场景正常退出，身份诊断各后端有 60 条无失败记录，范围仍是各自的原生／受控边界。103 beginMove 双系统各 **7/7 observed** 且确认清理；102 的前置失败仍保留。103 退出参考因 C# **CS0819** 在 Add-Type 阶段失败，cases 为空，八个场景均未执行；本批把多变量 `var` 声明拆开，原 owner／PID／菜单树门禁不变。102 双系统各七 observed、一个菜单超时的证据继续有效。

## Math.RandomGenerator 的实际缺口

固定原版 `ScriptMgnIntf.cpp` 在创建 TJS 后安装 `TJSGetRandomBits128`。原生 RandomGenerator 在无参数构造或 `randomize()` 时调用两次，每次获取 16 字节，再按既定算法形成 32 个 MT 种子字。此前 Web bridge 未安装该 hook，落入独立 TJS 的秒级时间种子后备路径，同一秒的默认实例可重复同一序列。

现在通过私有同步 import 接到当前 Worker 的 `crypto.getRandomValues`。先填独立 16 字节数组，成功后才复制到当前 WASM 内存，检查目标范围及返回缓冲区身份；不通过可挂起的 hostCall。缺少 provider 或 provider 抛错由同步 JS 边界捕获，再转为可捕获的 TJS 异常。两次取熵都发生在删除旧生成器之前，因此第二次取熵失败也保留旧序列。

保留原 MT19937、公有方法、int64 显式种子、Dictionary 恢复和被丢弃返回值的推进规则。显式 `void` 按零种子处理，不等于省略参数。原混种算法中重复使用 `buf[1]` 的字节槽保留；移位改为 uint32，避免高位字节触发有符号溢出。宿主熵不可复现，不承诺与原 Windows 的随机字节相同。

manifest 的 `nativeRandom:1` 和模块私有导出版本都必须匹配，创建 VM 前拒绝旧内核；原 ABI 及其他能力门禁顺序保留。hook 只引用静态函数，不持另一个 Session 或 Runtime。两个同时存活的独立模块分别验证熵源与状态，一方销毁后另一方仍可继续。

## 恢复状态的边界

原恢复实现直接形成 `state + next`，随后按 `left` 计数读取，可被伪造字段引向 624 个状态字以外。现在先执行原 int32 转换，再检查 **1 ≤ left ≤ 624、0 ≤ next ≤ 624、left − 1 ≤ 624 − next**，最后形成指针。这个范围保留正常序列化状态及可安全手写的状态；`left=1,next=624` 在读取前重填，也仍允许。

无效索引、长度／hex 字符错误和属性 getter 异常使用原恢复失败消息，拒绝时不替换旧生成器；getter 自身的脚本副作用不承诺回滚。构造失败沿既有 NativeOwner 清理。没有扩大原代码删除旧生成器之后发生普通分配失败的恢复保证。原源和哈希审计见 `out/verification/random-generator/104-audit.md` 及 `104-source/manifest.json`。

## 原生 PNG 回归与托管定义

将 102 两个 Windows 上一致的 **20 个原始 PNG-in-CUR 文件**及 60 份完整 DrawIconEx RGB 哈希固化。输入 CUR 共 **174,771 字节**，含 JSON 元数据共 **234,428 字节**。覆盖 65／66 边界、方形、48／13 两方向及 RGB／alpha；测试核对源 SHA、PNG 目录、完整 80×80 图像、三种背景及热点，不用候选输出生成期待值，也不推断原生 alpha 语义。每系统另外 300 条 flags／显式缩放观察仍未比较。审计在 `out/verification/cursor/104-PNG-audit.{json,md}`。

本批新增 **36 个常规 Node 定义、每浏览器 6 个定义**。Node 为 PNG 20 和 RandomGenerator 16；随机数的同 16 定义另用同次构建的 JSPI 内核独立执行并保存 TAP、日志和崩溃诊断。独立 MT 参考先核对原作者公开向量，再核对完整 624 字状态和跨重填的 630 次输出；覆盖显式种子、失败清理、恢复边界、双模块隔离和返回值被丢弃。

浏览器四定义覆盖 Asyncify／JSPI、源码／字节码的实际 Worker：观察真实 Web Crypto 调用及复制字节，受控注入第二次 provider 异常，验证原状态与后续恢复、Stop 和重开；另两定义覆盖缺失／0／2 版本门禁及恢复真实 manifest。观察包装先核对原模块 SHA；故障干预与正常真实调用分别记录。这些为待执行库存，尚不是成功数量。

## 后续仍需完成

本轮还明确了 TVP 消息映射的原合同：固定源有 138 个可注册 holder、六个 CONST，Web 当前主要编入 TJS 消息，真实 TypeScript 错误仍绕过 TVP mapper。完整修复需要有原调用点证据的消息 ID、参数与原生返回边界格式化，不能只添加未被异常使用的字典。审计保存在 `out/verification/system-messages/104-audit.md`，此功能仍未实现。

应用构建后的实际回归、历史浏览器失败、更多媒体格式、系统边界、字体／图形兼容和更多真实游戏验收继续属于完整目标。当前提交、待执行候选、固定范围已验证结果与历史失败保持区分。

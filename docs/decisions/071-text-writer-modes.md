# 071 — 文本流创建期模式校验与有界偏移

状态：独立实现候选，尚未运行本切片的 GitHub Actions。源码审查和新增用例定义不是通过证据。TJS ABI 保持 **5**，新增 `nativeTextStreams: 1`，会话协议为 **22**；保留 `nativeStorages: 2`、`nativePhaseVocoder: 1` 及其他既有能力。生产 Worker 拒绝不提供专用文本创建期预检的旧内核。

## 固定来源与边界

原版文本合同来自 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [TextStream.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/TextStream.cpp)、[StorageIntf.cpp](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/StorageIntf.cpp) 与 TJS 字符串数值转换源码。二进制流独立参考本项目 vendored VM 上游 `kirikiroid2-web@6622499f70c3b30240d34d73d757c8adff45248f` 的 `cpp/core/base/BinaryStream.cpp`，不能将其当作 KRKR2 2.32 SDK 已执行观察。

原文、来源及 SHA-256 留存在工作区 `out/verification/text-writer-modes/manifest.json`，详细合同为同目录 `contract.md`。本切片没有重跑原版 SDK、危险分配诊断或任何本地可执行验证；下述原版规则均为固定源码推断。

## 共享模式解释

`src/formats/text/mode.ts` 提供同一套解释给文本预检、实际编码、文本读取、脚本读取和二进制读取／写入。所有模式字符只检查首个 NUL 之前的前缀。

文本 writer 按以下顺序分类：保留 Web `utf-8`／`utf8`（大小写不敏感）扩展的最高编码优先级；否则查首个小写 `c`，只读紧邻的一位 ASCII 数字，缺省为 1；再查首个小写 `z` 并覆盖为 2，紧邻一位数字表示压缩级别。最终只有普通 UTF-16LE、simple 1 和 compressed 2 合法。`c`、`c1`、`c10`、`c-1` 是 simple；`c2`、`c20`、`z`、`c0z`、`zc0` 是 compressed；无 `z` 覆盖时 `c0`、`c01`、`c3` 至 `c9` 拒写。大写 `C`／`Z` 不触发原生编码规则。读路径继续支持固定旧 `FE FE 0 FF FE` envelope，不能以旧 writer round-trip 推断原版允许写 c0。

CompressionStream 仍使用宿主默认压缩级别，记录的 `z0` 至 `z9` 不意味着可控制浏览器压缩器，也不要求压缩 bitstream 与原版逐字节相同；测试使用独立解压和长度／文本内容检查。UTF-8 与 `c0` 等组合保持既有 Web 编码优先级，但仍验证偏移。

偏移独立查首个小写 `o`，保留“存在”与数值两个字段。`o0`、空 `o`、`oo6`、`o-6`、`o+6` 均表示显式偏移 0；`o10o2` 使用第一个 10。只收集紧邻 ASCII 数字，前导 0 按 TJS 八进制解析，非法八进制位终止有效前缀，因此 `o010` 为 8，`o08` 为 0，`o0x10` 为 0。读取与写入都使用这一规则，避免同一模式写到 8 却读到 10。

Web 拒绝连续数字超过 255 位的偏移字符串，以及有效值不安全或超过 64 MiB 的偏移。这是明确的有界适配，不复制原版截取后溢出、符号回绕、稀疏文件或巨大分配。追加扩展 `a` 仍在有效模式前缀中识别；它先校验偏移，再以 EOF 覆盖有效偏移，不能绕过非法值检查。

## 创建期异常与延后写入

native `createTextWrite` 在 `new HostTextWrite` 前调用可挂起的 `Storage.validateTextWrite`。宿主先判断最终文本编码合法性，再解析偏移、验证路径，所以非法 cipher 先于非法路径／偏移报错。该调用保持在原 TJS 可捕获的 save 调用栈，确定的非法模式不会构造流，也不会在析构时留下失败 queue 项。

`createBinaryWrite` 保留独立 `Storage.validateWrite`，只校验其路径和共享偏移，不检查 c/z。实际流入口决定类型：Array.save 始终文本，即使 mode 含 b；Array／Dictionary.saveStruct 的 b 分支仍写 KBAD 二进制，`bc0`、`bc9`、`bz` 均不加入文本 envelope。实际文本编码复用同一解释器，避免预检接受 c2 而尾部编码再拒绝。

文本和二进制输出合并都以 `hasOffset || append` 决定保留原字节。显式 `o0`／空 `o` 的短写保留后缀；无偏移的普通 WRITE 仍替换完整文件；非零偏移保留前缀和后缀，间隙按既有策略填零。追加保持原字节，合并分配前检查总长度 64 MiB。

这仍是完整字节准备后替换单个 SaveOverlay 文件。没有移植 OS 构造期打开／写 BOM／截断；压缩器、实际存储提交、取消等异步失败仍由现有刷新路径处理。native destructor 仍只复制并排队，不在不可挂起阶段调用宿主。序列化过程自身抛错时仍可能经原析构逻辑排入已生成的内容，本切片不承诺整个 save 序列化事务回滚。

## 尚未闭合的 UPDATE 与运行时边界

原版 UPDATE 要求现有文件，并通过 `TVPGetPlacedPath` 选定实际目标。本切片只对齐模式与短覆盖范围，保留 Web 既有 copy-on-write、按请求名写入 overlay 和缺失目标从空内容构造的策略；auto-path 查找读到的资源与最终保存键没有新增绑定。不能将这称为完整原版 UPDATE 文件合同。archive、OS 文件共享、句柄锁、跨流竞争及实际文件打开错误次序仍不在本切片内。

070 记录的通用 `runtime.run()` 边界也保留：native reply 的未捕获 ScriptError 与 finally flush 的真实写错误同时发生时，后者可能替换前者。此处只消除确定非法文本模式产生的坏队列，不修改双错误聚合、ownerFailure、System.exceptionHandler 或失败写入显式重试机制。详细已知边界仍见工作区 `out/verification/text-writer-modes/070-runtime-cleanup-boundary.md`。

## 待 Actions 的验收

新增定义覆盖纯格式分类、独立 c2/z 解压、固定 c0 只读 envelope、原生创建入口、source／bytecode 的紧贴 save catch 与纯 TJS 哨兵、后续独立合法 save、旧文件保持及缺失文件不创建、实际文本／二进制偏移读写、浏览器导出字节与刷新后的持久读取。测试只构造小文件和小有效偏移；非法超限字符串只验证拒绝，不请求大分配。

静态新增库存为 **38 个 Node 定义**（格式层 9、native 7、Session 22），以及 **14 个浏览器定义 × 三浏览器 = 42**。Session 的 11 组各覆盖源码和编译字节码；浏览器三组各覆盖两个后端和源码／字节码，另有两个后端的真实 manifest 缺失能力拒绝与恢复。实际发现／通过数量只以后续 GitHub-hosted Actions 报告为准，不能用这些定义数替代执行结果。

既有原始 KAG BMP 缩略图非零 offset 附加存档回归继续保留在 `tests/probes/kag-browser.ts`：原脚本保存 8/24 位缩略图，验证 BMP 长度后存在追加数据，再刷新并读档恢复。不以新纯 codec 测试替代该真实路径，也不覆盖任何历史通过、失败或未运行记录。

# ZIP 资源与按需解压

状态：ZIP 中央目录、stored/deflate 成员、ZIP64、文件名解码及浏览器导入已接通。解析在 TypeScript 中执行，deflate 使用 Web DecompressionStream；没有引入原生 ZIP 库。

## 模块边界

`formats/zip/archive.ts` 从 ByteSource 建索引，返回普通 Resource 及压缩方法、加密标志和 CRC 元数据。只依赖字节来源、UTF-8 解码、解压与协作调度端口，不访问 DOM、Blob 或 IndexedDB。`names.ts` 提供 CP437 映射；特殊旧文件名编码可通过格式接口的 legacyName 回调配置，页面暂未提供这个选项。

`backends/files/import-resources.ts` 将文件选择、BlobSource、XP3/ZIP 和会话资源组装分开。输入顺序仍是挂载顺序，同名资源后者覆盖前者；ZIP 中的重名成员保留中央目录顺序。每个归档同时提供普通资源名与 `archive>entry` 地址，可以与 auto-path、写覆盖层、图像缓存和原有 TJS 文件流组合。

选中的 `.zip` 文件按 ZIP 解析；具有 ZIP 普通文件头或空归档签名的其他后缀文件也会识别，例如 `game.data`。归档本身作为一个资源保留。不会猜测补丁名称、重排文件、删除包内目录前缀，或自动递归展开 ZIP 内的 XP3/ZIP。游戏在包装目录内时，启动脚本路径需包含该目录；自动根目录选择和嵌套包处理仍待完成。

资源列表全部准备成功才交给会话挂载。索引失败、路径无效或用户停止时，未完成的列表不进入当前命名空间。索引、CRC 和解压检查点使用会话暂停/取消状态，按约 8 ms 时间片让回宿主。

## 读取与校验

建索引读取有界文件尾及中央目录，尚不展开成员。文件尾可能包含少量成员数据，但不因为导入而遍历解压所有内容。读取某个 Resource 时，检查局部记录、名称、方法、尺寸、相邻记录边界和可选数据描述符，再读取该成员的压缩数据并校验输出尺寸与 CRC32。独立读取获得独立字节；读取失败不返回半成品。

支持普通和 ZIP64 中央目录/局部尺寸、经典与 64 位数据描述符、有/无描述符签名、空文件、目录、长注释、UTF-8 标志、CP437 名称及有效的 Unicode Path 扩展。Unicode Path 的版本或名称校验不匹配时回退原名称；明确标记的无效 UTF-8 报错。文件名统一经过现有相对路径解析，不能逃出游戏根目录或注入 `>` 归档分隔符。

保留记录布局的校验，不承诺数字签名认证。目录不产生可读取的普通文件；符号链接不会跟随。加密成员、其他压缩方法和不支持的成员标志可保留在清单中，但访问时明确报错，避免未使用的成员阻止整个游戏读取其他资源。多卷归档和不支持的中央目录结构在索引阶段拒绝。

实际样本中，Python 流式 force_zip64 可以同时出现局部零尺寸、ZIP64 扩展与 64 位描述符，中央尺寸仍能放入 32 位。实现根据局部扩展判断描述符宽度。另处理恰好 65,535 条目的经典归档，以及保留 ZIP64 记录但经典字段仍写实际值的布局。不能只根据一个 0xffff 或 0xffffffff 字段推断所有 ZIP64 行为。

ZIP64 定位记录必须位于中央目录之外。普通成员注释中可以出现相同标记；当经典目录的声明范围已经延伸至结束记录时，不把目录内部的字节解释为定位记录。对应变体另由 Python 回读确认有效。

## 预算和生命周期

中央目录不超过 64 MiB，单归档最多 100,000 条中央记录；单次导入最多 10,000 个来源文件和 250,000 个最终资源名（包含归档限定别名）。单个成员的压缩输入及解压输出分别受 64 MiB 限制。整个归档可以超过这些大小，偏移用安全整数校验；稀疏 ByteSource 测试覆盖超过 4 GiB 的真实索引/局部记录寻址。

预算约束不等于进程峰值上限：尾部窗口、索引、文件名及条目对象、解压输入、输出副本、VM 和图层分别占用内存。这里没有持久化完整解压包，也没有把 deflate 成员变成任意位置可 seek 的流；HTTP Range、OPFS、流式大成员和统一内存预留仍是后续工作。

浏览器适配器的 raw-deflate 解压逐块检查输出上限及取消状态，结束时要求尺寸相符。会话停止后旧读取不能提交资源或继续执行脚本。普通 XP3 的导入行为沿用现有实现，资源容量常量移至共享 storage 端口，XP3 原导出保留兼容。

## TJS 写入目标预检

归档成员保持只读；向普通资源名写入仍进入存档覆盖层，不修改原 ZIP。覆盖普通名字后，明确的 `archive>entry` 地址仍读取归档原始内容。

测试暴露了旧文件流的延迟错误：原生流析构只能把字节放入 JS 队列，不能挂起/抛错；非法归档路径因此到队列刷新时才失败，脚本无法在 save 调用处捕获，且队列会留下不可提交的项目。

新增内部 `Storage.validateWrite` 操作，在创建文本和二进制写入流前验证目标路径及模式偏移。验证仍由 TypeScript 宿主执行，TJS 在可挂起的调用栈上接收异常。无效路径不会建立流或产生待写字节；有效保存继续沿用既有编码、写队列和 IndexedDB 事务。这个预检不提前保证最终编码大小或存储提交一定成功，后者仍由原有刷新流程报告。

## 验证来源

`scripts/generate-zip-fixtures.py` 使用独立的 Python zipfile/zlib 生成并回读 16 个归档，共 90 次成员读取，包含脚本、图片、Unicode 文本、空文件和可压缩数据。固定样本、哈希、生成器版本及来源哈希位于 `tests/fixtures/zip/`；普通测试不依赖 Python 或相邻参考目录。

格式测试另覆盖损坏记录、CRC/尺寸错误、重叠边界、Unicode 扩展、无签名描述符、65,535 条目、超过 4 GiB 的稀疏来源、内存预算和取消。这些变体通过明确的字节改动或稀疏地址映射构造，不把自写格式生成器当成唯一正确性来源。

真实 TJS 验证挂载覆盖、限定地址、auto-path、图片、存档导入和文本/二进制写入错误。浏览器验证 stored/deflate/ZIP64 流式包、后缀识别、显示像素、刷新读档、损坏文件恢复和建索引时停止。

`tests/probes/repack-xp3.ts` 将本地参考 KAG 模板重打包成 ZIP，并由 Python 回读逐成员核对原始字节。`zip-matrix.mjs` 对原 XP3 和重打包 ZIP 分别执行三浏览器、双后端的输入/存读档/转场场景，保存日志、截图、资源来源和实现/构建哈希。准备与运行方式：

```sh
mkdir -p out/verification/zip
npm run check > out/verification/zip/check.log 2>&1
node --import tsx tests/probes/repack-xp3.ts ../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3 out/verification/zip/kag3_template.zip
node tests/probes/zip-matrix.mjs
```

本轮修正了验证中的异步边界：求值使用唯一结果标记，视频等待延迟出现的自动播放提示，场景截图等待会话和尺寸就绪，KAG 历史状态等待排队的按键处理完成。原有像素、存档、事件和停止时限断言保留；另有延迟播放拒绝的受控用例。

最终 `npm run check` 通过 166 项行为/集成测试与 207 项浏览器测试，无跳过项；两种容器的 36 个 KAG 场景全部通过。证据汇总在 `out/verification/zip-matrix.json`，完整检查日志保存在 `out/verification/zip/check.log`。

实现参考 [PKWARE ZIP 规范](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)、[Compression Standard](https://compression.spec.whatwg.org/) 与 [Python zipfile 文档](https://docs.python.org/3/library/zipfile.html)。相邻参考的 ZIPArchive.cpp 用于核对资源读取边界；未复制其 ZIP 实现。

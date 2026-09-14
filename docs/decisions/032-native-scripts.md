# 原生 Scripts 宿主

此前 `Scripts` 是 TJS 字典，exec/eval 等包装函数多出桥帧，缺少参数时仍会进入宿主，非对象 context 还会被忽略。本阶段使用原 `tTJSNativeClass` 和原生方法对象注册 Scripts，禁止创建实例，保留 Function/Class 身份和静态成员语义。

## 边界

`native/tjs2/scripts.cpp` 负责原生参数数量、字符串/整数/对象转换、TJS 执行和编译，以及 `getClassNames`、`setCallMissing` 的原生对象操作。它通过小型 HostCall 接口请求数据，不管理浏览器资源、网络或持久化。`exec/eval` 直接进入同一 VM，`execStorage/evalStorage` 继续使用挂起后的宿主回复；调用栈不再包含 Scripts 自身的 TJS 包装函数。资源执行的位置名使用解析后资源的末段名称，inline 执行未提供名字时使用原生空名称，行偏移由 TJS 转换。

`compileStorage(input, output, result=false, debug=false, expression=false)` 先读取文本，再创建原生输出流并调用同一 TJS 编译器。三个标志使用原生整数转换。编译不执行输入；后续可立即执行写出的 TJS 字节码，也可通过存档备份和浏览器持久化恢复。

输出流沿用原生 Array/Dictionary 的桥接写入队列和 64 MiB 预算。读取失败不会打开输出；一旦输出已打开，编译失败或取消仍会关闭并发布空/部分流，符合参考的析构路径。编译输出按游戏文件处理，持久化失败仍是严格失败，不使用 dump 的可忽略诊断写入规则。浏览器原始导入文件保持只读，写入落在存档覆盖层。

`dump/getTraceString` 使用相同的原生方法绑定。dump 仍通过独立 UTF-16 收集器输出，不把正文发给观察者；getTraceString 仍受启动时的脚本调试选项控制。其他 TVP 接口的 TJS 桥帧尚待迁移，不通过过滤文件名隐藏。

## 文本编码扩展

参考快照中的 `textEncoding` 支持 UTF8/UTF-8、GBK 和四种 SJIS 名称。选择保存在会话中，影响后续 Scripts、原生文本流、KAG 读取与编译；BOM 和明确的 utf-8 模式优先。getter 保留原输入拼写。无效赋值按参考先改变名称、再抛错，实际解码器仍沿用前值。

未显式选择时仍使用现有 Web 解码策略（严格 UTF-8，失败后 Shift-JIS）。参考的自动探测次序、解码器锁定行为和全部旧字符映射尚未对齐，不能将该扩展视为完整原生文本兼容。TJS 二进制序列化数据通过 Scripts 资源接口读取、带前缀字节码及完整存储路径行为也仍需独立验证。

## 版本与验证

增加原生 Scripts 类构造桥，TJS WASM ABI 升到 **5**；字体 ABI **2**、会话协议 **9** 不变。验证仅在 GitHub Actions 执行，覆盖原生类和参数、反射/missing、准确调用栈、编译标志、输出生命周期、编码、暂停/取消、浏览器与冷离线恢复。云端结果待补齐。

参考：[KRKR2 Scripts 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_Scripts.html)、[原 KRKR2 ScriptMgnIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/trunk/kirikiri2/src/core/base/ScriptMgnIntf.cpp)，以及固定参考快照的 ScriptMgnIntf.cpp/TextStream.cpp。完整非插件目标仍未完成。

# 114 原版 PNG 透明规则与元数据

状态：候选，等待 GitHub-hosted Actions。上一轮 113 已实际提交推送，本轮从干净的 `d415edf` 继续。整体目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。本批修正已选 PNG handler 的 RGB 透明和元数据行为，同时建立固定版本 C 参考；协议 **42**、TJS ABI **5**、字体 ABI **2** 及已有能力版本保持。

本地只做源码读改、Git、历史原件与参考源码下载／哈希／解析，没有执行测试、编译、类型检查、浏览器或任何候选探针。109–113 的 run、jobs、artifacts 各读一次后冻结，已终态 107／108 不再查询。新批次推送后只取一次身份，下批回收结果，不实时监控。

## 固定回收

本轮保留 **33 个原 ZIP、417,496,309 字节**，其中四个新增、二十九个复核，全部与固定 API SHA-256 和大小匹配；保留三个新失败作业日志及一份旧 Node 日志。入口为 `out/verification/github-actions/114-archive-summary.{json,md}`。五个运行的不同 endpoint 分别固定读取，不把它们称为原子快照。

109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba` 仍 **in_progress**：34 jobs 为 28 success、4 failure、2 running。新取得 Chromium 主报告 **907 pass／30 fail**、Firefox 第一分片 **456 pass／14 fail／1 skip**、WebKit 第一分片 **453 pass／17 fail／1 skip**，合计 **1816 pass、61 fail、2 skip**；两个第二分片仍无报告。与 108 相同三份报告的 66 个失败精确标题对照，八个在本次已报通过、五十八个仍失败、零缺失；这不证明因果修复，也不排除偶发。

三浏览器兼容各 **32/32，合计 96/96**，包括原 KAG 两种内核诊断。此前 Node **3585 pass／27 fail**、可信生命周期 **19/19**、Library 57 pass、PWA 59 pass、直接 runtime 6 pass 证据继续保留。110／`40781763654`、111／`40785212878`、112／`40787500591`、113／`40791060043` 仍 **pending、零 jobs／artifacts**，不能提前确认这些候选。历史失败、取消、skip、未报告、未比较和 Library 归因勘误都保留。

## PNG handler 的确定差异

固定原版 loader 为 KRKR2 2.32stable `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `GraphicsLoaderIntf.cpp`。本轮进一步核对官方 libpng 1.0.6 的 `pngset.c`、`pngread.c`、`pngrtran.c`、`pngrutil.c` 与配置头；来源和精确 hash 保存在参考 manifest 与本轮源码审计中。这证明对应源码的调用关系，尚不证明原 Borland `deelibpng.lib` 二进制内部完全相同。

普通 RGB PNG 分支只启用 BGR 转换和不透明 filler，没有启用展开 tRNS 的 `PNG_EXPAND`。之前 portable handler 直接按照标准 PNG tRNS 把匹配 RGB 设为透明，偏离了这个原版调用。候选让 selected normal RGB 保持不透明；灰度 PNG 的原分支启用了 expand，仍有 tRNS 透明，显式 RGBA alpha 也保持。之后的字面 RGB key 仍按原 scanline callback 改 alpha。通用 `decodePng` 与 CUR 等消费者继续使用自己的标准透明规则。

原版在 `png_read_info` 之后读取 oFFs／pHYs。libpng 对它们的重复、错误长度和 IDAT 后出现只警告并忽略，第一次有效的九字节值才生效；坏 CRC 也不发布这些元数据。候选据此保留第一个有效前置值，不再接受尾部覆盖，也不把这些警告变成加载失败。

自定义 vpAg callback 则接受任意字母大小写、至少九字节并只取前九字节，可发生于 IDAT 前后。较短的 ancillary vpAg 忽略；较短的 critical 变体仍报告 unknown critical chunk。该 callback 在 CRC 检查之前执行，所以 ancillary CRC 警告不撤销已发布 vpAg；critical CRC 仍失败。pHYs／vpAg 的 uint32 在原 loader 经 `tjs_int` 转换，候选输出对应的有符号字符串。其它 chunk 的 CRC 策略没有借此放宽。

## 实际消费者与独立参考

新增 **16 个常规 Node 定义**：十个 selected codec 定义、六个真实 source／bytecode 消费者定义；新增 **每浏览器四个定义**，覆盖 Asyncify／JSPI 与 source／bytecode。真实消费者使用独立构造的 PNG 字节，检查 RGB／gray／RGBA 的 alpha、后续颜色 key、元数据返回与成品缓存独立副本；浏览器严格比较实际提交 canvas 的完整 12×8 RGBA。原 selected corpus 的两个定义仅更新 `transparent-rgb.png` 的明确 opaque 预期，保留原文件字节和通用 decoder 的标准透明 oracle。

新增独立托管 `png-reference` 作业，使用固定官方 libpng 1.0.6 提交 `520a764cd79aea2d282cb4d2b9187f0aafb72404`。`tests/native/png-reference-source.json` 固定十九个源码／头文件／许可和说明文件的字节数和 SHA-256；驱动下载并逐项核对后，以 32 位 C 和 zlib 编译，按原 loader 的真实 libpng API 调用顺序读取独立夹具。共 **47 个输入：36 个成功结果合同、5 个预期错误合同、6 个 palette key 调查**。保留输入、完整已定义像素、rowbytes、阶段、元数据与错误／警告，并记录实际 zlib 版本。该作业纳入总门禁，失败、跳过或未执行均不算通过；调查项不能混入成功像素计数。

固定 `png_handle_unknown` 在拒绝短 critical vpAg 和尾部未知 critical chunk 时，错误跳转发生于临时 chunk 释放之前。对应两个参考输入分别要求记录 **一块 8 字节／一块 1 字节**原库残留，并单列为 `expected-native-error-with-leak`；它们验证的是精确复现已知原库错误，不是原库清理通过，更不是 Web 内存测试。其它正常／错误合同继续要求零遗留和零非法释放，报告原状态后才由 harness 回收。任何未声明或大小不符的残留仍使参考门禁失败。

参考是固定上游源码在托管平台的重建，不替代原 Windows 二进制身份。尤其 palette key setter 及无 tRNS 时的行宽／所有权异常只作为单独调查证据，不读取未初始化字节或把安全处理后的输出冒充原结果。新原生探针和应用定义均尚未执行，静态审查不等于验证通过。

## 浏览器失败取证与修订

108 的三条 TLG 失败原 trace 都已包含精确的 `native-tlg-rule:rule.tlg6` 结果 span，随后 TJS 反汇编／Register dump 追加了横线分隔。原 helper 读取最后一个 span，误把后附文本当作表达式结果。现在复用已有唯一 marker 的表达式 helper；TVP 错误文本、像素断言和实际 TLG handler 均不改变。详见 `out/verification/image-loading/114-tlg-browser-audit.md`。

109 Chromium 新 multiwindow-menus 失败在菜单计数 `75:2,1` 已通过后，真实 Stop 导致日志出现 disposed RPC。原 trace 没有方法名或堆栈，不能断定它属于 111 已修的几何退休分支。候选在实际 Stop 点击 capture 时同步保存被动 RPC 库存，再保存退出后回复／错误／终止记录；保留严格的无 disposed 日志断言，不增加重试，也不先 await 取证来改变原竞态。

WebKit 新 layer-attention 失败在等待启动 ready 时，尚未执行 attention 断言。其原件保留，不能按文件名归为注意力锚点实现错误。上述浏览器修订新增定义为零；菜单和启动失败仍待定位。

## 仍未完成

PNG 全量 inflate 仍缺可控的压缩消费／部分输出合同。原 `png_read_finish_row` 还可能在最后一行原始像素写入之后、scanline 完成通知之前读取 trailer 或下个 IDAT CRC 并失败；只添加浏览器流式 chunk callback 不足以证明等价。后续需要可验证的 pull 式解码状态、原始写入与完成通知分离，以及暂停／Stop／预算的完整消费者验收。

palette key setter 与 grayscale palette+tRNS 的旧库行为、JPEG 原生失败进度、ERI、部分短读消息、历史 heap／媒体／菜单等失败和真实游戏验收仍未闭合。保持完整非插件目标 active，下批先取回这批及前面未完成运行的固定结果，再按实际证据修订。

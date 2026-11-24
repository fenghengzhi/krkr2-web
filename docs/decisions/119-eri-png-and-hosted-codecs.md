# 119　ERI 索引图、PNG 透明度与独立图像验证

本批为游戏接入首组 ERI 图像，修正 selected PNG 的透明度处理，并修复原生消息格式化器的一处 C++ 编译错误。代码与验收定义均待托管执行。

## 游戏加载的 ERI

KRKR2 固定源码的默认 Borland 工程定义了 `TVP_SUPPORT_ERI`，并链接 `liberina.lib`。游戏可以把调色板 ERI 加载为普通图像或灰度遮罩。调用 `Layer.loadProvinceImage` 时，原加载器在读取 ERI 内容前拒绝调色板输出模式。原 Windows 工程、处理器和公开的 ERINA 源码分别固定，公开库的头文件与工程内的旧头文件有差异。[原版图像加载器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/GraphicsLoaderIntf.cpp) · [ERINA-Library 1.0A 源码](https://github.com/uyjulian/erinalib/tree/829244b10337bf70cd91c19174becce4e7dfd690)

Web 现在支持 lossless ERI、`ImageFrm` 版本 2、8 位无 alpha 的索引图与灰度图，熵编码为 RL-MTF-G。读取器按 EMC 父记录限制遍历，逐行恢复索引。257 张 move-to-front 表在各行之间保留，当前表和上一个符号在每行开始时重置。输出遵循高度符号。索引图读取 BGR 调色板，忽略条目的保留字节并处理 `clPalIdx`。灰度源直接使用样本值。遮罩按原版转换和绑定。

ERINA-Library 1.0A 作者为 Leshade Entis、Entis-soft。发布文件中附有署名和原日文使用许可的 UTF-8 文本。[使用许可](../../public/licenses/erina-1.0a.txt)

成功打开容器后先通知尺寸，整幅私有索引平面解码成功后才向调用者交付扫描行。因此头部错误、初始化错误和熵解码错误具有不同的可见结果。存储长度达到 2³² 字节时使用原版 `TVPERILoadError`。Web 的 64 MiB 编码源上限、4,096 像素单边上限、65,536 条记录上限及安全整数检查使用各自的错误。缺失调色板的内存用零初始化。真彩色、带 alpha 的源、其他帧版本、算术／Huffman 及有损编码仍有兼容缺口。[实现](../../src/formats/image/eri.ts) · [署名](../../public/licenses/graphics-notices.txt)

实际 Session 与浏览器覆盖源码／字节码、主图、遮罩、缓存隔离和失败时的可见位图。另有独立 Windows 参考作业，用项目已固定大小和 SHA-256 的原版 2.32r2 SDK 打开小尺寸有效 ERI。它逐像素记录原生 Layer 的 RGB 和 alpha，再用 TypeScript 的实际图像加载器比较同一组文件。11 个场景包括正负高度、三种索引键、灰度、两种伴随遮罩和省份拒绝。SDK 二进制和 2.32stable 源码各有独立身份，参考作业尚未给出本批相等结论。[原版 SDK 身份](../../tests/fixtures/native-reference/sdk.json) · [逐项比较](../../tests/probes/eri-sdk.ts)

## PNG 的 tRNS 状态

固定 libpng 1.0.6 在检查 tRNS 的 CRC 前已写入解码器透明数据。CRC 成功后才标记文件信息中的 tRNS 有效位，该位决定是否忽略后面的重复块。此前流式路径直接丢弃坏 CRC 的 tRNS，整缓冲路径把它当作致命错误。本批按原先后顺序处理，保留实际短读与关键块 CRC 错误。验收覆盖两条选定格式的加载路径、1／2／4 位灰度、调色板、重复块和 Adam7。原库在部分扩展灰度输出中可能写超目标行，Web 使用有界平面，该范围没有原生字节相等结论。[PNG 验收](../../tests/conformance/png-lowbit.test.ts)

## 托管结果与编译修复

113–117 的冻结快照均为终态失败。118 的主构建和两个独立分配器构建在原生编译阶段失败。JPEG 输入生成、独立比较和应用测试均未执行，快照时还有两个作业运行。114–118 的 PNG 原生参考作业报告成功，产品差分仍被跳过。以上均为 GitHub 的作业状态。

源码检查确认 `tjsError.h` 在关闭 `namespace TJS` 后声明了全局 `TJSReadError` holder，格式化器却引用 `TJS::TJSReadError`。本批改为引用实际的全局对象，仍从当前 VM 的 holder 读取脚本分配的消息。118 的公开日志只显示编译步骤退出码 1，手头证据尚不能确定它的全部编译诊断。[消息声明](../../third_party/tjs2/tjsError.h) · [格式化器](../../native/tjs2/tvp-messages.cpp)

本轮一次取回 113–118 的 run、jobs、artifacts 共 18 个元数据端点。85 份已列产物中，已有的 10 份原 ZIP 共 3,349,103 字节，全部复核大小与哈希。75 份新 ZIP 和 20 份失败日志在本机请求时遇到 GitHub 权限或速率限制。错误响应及此前的 2 份失败日志已保留，缺少的原件单列。下一批补取 118 尚未报告的部分及 119 结果。

本批为这 95 份缺件安排同仓一次性归档。托管作业按已冻结的 ID 清单直接读取，校验 ZIP 的大小和 SHA-256，逐个记录日志结果和未取得项。仅修改回收清单的推送触发该流程。归档结果与产品验证分别记录。[回收请求](../../.github/evidence-recovery/119-request.json)

PNG／JPEG 内核、JPEG 输入和各自参考作业均已拆出主 TJS 编译路径。主构建和差分作业下载同一份内核产物。PNG 低位与透明度的 8 个 Node 定义单独执行，在常规 Node 套件中计数一次。本批共新增 24 个常规 Node 定义、每个浏览器 4 个定义及 11 个独立 SDK 对照，全部等待托管结果。[完整工作流](../../.github/workflows/test.yml)

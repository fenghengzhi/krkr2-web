# 第 130 批游戏数值、图像和交互

## TJS 十进制坐标与存档

原版 2.32 的词法器先提取十进制实数字面量，再交给 Windows C 运行库的 `wcstod`。Web 所用代码原先把长尾数分进两个整数累加器，超过这些累加器容量的有效数字会改变结果。127 的 Wave 坐标对照已经出现这一差异。Web 现在把词法器提取的 ASCII 数字交给 C 运行库的 `strtod`。这同时适用于脚本中的实数和 `real(字符串)`。写字节码时以完整的 64 位表示作为实数常量的键，保留正零与负零的区别，也能让 NaN 和其他有限常量分别占用正确的位置。[原版词法器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/tjs2/tjsLex.cpp#L607) · [原版运行库映射](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/tjs2/tjsConfig.h#L71)

验收包含 21 个数值，覆盖原 Wave 坐标、长小数、指数、舍入边界、正常有限值两端、上溢、下溢及带后缀的字符串。原版 SDK 分别将字面量、转换结果和重新读档的结果用 `Array.saveStruct` 写成文本。比较程序读取原版保存的十六进制有效数字和指数，逐项核对完整的双精度值。Linux 的 Web 会话还会导入同一提交的原版存档，分别走源码和字节码路径。浏览器读取这三份游戏存档，把坐标应用到真实图层并检查整张画布。[数值样例](../../tests/helpers/decimal-reals.ts) · [跨引擎存档](../../tests/probes/decimal-sdk.ts) · [图层位置验收](../../tests/browser/decimal-reals.spec.ts)

## 有损 ERI 的原版像素

128 的 Windows 原件中，4:4:4 作者工具图片为 2,000 字节，图像帧头符合预期。4:2:2 的文件只有 232 字节，`ImageFrm` 长度为零。转换器返回退出码 0，但标准输出报告处理了零张图片。此时尚未启动 SDK，所以 128 没有 DCT 原版像素结果。三个独立的 Web DCT 公式、图像行和错误阶段测试在该批的托管 Windows 作业中已通过。[128 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45511886991)

本批使用作者工具为有损模式设置的 `-l=dct.ini` 生成全部三种采样图像，去掉叠加在旧 4:2:2 请求上的标准模式选项。另有同一色差信号的独立 Gamma 与 Huffman 输入，供 SDK 逐像素对照。工具日志、原输出和失败原因按图片保存，即使一个输入无法生成，其他有效图片也会送入原版。缺少输入仍会令总比较失败。Chromium 的专门验收将实际作者 ERI 加载到游戏画布，并与同一提交中原版 Windows 进程写出的每个 RGBA 通道比较。旧的 4:2:2 标准模式作者输出仍是失败记录。[转换器参数](https://github.com/uyjulian/erinalib/blob/829244b10337bf70cd91c19174becce4e7dfd690/samples/ericvt/ericvt.cpp) · [输入生成](../../tests/probes/eri-encoder.ts) · [原版像素画布对照](../../tests/browser/eri-sdk-pixels.spec.ts)

## 影片定位、窗口输入与调色

127 的 WebKit 在暂停影片换轨后确实提交了新画面，回调中的帧计数从 1 增至 2。但 AVFoundation 提供的显示时间比本次定位请求早，旧检查会舍弃该回调并等待至超时。新路径同时核对容器里的采样区间、变化的帧计数、暂停时钟及回调时间；重复、先前已见或不能唯一定位的帧继续走原检查。画面仍须来自实际解码结果。Firefox 在测试中有第三个解码器尚未上报首帧，此项仍需解决。[WebKit 的采样时间计算](https://github.com/WebKit/WebKit/blob/4071afa32da3286913ba60667e39457828bf4b41/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm) · [定位与画面提交](../../src/backends/video/browser/clock-seek.ts)

原版游戏可以把手柄操作映射为 `Window.postInputEvent`。本批让启用鼠标键的窗口按目标窗口自己的输入状态处理投递的按键。脚本投递的字符按原入口先转整数，再取低 8 位；Web 会话用日文 CP932 解释字节，分别保存各窗口尚未配对的前导字节。桌面原版使用系统 ANSI 代码页，这一选择会影响高字节字符。真实浏览器文字输入继续走 Unicode 路径。新内核用可选导出标记原参数转换支持，既有内核仍可使用其原入口。浏览器验收用发行模板自己的 KAG 按键映射把 F8 转为 Return，检查一次实际鼠标点击及点击后的画面。[投递字符状态](../../src/engine/input/posted-key.ts) · [窗口入口](../../src/engine/tvp/window.ts)

`Layer.adjustGamma` 可以使用超出 0–255 的有符号黑白点来扩展对比度。颜色查找表在换算后将输出限制到通道范围。新增原版对照使用裁剪区、低透明度像素、遮罩和省份图确认最终结果，还覆盖 gamma 为 9.5 的有效调用。[通道查找表](../../src/engine/graphics/gamma.ts) · [逐像素图层验收](../../tests/helpers/layer-gamma.ts)

## 已取回的托管结果

127 已终态失败。完整浏览器报告有 3,086 项符合预期、124 项意外失败、2 项跳过。128 冻结时主构建已成功，原版介绍游戏出现三个链接，四组字体观察及窗口绘图设备控制匹配。原版 KAG 42/42、跨引擎书签 86/86、JPEG 43/43 匹配。Wine 的软件声音设备完成了全部 29 项声音对照；托管 Windows 匹配 27 项，另外两项需要播放设备。原版透明转场仍只有一项直接拷贝匹配，全部 64 个像素帧未报告。129 仍在等待，尚无作业结果。这次共归档 93 份原 ZIP，逐份校验大小和摘要，合计 1,150,347,275 字节。[127 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45508747480) · [128 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45511886991) · [129 工作流](https://github.com/fenghengzhi/krkr2-web/actions/runs/45514385708)

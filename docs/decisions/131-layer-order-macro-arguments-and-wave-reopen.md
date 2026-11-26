# 第 131 批图层顺序、宏参数和声音换轨

## 图层与菜单

原 KAG 模板给人物层、消息层和历史层分配间隔很大的 `absolute` 值。模板把这个值写入书签，读档时再交给 `Layer`。Web 原先用兄弟层数量给新层编号，历史层之后加入的按钮可能得到 2，而原版会接着 2,000,000 分配 2,000,001。现在创建与重新挂接都沿用父层的排序方式。几个层共用一个值时，重新指定相同值也能改变前后顺序并触发重绘。[原版图层管理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L572) · [Web 图层树](../../src/engine/scene/layers.ts)

`getLayerAt` 将调用层的局部坐标转换到所属主层，在该层管理器中从前往后查找。排除调用层后仍可命中重叠的兄弟层。窗口收到的指针输入交给实际显示的管理器。SDK 与 Web 共享十步观察，涵盖同值重排、重新挂接、符号位、局部坐标、脱离父层、禁用目标及可选参数转换。浏览器另在原 KAG 模板上调用它自己的 `store` 和 `restore`，逐步核对重叠按钮的命中对象和屏幕颜色。[原版坐标转换](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2884) · [共享观察](../../tests/helpers/layer-order.ts) · [原 KAG 读回层顺序](../../tests/browser/kag-layer-order.spec.ts)

128 的绘图设备用例中，两个源码场景成功，相同脚本导出的字节码在载入时被拒绝。类编译器原先漏记求值 `Window.PassThroughDrawDevice` 这样的多级基类名所需的临时寄存器。现在导出的栈帧包含这些寄存器。新验收分别在全新的 VM 中加载带调试信息和无调试信息的同一脚本。另给直接运行时验收补齐了窗口和默认绘图设备各自的弱引用计数，分步核对替换、解绑及窗口释放。[编译器](../../third_party/tjs2/tjsInterCodeGen.cpp) · [跨 VM 载入](../../tests/integration/scripts.test.ts) · [窗口生命周期](../../tests/helpers/window-lifetime-runtime.ts)

## 剧情宏与声音

KAG 脚本可以保留 `mp` 的字典引用。原版在相同调用深度再次进入宏时，会清空同一个字典并填入新参数。Web 现在保留各深度的字典，存档只写活动调用，复制解析器时另建字典并保留其中对象的引用。七项新控制覆盖嵌套调用、清理、赋值及存读档后继续剧情。[宏参数实现](../../src/engine/tvp/kag.ts) · [原版与 Web 共用的剧情](../../tests/helpers/kag-macro-slots.ts)

`WaveSoundBuffer.open` 更换或无法打开媒体时，正在进行的音量淡变属于声音对象。此批在释放旧解码器、页面和滤镜后保留淡变的目标、当前音量和计时进度。再次播放及显式定位会提前请求目标采样页。128 的 Node 录音在远端定位后的首个区块收到了 160 个静音采样，对应的 Chromium AudioWorklet 四项通过。新托管对照将检查首段 PCM、音量回调和终止时的资源释放。音频后端新增用于卸下媒体的命令，会话协议升至 46。[声音服务](../../src/engine/media/sounds.ts) · [混音器](../../src/engine/media/mixer.ts) · [换轨对照](../../tests/helpers/wave-reopen.ts)

## 已取回结果与待验收项

本轮已保存 128 至 130 的终态、作业清单及全部 117 份原始产物，共 1,317,374,581 字节。先前保存的 52 份继续沿用，补齐了 128 的最后五个浏览器分片以及 129、130 各 30 份产物。文件按 GitHub 提供的大小和 SHA-256 校验。暂停前的部分报告保留了当时可见的结果。

128 已终态失败。3,986 个 Node 用例有 3,972 个通过、14 个失败。浏览器报告共 3,236 项，3,109 项符合预期、125 项意外失败、2 项跳过。Chromium 和 WebKit 的两个后端均完成介绍游戏的菜单存读档、刷新恢复和游戏内退出，Firefox 的两个后端仍在首次选择处失败。[128 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45511886991)

129 和 130 均因 XP3 测试中同一处 TypeScript 空数组类型收窄而未完成生产构建。本批保留对零次读取的断言，改为检查读取记录的长度。原版也报告不存在 `Storages.createTextStreamForRead`，共享 XP3 游戏现用原版公开的 `Array.load` 读取同一分段文本。[129 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45514385708) · [130 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45518090473)

130 的原版 SDK 匹配 42 项 KAG、21 项转场选项及全部 3 项图层调色观察。三个作者工具 DCT 图片和一个手工 Huffman 图片均取得匹配的原版像素。另五项的原版报告为 ERI 初始化失败。本批据此收窄已证输入组合的加载行为，并交叉检查格式版本与压缩方式。[ERI 加载器](../../src/formats/image/eri.ts) · [原版图片比较](../../tests/probes/eri-sdk.ts)

窗口投递输入的 11 项 SDK 观察中有 9 项匹配。本批校正对象转换错误对应的消息，并增加鼠标所在位置、窗口状态及计时器中投递普通按键的对照。原版未报告预期的鼠标点击序列，原因仍待验证。[窗口输入对照](../../tests/probes/window-post-input-sdk.ts)

原版保存的 21 个实数中有 20 个与预期的最近双精度值逐位一致。`1.7976931348623157e308` 的字面量、字符串转换和重新存档都得到 `7feffffffffffffe`，与最近双精度值相差一个单位。托管比较现以原版文件为依据，保留 Web 的逐位验收，并增加 12 种相邻数值及等价写法。该边界的 Web 转换尚待校准。[数值样例](../../tests/helpers/decimal-reals.ts) · [跨引擎比较](../../tests/probes/decimal-sdk.ts)

第 131 批的实现提交为 `2afe64d17c0a2b7d494f843762476afb144bf122`。GitHub 将应用与兼容性验证登记为 `queued`，尚无运行结论。[131 托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45755797755)

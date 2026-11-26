# 第 133 批游戏书签、透明图层截图和声音定位

## 游戏书签

原 KAG 允许作者设置 `saveMacros=false`。游戏仍会保存剧情位置、调用栈和活动宏参数，但会把宏定义字段设为 `void`。此前 Web 在读回这种书签时会抛出字典格式错误。现在读档保留当前游戏的宏定义，并恢复剧情位置及参数。书签明确保存了空字典时，引擎仍会清空当前宏。四个新增共享场景覆盖同一解析器、跨解析器、活动宏和显式字典。浏览器在原 KAG 模板中点击存档、读档及继续链接，并在刷新后再读一次。[解析器](../../src/engine/kag/parser.ts) · [原版与 Web 共用的场景](../../tests/helpers/kag-optional-macros.ts) · [游戏读档](../../tests/browser/kag-optional-macros.spec.ts)

## 截图、软件显示与 BMP

131 的 Node 报告显示，完整不透明的红色图层合成到黑底后，截图中本应为 192 的红色值降到了 191。对半透明图层，旧验收也假定加速显示与保存的位图始终相同。原版的 MMX 绘制函数对一个完整扫描行分段处理。较短的段能直接复制全不透明像素；成对段遇到不同透明度时，会用 256 作分母混合包括遮罩在内的四个通道。一个红色值 255、遮罩 64、图层不透明度 128 的单像素叠在不透明黑底上，截图中的红色值为 31，遮罩为 231。[原版扫描行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/IA32/alphablend.nas) · [Web 扫描行](../../src/engine/graphics/alpha-row.ts)

Web 的截图、软件绘图设备和直接矩形操作现使用这一路径。目标完全位于裁剪区且大小与源相同的正向伸缩，按原版直接执行矩形操作。十一项原版和 Web 对照使用奇偶起点、不同遮罩与嵌套图层，分别读取 RGB 和遮罩。其中一项从相同来源连续截取宽 5、宽 1、再宽 5 的区域，检查第一次合成的缓存会不会改变后续裁剪结果。另一项从启用缓存的子层中间截取八个像素，核对起点仍按子层的坐标对齐。加速显示保留独立的显示断言，软件设备还会检查实际浏览器画布。[共享图层脚本](../../tests/helpers/layer-alpha-rows.ts) · [软件显示验收](../../tests/browser/layer-alpha-rows.spec.ts)

原 KAG 默认将存档缩略图写为 133 × 99 的 8 位 BMP。新增验收检查调色板、全部索引像素和附在图像后的剧情数据，刷新后分别载入 8 位、24 位书签。BMP 编码现在分批处理扫描行，只在完整编码后写入存档。托管的暂停和停止用例覆盖新文件和覆盖旧文件两种情况。[实际缩略图](../../tests/browser/kag-thumbnail.spec.ts) · [BMP 编码](../../src/formats/image/bmp.ts) · [取消写入](../../tests/integration/image-writing.test.ts)

## 声音定位

游戏给 `WaveSoundBuffer.position` 赋毫秒值时，原版按最近创建的输出缓冲区的采样率做整数换算。例如 44.1 kHz 的声音已经播放过后，1 毫秒定位到第 44 个采样。新对象首次播放前输出采样率为零。换文件后到下一次成功开始播放之间，毫秒定位沿用先前输出的采样率。直接设置 `samplePosition` 使用采样单位。对于长度已知的声音，恰在末尾或超出范围的采样位置会保留当前进度和循环状态。[原版声音实现](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L2990) · [Web 声音对象](../../src/engine/media/sounds.ts)

Windows 与 Wine 用实际播放时到达的第一个 SLI 标签对照七次定位。Web 源码和字节码用例另检查 PCM、暂停及正在播放时的定位、循环标签与淡变，浏览器采集实际混音输出。新旧文件分别采用 44.1 kHz 与 48 kHz，能区分换文件前后的输出缓冲区。[原版标签场景](../../tests/helpers/wave-seek.ts) · [Web 采样验收](../../tests/integration/wave-seek.test.ts) · [浏览器播放](../../tests/browser/wave-seek.spec.ts)

## 已取得的结果

131 的主构建已成功。4,027 个 Node 用例中 4,014 个通过、11 个失败、2 个因超时取消。11 个断言失败都发生在图层合成或截图像素上。两项取消均发生在等待 Wave 源读取时，现改为等待 PCM 解码器读取 RIFF 头，保留播放、淡变和停止的检查。跨引擎 KAG 书签 100/100 项匹配，Chromium 和 Firefox 的兼容性验收各通过 32 项。这次快照仍缺少主浏览器的游戏路线。[131 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45755797755)

131 的十进制数值对照有 6/18 组完全匹配。接近双精度上限时，Web 在部分输入上会相差一个可表示值，或将原版仍可表示的数转成无穷。已有原版文件可定位到十进制转换过程，精确的原运行库算法仍待确认。Chromium 的原版 DCT 图片比较步骤显示成功，上传报告的步骤失败。此批为该比较和原版书签浏览器比较加入了可归档的 JSON 报告。[数值比较](../../tests/probes/decimal-sdk.ts) · [托管工作流](../../.github/workflows/test.yml)

131 的这次快照和 132 的首次回收共列出 41 份产物，按大小与 SHA-256 核对后共 179,542,589 字节，其中 23 份是新取回的。132 当时状态为 `pending`，尚无作业和产物。[132 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45757288264)

第 133 批新增 23 个 Node 用例，每个浏览器项目新增 14 个用例。原版 Windows 图层对照共 56 项，KAG 对照 61 项，声音对照 41 项。新增实现及真实游戏路线等待 GitHub 托管结果。

最终实现提交为 `88601e3d59021edd5eacde72a5698e746aad28f8`，包含缓存子层局部截图的修正。它与本批首个提交 `25cd99d` 各有一次托管运行，登记时均为 `pending`。下一批取回各自提交的结果。[133 最终提交的验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490) · [133 首个提交的验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623)

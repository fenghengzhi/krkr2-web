# 第 129 批压缩 XP3、游戏取图与声音打开

## 从压缩包播放大声音文件

上一版只有全部分段均为原样存储的 XP3 成员提供范围读取。只要其中一段经过 zlib 压缩，声音服务就需要先读完整成员，因此无法打开超过 64 MiB 的此类文件。

本批让游戏通过原有资源名读取原样段与压缩段混合的成员。查找从逻辑偏移所在分段开始。第一次进入压缩段时，读完该段的 zlib 流并核对解压长度，然后向调用者交付请求范围。其他分段在用到时才读取。单次请求和显式整文件读取沿用 64 MiB 上限。播放器可在更大的成员中前后定位。仅注入整块解压函数的低层工具继续使用原有的完整读取；显式要求核对全文件 Adler-32 的工具也保留该约定。解压数据或长度错误使用游戏可本地化的 `TVPUncompressionFailed`，底层读取失败保留原始错误。[XP3 读取](../../src/formats/xp3/archive.ts) · [原版分段处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/XP3Archive.cpp)

原版会完整解压当前段，另有总计 1 MiB 的小段缓存。Web 沿用小段缓存大小。对于较大的段，播放会话最多保留四个解压位置及各自最多 1 MiB 的预读数据，方便音乐和语音同时读取。超出窗口的反向定位可能需要从段首再次解压。交付给调用者的数组独立拥有其字节。停用等级的 `System.doCompact` 清理共享缓存，后续仍可从同一资源继续读取。停止会话时会释放解压器并唤醒等待读取的调用者。[分段缓存](../../src/formats/xp3/segments.ts) · [浏览器流式解压](../../src/backends/files/xp3-inflater.ts)

验收包把 WAVE 的 44 字节文件头和 72 MiB PCM 数据放在同一个压缩段里，另有以混合分段存储的 UTF-16 文字与剧本。测试按小块生成原始数据并保存其 SHA-256。开头、远端和回跳位置的声音具有不同音调及振幅。Windows 原版检查真实的打开文件、声音属性及文字行为。Node 的源码与字节码游戏会话逐样本比较左右声道，浏览器从实际 AudioWorklet 观察三处音调、声级、SLI 标签与退出后的页面释放。整段的首次校验需要读取其全部压缩输入。[验收素材](../../tests/helpers/xp3-segment-fixtures.ts) · [游戏逐样本比较](../../tests/integration/xp3-compressed-audio.test.ts) · [浏览器播放与定位](../../tests/browser/xp3-compressed-audio.spec.ts)

## 原版游戏中的取图、字号与声音

127 的 Node 和 Firefox 都报告了透明图层取图的颜色差异。对 `piledCopy` 需要合成的普通子树，先转为显示用的预乘颜色再转回会丢掉低透明度像素的原始 RGB。本批改用图层自身格式的合成结果，复制调用者独占的颜色及遮罩。原有目标裁剪、绘制回调、尺寸改变和像素断言继续执行。[图层快照](../../src/engine/scene/composer.ts) · [原版图层拷贝](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp)

127 两个 Firefox 后端的介绍游戏都在第三个链接出现前发生分页。40 像素常规标题测得 553 像素，游戏的换行阈值为 552。新字体选择继续优先使用游戏请求的字体，在缺少 MS PMincho 时依次尝试 Times New Roman、Liberation Serif、Times，最后才使用浏览器通用衬线字体。宿主仍决定实际可用字体，原字体的全部字形和度量尚未复刻。验收保留完整游戏路线，另外比较 Worker 中真实可用字体的测量与绘制。[字体回退](../../src/backends/text/browser/families.ts) · [浏览器字体验收](../../tests/browser/font-backend.spec.ts)

Wave、MIDI 和 CDDA 的 `open` 先检查参数并转换文件名，然后才执行已有的打开流程。在播放中传入缺失参数或无法转为字符串的值时，当前声音、标签和渐变继续工作。原版 SDK 与真实游戏脚本检查可本地化的两种错误。Wave 坐标的既有精确断言改用数值相同的二进制分数，避免期望值本身依赖长十进制字面量的解析。[声音入口](../../src/engine/tvp/sound.ts) · [打开失败后的播放验收](../../tests/integration/sound-open.test.ts)

## 上批结果

127 的主构建成功。冻结时 53 项作业中 42 项成功、4 项失败、7 项仍在运行。Node 已登记 3,971 项，其中 3,957 项通过、10 项失败、4 项未报告。已取回的 634 项浏览器结果中有 623 项符合预期、10 项意外失败、1 项跳过。独立的原版书签对照 86/86 匹配，三个兼容性作业各通过 32/32，JPEG 对照通过 43/43。透明转场原版仍只有一项直接拷贝匹配，64 个逐帧像素观察均未报告。[127 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45508747480)

128 冻结时处于等待状态，尚无作业或产物。129 共回收两批当时已列出的 50 份原 ZIP，并逐一核对大小与 SHA-256，合计 534,042,601 字节。完整归档清单位于 `out/verification/github-actions/129-archive-summary.json`。Firefox 介绍游戏的实际菜单、影片切轨和 128 新加入的有损 ERI 等待后续托管结果。[128 全套验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45511886991)

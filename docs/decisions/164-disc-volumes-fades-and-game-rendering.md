# 第 164 批光盘识别、跨轨淡出与游戏画面

本批补齐游戏按卷标找盘、换 CD 音轨时延续淡出，以及两套预渲染字体的独立映射。影片与字幕验收同时处理已归档的普通浏览器失败。以下新增实现和用例均待 GitHub-hosted 执行。

## 光盘卷标与跨轨配乐

`Storages.searchCD` 现在按盘符 A–Z 查找导入光盘的卷标，返回首个匹配盘符，未找到返回空字符串。CUE 数据轨从 `INDEX 01` 定位 ISO 9660 卷描述符，识别普通主卷标及 Joliet 字符，支持 MODE1/2048、MODE1/2352、MODE2/2336、MODE2/2352。对支持分段读取的镜像，最多扫描本轨内 64 个描述符头。音频盘使用 `Audio CD`。玩家也可在现有光盘设置中用 `D.label=GAME_DISC` 指定卷标，并随游戏库保存。按盘符读取 ISO 内的游戏文件仍待实现。[卷标读取](../../src/formats/disc/volume-label.ts) · [盘符查找](../../src/engine/storage/cdda.ts) · [玩家设置](../../src/app/cdda-settings.ts) · [Microsoft CDFS 读取卷描述符](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/cdfs/fsctrl.c)

原版依据是固定 2.32stable `StorageImpl.cpp` 的 `TVPSearchCD`：遍历 CD-ROM 盘符，读取卷标并作不区分大小写的比较。本批在托管 Linux 使用 `genisoimage` 独立生成普通 ISO 与 Joliet ISO，由 `isoinfo` 核对卷标及真实文件内容，保存 SHA-256。Windows 托管对照只读挂载同一输入，核对系统卷标和盘符后运行原 KRKR2 的 `Storages.searchCD`，保留进程记录与卸载结果。该对照尚未运行。[原版来源](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/StorageImpl.cpp#L1174-L1194) · [独立输入验收](../../tests/conformance/disc-volume.test.ts) · [Windows 对照](../../tests/probes/disc-volume.ps1)

原 `CDDAImpl::Open` 停止当前曲目，并在换盘时关闭、重开设备；这条路径保留基类淡出。网页端现在同样保留音量、淡出进度及原完成时点，同盘换轨与跨盘换轨分别维持相应状态。每次打开独立保存选轨参数，使状态回调中另一次选轨不会覆盖外层调用。新增验收包含 120ms 淡出跨曲目的逐采样比较、读取挂起时继续淡出，以及游戏按钮和实际 Worklet 声音。[原版 Open/Close](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/CDDAImpl.cpp#L291-L494) · [声部接线](../../src/engine/media/sounds.ts) · [会话验收](../../tests/integration/cdda-reopen.test.ts) · [游戏验收](../../tests/browser/cdda-reopen.spec.ts)

## 字体映射与字幕像素

原版 `tTVPFont` 比较保留字号正负号；`ApplyFont` 先按完整字体查找预渲染映射，再取字号绝对值交给绘制器。新图层默认 −12，执行 `font.height=font.height` 后成为 +12，二者可以绑定不同 TFT。现通过 `mappingHeight` 保存映射身份，后端绘制尺寸继续使用正值，避免字幕字体互相覆盖或撤销。[映射键](../../src/engine/graphics/fonts.ts) · [字体描述](../../src/engine/graphics/font.ts) · [固定原版字体比较](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/tvpfontstruc.h)

两份独立 TFT 提供 37/53 像素字距及不同条纹字形。新增 2 个原版 SDK 对照、2 个源码/字节码会话定义和每浏览器 4 个游戏定义，检查共存、独立撤销、字号规范化及重新创建图层后的完整画面。原 SDK 图形库存由 124 增至 126，新增项尚无结果。[独立字体与字面预期](../../tests/helpers/font-mapping-height.ts) · [真实点击验收](../../tests/browser/font-mapping-height.spec.ts)

第 160 批 Firefox 原 trace 的画布内部尺寸正确，但 CSS 顶边为 331.20001220703125px、DPR 为 1，元素截图向外取整多出一行。本批仅调整两个字幕用例：按真实画布原始分辨率比较全部 RGBA，仍保存未经裁剪或缩放的屏幕 PNG 与几何记录。所有阶段、玩家点击和像素门槛保留。另将游戏配置夹具的 `dfOpaque + holdAlpha` 填色改为原接口要求的 24 位 RGB，保留原颜色及 mask 预期。[画布读回](../../tests/helpers/canvas-pixels.ts) · [装饰字幕](../../tests/browser/text-decoration.spec.ts) · [空行布局](../../tests/browser/text-metric-cache.spec.ts)

## WebKit 的首帧时钟

已归档 WMV1 素材的首视频样本在 43ms，而打开后的媒体时钟为 0ms。WebKit 此时可已加载数据却尚未提交可见帧。播放器现在仅在已知首样本晚于当前暂停时钟且尚无呈现回调时，将私有候选影片定位到首样本，等待真实首帧，再恢复打开时钟。该过程不开始播放，也不以 `loadeddata` 替代帧呈现。原游戏验收增加打开后 `frame|position` 精确为 `0|0`，保留实际播放、定位、双图层与声音断言。[首帧路径](../../src/backends/video/browser/host.ts) · [影片游戏验收](../../tests/browser/legacy-video.spec.ts)

## 本次已取回的证据

2026-11-26 14:01:35 UTC 的唯一快照新增第 160 批六份普通报告：

| 报告 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Firefox 主浏览器第 1 分片 | 285 | 47 | 1 |
| Firefox 主浏览器第 2 分片 | 303 | 48 | 0 |
| Firefox 主浏览器第 3 分片 | 292 | 32 | 0 |
| Firefox 游戏库 | 25 | 49 | 0 |
| WebKit 主浏览器第 2 分片 | 303 | 48 | 0 |
| WebKit 游戏库 | 26 | 48 | 0 |
| 合计 | **1,234** | **272** | **1** |

六份 ZIP 共 753,317,204 字节，另复用 44 份历史普通原件；全部与冻结目录中的大小、SHA-256 核对。第 160 批当时仍在运行，Node 和 WebKit 第 4 分片已取消，未完成范围不计通过。第 161、162、163 批在该快照均为 `pending`、没有作业或产物；本批修订也没有托管结果。原报告、失败附件及历史判断完整保留，后续候选不改写旧结果。本地归档位于 `out/verification/github-actions/164-archive-summary.md`。[WebKit 第 2 分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938356329) · [第 160 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404)

第 164 批实现提交 `86c415d53f0fd1f69d4190205f4ed2f2819c2520` 登记时为 `pending`。下一批取回可用结果。[第 164 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45837990362)

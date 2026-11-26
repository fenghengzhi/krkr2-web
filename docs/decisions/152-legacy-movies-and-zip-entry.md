# 第 152 批旧过场影片与 ZIP 启动入口

本批让使用旧 MPEG／AVI 过场影片的游戏有一条浏览器内转换路径，并修复 ZIP 发行包忽略自定义启动脚本的问题。实现已经落盘，真实构建、转换、游戏操作和离线运行均等待 GitHub-hosted Actions 验证。下文列出新增验收要求，执行结果待取得。

## 旧影片进入现有游戏播放路径

游戏仍使用 `VideoOverlay.open` 打开原文件。播放器根据文件名识别 `.mpg/.mpeg`、`.mpv/.m1v` 和 `.avi`，在独立 Worker 中完成转换，再把实际 MP4 时间轴和影片交给现有播放、定位、图层输出与声音通道。普通 MP4/WebM 不经过转换；把这两种原生容器改成旧扩展名的文件也保留原始媒体字节。[入口](../../src/backends/video/port-backend.ts) · [格式识别](../../src/backends/video/legacy/format.ts)

固定转换器使用 FFmpeg 5.1.9、OpenH264 2.6.0 和 Emscripten 6.0.9，源码归档的大小与 SHA-256 固定。仅启用 MPEG 节目流、MPEG 视频基本流、AVI 解封装，以及 MPEG-1、MJPEG、Cinepak 视频和 MP2、PCM `u8/s16le/s24le/s32le/f32le/f64le` 音频解码。输出为 H.264 constrained baseline、YUV420P 与 AAC 的 MP4。不支持的输入编码明确失败；MPEG-2、WMV、其他 AVI 编码及系统安装的解码滤镜不在本批范围。[源码清单](../../native/legacy-media/source.json) · [构建](../../scripts/build-legacy-media.mjs) · [转换参数](../../src/backends/video/legacy/convert.ts)

转换保留所有支持的音视频流，输入最多 16 流，使用共同的输入时间原点，保留音画之间的偏移。转换后的画面和声音是有损结果，原版 DirectShow 的像素、PCM、色彩管理与设备输出等价仍未验证。验收分别检查帧数、时间戳和实际画面。

| 资源或行为 | 本批范围 |
| --- | --- |
| 单个转换输入与输出 | 各最多 128 MiB；待处理的自有输入和暂存输出分别记账 |
| WASM 线性内存 | 每个转换实例最多 512 MiB；浏览器其他内存另计 |
| 解码限制 | 单幅最多 16,777,216 像素，单次原生分配最多 64 MiB |
| 并行与时间 | 每个会话一个活动转换，后续请求有序等待；单次最多五分钟 |
| 读取与输出 | 不可变 Blob 通过只读 WORKERFS 读取；输出分成 64 KiB 页，完成后才交给播放器 |
| 关闭、替换、停止 | 取消对应转换，退出等待队列；迟到结果不能打开已退休影片 |
| 离线 | 发布包包含独立转换器与许可证；每个 JS/WASM 资产小于 16 MiB，并参与发布校验与离线缓存 |

需要完整缓冲的来源仍遵守既有视频来源预算。取消后尚未返回的底层读取保持记账，直到它实际结束。游戏库保存原始导入文件，中间 MP4 只用于本次播放；以后重新打开原影片仍可能需要转换。播放器首次打开需等待转换完成，浏览器自动播放限制也仍适用。[Worker 生命周期](../../src/backends/video/legacy/transcode.ts) · [发布资产](../../scripts/build/legacy-media-assets.ts)

## ZIP 发行包使用玩家指定的入口

发行包可能同时含 `Release/data/boot.tjs` 和工具示例的 `Release/Tools/startup.tjs`。此前散装目录会参考玩家指定的入口，ZIP 自动识别却仍按默认启动文件选择目录，因而可能进入工具示例。本批让两种来源使用相同入口提示；相对资源、嵌套 XP3、程序目录和存档目录随选中的游戏根一起确定。[发行包识别](../../src/engine/storage/distribution.ts)

显式入口如 `release.zip>Release/data/boot.tjs` 则保留外层 ZIP 地址，不先拆掉它再用已经失效的地址启动。首次打开和新会话用同一入口读取相同内容。**已经保存的 root／distribution 选择优先**：游戏库重开沿用其保存的目录和入口，下一次导入界面里的设置不会重新选中另一款游戏。默认 `startup.tjs`、手动目录、文件集合和多游戏歧义的既有规则保留，存档身份格式不变。

实际游戏验收将原 `kag3_template.xp3` 的成员字节保持不变，放入带工具负控的 ZIP，通过 `boot.tjs` 启动原系统。玩家选择章节 7、保存，再改变为 99，加入游戏库并刷新。重新启动先显示初始状态，再由原游戏的 Load 链接恢复 7；导出的原生书签字节必须保持一致。[游戏输入](../../tests/helpers/custom-entry-distribution.ts) · [库中继续剧情](../../tests/library-browser/custom-entry.spec.ts)

## 托管验收要求

独立输入由托管 runner 上的原生 FFmpeg 从作者指定的 RGB 和 PCM 生成，期望来自这些作者数据及独立解码记录。基础输入为 MPEG-1/MP2 节目流、MJPEG/PCM AVI、无音轨 MPEG-1 基本流，另覆盖 `.mpeg/.mpv` 别名。每段有 100 帧、25 fps、逐帧黑白编码、三段颜色和已知音调；节目流保留 B 帧及真实的约 0.3 秒音轨偏移。若托管 FFmpeg 提供 Cinepak 编码器，在同一真实 WASM 用例中增加该输入，否则明确记录未验证。[独立夹具](../../scripts/generate-legacy-video-fixtures.mjs)

Node 将独立输入的哈希和原生帧时间戳与发布 WASM 的实际 MP4 对照，保存转换文件、CLI 日志和两侧时间轴。浏览器源码／字节码两条路径都用真正的游戏按钮定位、prepare、播放和停止。逐帧标记须对应目标帧；定位稳定后，实际解码帧、生产提交和左右两张 Layer 的完整 RGBA 必须一致。作者颜色按有损编码允许的显式范围检查，声音检查已知频段和偏移；原版设备的逐像素等价仍在验证范围之外。[真实 WASM](../../tests/conformance/legacy-media.test.ts) · [游戏操作](../../tests/browser/legacy-video.spec.ts)

PWA 用例先保存含 AVI 的游戏，但不打开影片；关闭真实子路径服务器、刷新并从库启动后，才第一次点击播放转换。这样必须依赖已缓存的真实转换器，不能由断网前的中间 MP4 掩盖资产遗漏。[离线首次转换](../../tests/pwa-browser/legacy-video.spec.ts)

新增定义库存为 **15 项 Node、每浏览器项目 4 项常规影片、4 项游戏库、2 项 PWA**。Node 包含 10 项 Port 取消／预算与旧路径控制、1 项真实 WASM 输入矩阵、1 项转换 Worker 生命周期，以及 ZIP 的 1 项格式识别和 2 项源码／字节码会话。缺少 JSPI 的浏览器按已有能力门槛记录跳过，不计通过。本批不新增 Windows 原版影片像素对照。[Port 测试](../../tests/conformance/legacy-video-port.test.ts) · [ZIP 会话](../../tests/integration/zip-custom-entry.test.ts)

## 本次取回的历史证据

本批固定取回 49 份新 ZIP，共 146,953,279 字节，均与冻结目录的大小和 SHA-256 一致；另复用 20 份第 143 批已校验原件，所选 69 份齐全。原 ZIP、原始失败与逐项观察均保留。索引在 `out/verification/github-actions/152-artifact-inventory.json` 和 `152-archive-summary.json`。

第 143、144 批已结束，各为 24 个作业成功、4 个失败、10 个跳过。144 构建仍报 `host.ts` 的 `frame` 联合类型 TS2339，与此前相同，依赖应用构建的 Node 和主浏览器明确跳过。第 145 批冻结时为 18 个作业成功、2 个失败、1 个跳过、6 个进行中；主构建尚未到类型检查和生产发布，Node／主浏览器未列出。145 的类型修订因此仍未被本次证据证明通过。[143](https://github.com/fenghengzhi/krkr2-web/actions/runs/45777718215) · [144](https://github.com/fenghengzhi/krkr2-web/actions/runs/45779775709) · [145](https://github.com/fenghengzhi/krkr2-web/actions/runs/45783361496)

144、145 原版 KAG 均 **87/87** 匹配；原版图形均 **75/80**，仍是 143 已发现的五项 sprite 差异，151 的候选修改不属于这些历史运行。143 Wine 声音 **44/44**、144 Wine 声音 **46/46** 匹配；144、145 Windows 声音各 **40/46**，其余六项原始报告为 DirectSound 不可用，不能用 Wine 通过覆盖。145 Wine 在冻结目录中未报告。配置参考仍计划 5、实报 0；透明转场仍为 1 项匹配、80 项未报告。

146–151 在同一次快照中都仍排队，没有执行结论。最近完整常规浏览器报告仍是第 135 批的 **3,242 通过、101 失败、2 跳过**；这些失败及后续修订继续保留，不能以本批新增测试或原版专项通过替代实际应用结果。

第 152 批实现提交为 `dcaa83fd9f9e6161f9e63a6241195b0af22c594e`。GitHub 为该提交登记的运行状态为 `pending`。构建、转码、游戏操作与离线验收结果留到下一次运行时取回。[第 152 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45804548247)

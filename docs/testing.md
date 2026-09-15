# GitHub Actions 验证

本项目的测试和可执行验证探测统一在 GitHub 托管 runner 上运行。本地只进行开发与代码检查，不运行 Node 测试、Playwright、专项探测或 `npm run check`，也不使用本机 self-hosted runner。

推送分支、创建/更新 PR 或手动运行 **Tests** 工作流都会启动验证。工作流定义见 [test.yml](../.github/workflows/test.yml)。

手动设置 `node-only=true` 可独立执行构建、类型检查和 Node 套件，供完整浏览器回归仍在运行时定位问题。该入口使用独立队列，运行名称明确标为 Node diagnostic；浏览器、直接运行时和 All tests 汇总均跳过，因此它的成功只表示 Node 诊断成功，不能用于完整回归报告。正常推送和默认手动运行仍执行全部套件。

```sh
gh workflow run test.yml --ref BRANCH -f node-only=true
```

`runtime-only=true` 同理单独运行三浏览器、双 WASM 后端的直接运行时检查；它跳过 Node 和应用场景套件。两个诊断开关互斥，各自的成功都只覆盖选中的检查，完整回归仍使用两个开关均关闭的默认运行。

```sh
gh workflow run test.yml --ref BRANCH -f runtime-only=true
```

## 已完成的云端回归

[MenuItem 生命周期完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34921937558)通过全部 **918 Node、678 浏览器、6 组直接运行时**，基于 `a9403d0`，全部 14 个 job 成功。浏览器统计为 555 常规、57 游戏库、59 PWA、7 原生生命周期，零失败、跳过、flaky 和重试。直接运行时包含 12 组菜单报告和 24 组原生状态报告，后者停止后的原生 slot 数全部为零。原始失败、一次未确认原因的 V8 断言及 KAG 刷新全屏测试的时序修正见[决策 043](decisions/043-menu-object-lifetime.md)。

同一应用产物的[原 KAG／离线升级检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/34922607852)通过 **78 项**。测试代码 `fc72347` 只修正刷新后等待启动完成再退出全屏的时序；没有改动已完成完整回归的应用源代码。本阶段以按 run ID 保存的 Actions 原始产物为证据，不复用此前 Window 阶段的 900 项报告。

[Window 生命周期完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34914435535)通过 **900 Node、678 浏览器、6 直接运行时**；[KAG／离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34913200791)通过 **78 项**。[最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34916018555)生成 `window-object-lifetime-matrix.json`，绑定 543 份证据，SHA-256 为 `e5a2da13b7838024e29c01b51c03c8629377d4a7d8aa6cb21e6eb59c7a435f5e`。所选案例零失败、跳过、flaky 和重试；可信冻结为 21,059.9 ms。Node-only/runtime-only 的独立结果未替代完整回归。

另有 [64 项句柄](https://github.com/fenghengzhi/krkr2-web/actions/runs/34913202815)、[120 项对象](https://github.com/fenghengzhi/krkr2-web/actions/runs/34913204662)和[分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34913216710)通过：600 个 owner、24 个 dependent、20 个集合终结、1,062 个执行及 188 个字节码分配失败检查。原始失败与中间诊断继续归档，范围及未完成项见[决策 042](decisions/042-window-object-lifetime.md)。以下保留历史阶段证据。

[宿主生命周期最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34883625695)绑定 542 份证据，矩阵 `out/verification/host-object-lifetime-matrix.json` 的 SHA-256 为 `e2c75876777e77b4b834551a7558d3527e4431ef5f7daf6180fd85d148368d9c`。最新 [完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34882175516)通过 **594 Node、639 浏览器、6 直接运行时**；[兼容性](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877215012)通过 **78 项**，所选测试无失败、跳过、flaky 或重试。

专项通过 [64 个隔离宿主句柄用例](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877207118)、[120 个隔离对象用例](https://github.com/fenghengzhi/krkr2-web/actions/runs/34877210694)、[600 次 owner、20 次集合、1,064 次执行和 188 次字节码分配失败](https://github.com/fenghengzhi/krkr2-web/actions/runs/34876790697)，以及 [20 次 WebKit 字体取消/重启](https://github.com/fenghengzhi/krkr2-web/actions/runs/34882204693)。直接运行时另记录 144 条宿主句柄、48 条控制、240 条弱观察和 48 条事件所有权场景；可信冻结 21,059.1 ms。

本地产物仅从 `34882175516` 的精确构建恢复，旧 `.generated` 和 `dist` 保存在 `out/verification/host-object-lifetime/prior-local-artifacts/`，没有本地测试或探测。此前所有失败、中断和材料均保留；两次 WebKit 会话提前中断与一次缺少原始分配栈的故障仍无确定根因。实现、完整失败历史及验证边界见 [039](decisions/039-host-object-lifetime.md)。以下为历史阶段记录。

[对象终结最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34868705139)已通过，绑定 530 份证据。矩阵 `out/verification/object-finalization-matrix.json` 的 SHA-256 为 `0387418a08e9a011d261937358510575a31f10061efaaff1e67c7ae910217d51`；本轮可信冻结为 21,055.1 ms。历史矩阵与失败记录继续保留。

最新 [对象终结完整回归](https://github.com/fenghengzhi/krkr2-web/actions/runs/34866740979) 通过 **466 项 Node、639 项浏览器及 6 项直接运行时**；[KAG/离线升级](https://github.com/fenghengzhi/krkr2-web/actions/runs/34867143808) 另通过 **78 项**。对象终结专项包含三浏览器双后端 360 个场景组合、48 条暂停/取消路径，以及 [120 个隔离进程用例](https://github.com/fenghengzhi/krkr2-web/actions/runs/34867147315)。[分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34866791836) 通过 20 次清理、1,063 次执行和 188 次字节码分配失败。TJS ABI 5 新增 `objectFinalization: 1`，字体 ABI 2、协议 9 不变。实现和原始失败见 [对象终结](decisions/038-object-finalization.md)。

本轮历史失败 `34861822171`、`34863624702`、`34864904432`、`34865379657` 按 run ID 保存，编译失败与夹具错误不计为通过。完整回归含 516 常规、57 游戏库、59 PWA、7 原生生命周期；没有把历史额外冻结/冷重启计入本阶段。完整非插件兼容性仍未完成。

执行资源阶段的 [完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858757086) 通过 **398 项 Node、639 项浏览器**（516 常规、57 游戏库、59 PWA、7 原生生命周期）和 **6 项直接运行时**；[兼容专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34859159783) 通过 **78 项**。[分配诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34858195933) 通过新增 **1,063 次执行分配失败**与原有 **188 次字节码分配失败**。直接运行时覆盖 132 个预算边界、24 个自动终结场景、12 条深层调用控制和 12 条参数复制控制；原字节码/编译/二进制与页面控制仍保留。范围、失败历史及构建下载修复见 [执行资源预算](decisions/037-execution-budgets.md)。所有所选案例无失败、跳过、flaky 或重试；历史额外冷重启诊断未计入本阶段。

[执行资源最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34860651997)已通过，绑定 519 份证据；矩阵 `out/verification/execution-budgets-matrix.json` 的 SHA-256 为 `2079d47f87fd1f035b7eb7626249a183fbef66a2b0723f93ebe458e80a78c109`。可信冻结 21,052.5 ms；报告还保存字体依赖下载及校验记录。`.generated` 和 `dist` 已从对应 Tests 的精确产物恢复，旧本地产物保存在 `out/verification/execution-budgets/prior-local-artifacts/`，没有本地执行验证。

字节码生命周期阶段的 [完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34849454871) 通过 **392 项 Node、639 项浏览器**（516 常规、57 游戏库、59 PWA、7 原生生命周期）和 **6 项直接运行时**；[兼容专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34848253401) 通过 **78 项**。另有 [188 次双后端分配失败](https://github.com/fenghengzhi/krkr2-web/actions/runs/34848868196) 和 [20 次 WebKit JSPI 原生 Debug 冷离线重启](https://github.com/fenghengzhi/krkr2-web/actions/runs/34849908821) 通过，所选测试没有失败、跳过、flaky 或重试。直接运行时包含 36 条字节码暂停/取消路径及六组重复加载/失败回滚检查；范围和原失败见 [字节码生命周期](decisions/036-bytecode-lifetime.md)。

[最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34850540242)已绑定 554 份证据；矩阵 `out/verification/bytecode-lifetime-matrix.json` 的 SHA-256 为 `c3c5c665b1de52cc989edc0a3abad39001c0db1fc560baa49b1dfe63f798089b`。本轮可信冻结为 21,059.7 ms，没有计入历史额外冻结；此前各阶段矩阵和失败记录继续保留。

二进制脚本阶段的 [完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34841387392)通过 **384 项 Node、639 项浏览器**（516 常规、57 游戏库、59 PWA、7 原生生命周期）与 **6 项直接运行时**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34840621607)通过 **78 项**。所选测试无失败、跳过、flaky 或重试。[最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34842156097)已核对源码、发布树和逐项结果，矩阵 `out/verification/binary-scripts-matrix.json` 的 SHA-256 为 `b941be09c8d5803d19a8c1014fad9b8dfa1a78351a17734808133117cd1c3041`。

本轮绑定 496 份证据、116 份持久 context 预算、6 份媒体时钟与 6 份遮盖像素记录，包含 12 条二进制、36 条编译和 24 条页面控制检查；可信冻结为 21,052.3 ms，没有计入历史额外三次冻结。40 次视频遮盖、2 次隐藏图层和 40 次原 KAG 诊断单独归档，不替代完整回归。一次未复现的 WebKit JSPI 异常成员名称仍待查。失败历史见 [二进制脚本](decisions/034-binary-scripts.md)和 [视频首帧](decisions/035-video-readiness.md)。

原生 Scripts 阶段的 [完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34823979389)通过 **362 项 Node、615 项浏览器**（492 常规、57 游戏库、59 PWA、7 原生生命周期）与 **6 项直接运行时**；[兼容性专项](https://github.com/fenghengzhi/krkr2-web/actions/runs/34824129905)通过 **78 项**。所选案例无失败、跳过、flaky 或重试。两者的应用源码和发布文件已由 [最终报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34825096969)绑定，历史失败与修复见 [原生 Scripts](decisions/032-native-scripts.md)。

原生 Scripts 阶段矩阵为 `out/verification/native-scripts-matrix.json`，SHA-256 为 `1fab816e278b9746589c729509606aa1c0ad29156309136ce719f80dc22d0b7d`，绑定 495 份证据、116 份持久 context 预算和 6 份媒体时钟记录。可信冻结为 21,055.2 ms。报告与产物在 `out/verification/github-actions/34825096969/`，所有失败和被取代的运行仍按各自 run ID 保留。

此前 ABI 4 阶段 [提交 `0eee21e` 的完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815634377)全部通过：**351 项 Node、609 项浏览器测试**（486 常规、57 游戏库、59 PWA、7 原生生命周期）及 6 项直接运行时专项。原生调用栈在三浏览器双后端中检查，该阶段 TJS ABI 为 4。另有 [72 项兼容性](https://github.com/fenghengzhi/krkr2-web/actions/runs/34814325349)及 [30 次输入时序复测](https://github.com/fenghengzhi/krkr2-web/actions/runs/34815498178)通过。所选测试无失败、跳过或 flaky，未使用测试重试；WebKit 原有网络模拟排除继续保留。

本阶段 [最终云端报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/34816691294)生成 `out/verification/stack-traces-matrix.json`，绑定 503 份证据，SHA-256 为 `9babc637693f500efb1a04399f246f037ee5f32ba16090d78d2ab6113ec0a9df`。完整报告已下载至 `out/verification/github-actions/34816691294/`，构建与测试另按各自 run ID 归档。失败原因、确定性复现和中断记录见 [脚本调用栈决策](decisions/031-script-stack-traces.md)。

以下保留上一阶段的记录：

[提交 `0003038` 的完整运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809918318)全部通过：**346 项 Node、603 项浏览器测试**（480 常规、57 游戏库、59 PWA、7 原生生命周期），另有 6 项直接运行时专项与 9 次作业图形预检。所选用例无失败、跳过或 flaky，未使用测试重试。WebKit 原有网络模拟排除仍由配置明确保留。

本次报告与构建产物已下载归档到 `out/verification/github-actions/34809918318/`，摘要为 `summary.json`，SHA-256 为 `1421ee1c8d5ed83895a893cedbc7db62b274b04f92958606b6d9dc1bdaf6633e`。外部 KAG 与旧 ABI 专项由下述独立工作流验证。

## 作业与产物

当前 `.generated` 和 `dist` 来自对象终结阶段 Tests `34866740979` 的精确产物。上一阶段本地产物保存在 `out/verification/object-finalization/prior-local-artifacts/`，没有在本地重新构建或执行测试。

构建作业固定 Node.js 24.19.0 和 Emscripten 6.0.9，使用锁文件安装依赖，编译 Asyncify、JSPI 和 FreeType 内核，执行类型检查、生产构建和离线发布文件校验，再生成两个 PWA 更新样本。原生源码、第三方源码、构建脚本与工具链版本完全匹配时复用云端内核缓存，应用和 PWA 样本每次重新构建。缓存 key 和是否命中写入构建信息。生成目录、应用和 PWA 样本打包为 `test-build`，同次运行的所有测试作业共享这一份构建。

| 作业                       | 范围                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| Node                       | `tests/conformance`、`tests/integration`，含真实 WASM                   |
| Browser × 9                | Chromium、Firefox、WebKit × 常规浏览器、持久游戏库、PWA，各组合独立运行 |
| Chromium trusted lifecycle | 独立浏览器进程的真实隐藏、恢复、冻结与取消                              |
| Direct runtime             | 三浏览器 × Asyncify/JSPI，直接验证 compile、转储、调用栈、异常和取消    |
| All tests                  | 要求所有上述作业成功；失败、取消或跳过均不能通过汇总门槛                |

Chromium/Firefox 套件使用 Ubuntu 24.04，WebKit 套件使用 GitHub 托管的 macOS 15。Linux runner 上的 Firefox 使用 Xvfb 虚拟显示和 Mesa 软件渲染；所有持久浏览器重开都沿用同一显示模式。套件开始前先在 Worker 中创建 WebGL2 上下文、清屏并读取像素，同时检查 JSPI；能力缺失会明确失败，避免每个场景重复超时。Chromium 和 macOS WebKit 保持 headless。Linux 作业提供 PulseAudio 虚拟输出设备，让真实 AudioContext/AudioWorklet 推进音频时钟；不替换页面的音频 API。WebKit 保留 DOM/网络 trace 和失败截图，关闭会明显拖慢协议操作的连续截图采集。

Playwright 1.63 的 Linux WebKit 在本次云端检查中不能创建 Worker WebGL2，即使使用 Xvfb 也失败。其上游版本的 [OffscreenCanvas 创建路径](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/html/OffscreenCanvas.cpp) 受 `allowWebGLInWorkers` 控制，[Cocoa 配置](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WTF/wtf/PlatformEnableCocoa.h) 启用了该能力。因此 WebKit 图形和持久场景放在 macOS 上验证；不需要渲染的直接 WASM 探测仍覆盖 Linux WebKit。这不表示 Linux GTK WebKit 可以运行当前播放器。

浏览器和套件形成九个独立作业，一个组合失败不会取消其他组合。每个组合完成后立即上传报告，不必等待同一浏览器的其他套件；GitHub reporter 同时提供错误注释。保留现有用例断言和超时，不增加自动重试。Chromium、Firefox 与原生生命周期使用 2 个 worker；云端 WebKit 使用 1 个 worker。在相同构建和 macOS 镜像上，媒体启动诊断双并发 6 次有 2 次失败，单并发 6 次全部通过；记录显示争用期间 Blob 读取和媒体加载明显延迟，见 [双并发记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809235409) 和 [单并发对照](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809666778)。原有 WebKit 网络模拟排除仍由 PWA 配置明确控制。

每个作业上传日志、JSON 报告以及可用的失败截图/trace，保留 14 天。`test-build` 含 commit、run ID 和运行次数，另含带哈希的 WASM manifest 与离线发布清单。Actions 详情页的 Artifacts 可下载这些文件；需要长期保存的阶段证据应另行归档。

## 远程运行

配置 remote 并推送后，在 GitHub 的 Actions → Tests 查看当前运行。命令行也可以操作远程工作流；以下命令不会在本机执行测试：

```sh
gh workflow run test.yml --ref main
gh run list --workflow test.yml --limit 5
gh run view RUN_ID --log-failed
gh run download RUN_ID --dir out/verification/github-actions/RUN_ID
```

## KAG 与旧发布兼容性

默认工作流不依赖相邻的 `kirikiroid2-web` 仓库，也不读取本机的 `out/verification` 历史目录。现有固定参考数据随 `tests/fixtures` 保存并由 Node/浏览器测试使用。

原 KAG XP3、保留全部 30 个成员字节的 ZIP，以及五个完整旧发布包已固定在 [兼容样本](../tests/fixtures/compatibility/README.md) 中。**KAG and release compatibility** 工作流先核对压缩包、旧发布树、build token、实际 ABI 和 ZIP 成员摘要，再运行三浏览器、双 WASM 后端专项。当前 ABI 5 工作流包含 TJS ABI 1/2/3/4→5 和字体 ABI 1→2，共 78 项；ABI 4 的 72 项和以下 ABI 3 的 66 项结果作为历史记录保留。

[提交 `c0d6ba3` 的云端运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812505215)通过全部 **66 项**：原 KAG 流程/存读档/转场 36 项、原菜单 6 项、原异常处理及恢复 6 项、TJS ABI 1→3 和 2→3 各 6 项、字体 ABI 1→2 共 6 项。升级检查实际关闭服务器，让旧标签页重建旧 Worker，新标签页运行新 Worker；TJS 检查还验证新发布原生类和独立 dump，字体检查读取字宽和位图像素。旧应用及其 manifest 保持原字节。

[初次迁移运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/34811575232)中，WebKit 的旧字体发布在约 5.5 秒时出现启动标记，超过独立探测默认的 5 秒断言。失败 trace 的结束快照已包含该标记与绘制画面。启动断言现与常规浏览器套件的 12 秒标准一致，并记录旧版在线、旧版离线重启、新版离线启动各自耗时；没有修改旧发布字节或升级断言，也没有增加测试重试。初次失败记录继续保留。

手动复用成功 Tests 构建运行专项：

```sh
gh workflow run compatibility.yml --ref main -f build-run=BUILD_RUN_ID
```

复用前严格比较应用源码、依赖和构建脚本。**Verification report** 工作流读取已完成的 Tests、兼容性和对应阶段的独立专项，逐项核对用例、构建、源码、样本及证据哈希。ABI 5 根据能力标记生成 `execution-budgets-matrix.json`、`bytecode-lifetime-matrix.json`、`binary-scripts-matrix.json` 或 `compiler-matrix.json`，更早的原生 Scripts 阶段保留 `native-scripts-matrix.json`；此前 ABI 4 阶段要求输入时序专项，生成 `stack-traces-matrix.json`；ABI 3 阶段使用独立长冻结专项，生成原 `vm-console-matrix.json`。这些文件位于 `out/verification/`。报告工具不会重新运行浏览器测试，当前报告与引用证据保存在 `runtime-verification` artifact，保留 90 天。

[VM 控制台阶段汇总](https://github.com/fenghengzhi/krkr2-web/actions/runs/34812958010)已通过，绑定 487 份证据文件、116 份持久 context 预算记录及 6 份媒体时钟记录。生成时提交为 `d97a3c9`，报告 SHA-256 为 `81beb0d8763cfc667c01b6e799d561ab80db8fb9944cba4c1e40408a9f18059d`。矩阵和引用的完整产物已下载到 `out/verification/github-actions/34812958010/`，矩阵另复制到上述标准路径；报告生成后的本次文档更新不改变应用或测试代码。

```sh
gh workflow run verification-report.yml --ref main \
  -f build-run=BUILD_RUN_ID \
  -f compatibility-run=COMPATIBILITY_RUN_ID
```

`input-run` 可附带同源码的输入时序专项，ABI 5 不把 ABI 4 的历史复测计为本轮结果。`freeze-run` 仍可指定同应用源码的独立三次长冻结运行；未提供时不会把历史三次冻结计入当前阶段。完整 Tests 自身的 7 项原生生命周期仍包含一次超过 21 秒的真实冻结。

协议 8→9 的同内核历史专项仍保留在调试面板阶段；跨 TJS ABI 升级检查不能替代该历史结果。其他未迁移的独立参考/性能专项同样不能由默认工作流通过推断为已完成。

VM 控制台阶段的本地完整回归已按用户要求中止（退出码 143）。此前的专项通过记录与失败日志按历史证据保留；该阶段的新完整回归结果以实际 Actions 运行记录为准。

## 独立诊断

`PWA native crash diagnostic` 固定复测 20 次原有 WebKit JSPI 原生 Debug 冷离线重启场景，保留进程日志和本次 macOS 崩溃报告。通过记录可以使用 `pwa-run` 绑定到最终报告；它不会删除或解释历史页面崩溃。

`Bytecode runtime diagnostic` 可以复用源码完全匹配的云端构建，收齐三浏览器双后端的直接运行时结果；每个组合只运行一次，存在任何失败时整体失败。它用于定位专项问题，不能代替完整 Tests。

`Bytecode allocation diagnostic` 在两个独立 GitHub-hosted Ubuntu 作业构建 Asyncify/JSPI 诊断内核，固定 Node 24.19.0 并显式启用 JSPI。每个内核逐点模拟池、上下文和链接的分配失败，另在新 VM 中模拟字符串堆块/索引扩容失败；记录原生字节、字符串单元、脚本块和上下文。诊断构建有独立身份和 `diagnosticAllocator: true` 标记，生产发布校验拒绝该标记。字节码生命周期报告必须提供同源码的 `allocations-run`，不会以正式构建的测试代替故障验证。

```sh
gh workflow run bytecode-allocations.yml --ref main
gh workflow run verification-report.yml --ref main \
  -f build-run=BUILD_RUN_ID -f compatibility-run=COMPATIBILITY_RUN_ID \
  -f allocations-run=ALLOCATIONS_RUN_ID
```

`Native lifecycle diagnostic` 和 `WebKit startup diagnostic` 可手动指定已有构建 run ID，在云端重复特定场景并附加状态、Worker 等待记录和原生栈。复用前检查该构建与当前提交的应用源码、依赖及构建脚本完全一致；诊断允许修改测试代码，但不能以旧产物验证新的应用实现。这些诊断结果单独保存，不能替代完整 Tests 工作流。

`Input activity diagnostic` 使用同样的来源检查，包含阻塞 VM 的确定性焦点验证，以及三浏览器双后端各 5 次后台输入清理。它保留原来的 12 秒断言、2 个并发 worker 和全部文字/按键/点击检查，不以自动重试替代失败。

`Video presentation diagnostic` 可选择 Chromium 或 macOS WebKit；`cases=overlay` 固定运行 40 次原遮盖案例，`cases=layer` 运行两个隐藏图层案例。`first-frame-barrier=true` 只用于比较首次 seek 的顺序，正式修复验证使用 `false`。`KAG native startup diagnostic` 则固定运行 WebKit JSPI 原 ZIP 转场场景，在关闭/开启脚本调用栈的配置下各 20 次，逐次保留结果，遇到失败也收齐剩余诊断，最终有任何失败便返回失败。

```sh
gh workflow run video-diagnostic.yml --ref main -f build-run=BUILD_RUN_ID \
  -f browser=webkit -f cases=overlay -f first-frame-barrier=false
gh workflow run kag-native-diagnostic.yml --ref main -f build-run=BUILD_RUN_ID
```

```sh
gh workflow run input-activity.yml --ref main -f build-run=BUILD_RUN_ID
```

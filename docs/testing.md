# GitHub Actions 验证

本项目的测试和可执行验证探测统一在 GitHub 托管 runner 上运行。本地只进行开发与代码检查，不运行 Node 测试、Playwright、专项探测或 `npm run check`，也不使用本机 self-hosted runner。

推送分支、创建/更新 PR 或手动运行 **Tests** 工作流都会启动验证。工作流定义见 [test.yml](../.github/workflows/test.yml)。

## 作业与产物

构建作业固定 Node.js 24.19.0 和 Emscripten 6.0.9，使用锁文件安装依赖，编译 Asyncify、JSPI 和 FreeType 内核，执行类型检查、生产构建和离线发布文件校验，再生成两个 PWA 更新样本。原生源码、第三方源码、构建脚本与工具链版本完全匹配时复用云端内核缓存，应用和 PWA 样本每次重新构建。缓存 key 和是否命中写入构建信息。生成目录、应用和 PWA 样本打包为 `test-build`，同次运行的所有测试作业共享这一份构建。

| 作业                       | 范围                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| Node                       | `tests/conformance`、`tests/integration`，含真实 WASM                   |
| Browser × 9                | Chromium、Firefox、WebKit × 常规浏览器、持久游戏库、PWA，各组合独立运行 |
| Chromium trusted lifecycle | 独立浏览器进程的真实隐藏、恢复、冻结与取消                              |
| Direct runtime             | 三浏览器 × Asyncify/JSPI，直接验证 compile、转储、异常和取消            |
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

## 尚未迁移的历史专项

默认工作流不依赖相邻的 `kirikiroid2-web` 仓库，也不读取本机的 `out/verification` 历史目录。现有固定参考数据随 `tests/fixtures` 保存并由 Node/浏览器测试使用。

原 KAG 外部场景和 TJS/字体跨 ABI 升级探测仍需要固定的外部 XP3/ZIP 与旧版本发布包。这些材料尚未接入 Actions，不能将默认工作流通过解读为这些专项也通过。迁移时须提供可追溯的样本来源、旧发布树和哈希，并在云端运行对应 `tests/probes`，不能通过跳过或改写旧 manifest 代替真实升级验证。

VM 控制台阶段的本地完整回归已按用户要求中止（退出码 143）。此前的专项通过记录与失败日志按历史证据保留；该阶段的新完整回归结果以实际 Actions 运行记录为准。

## 独立诊断

`Native lifecycle diagnostic` 和 `WebKit startup diagnostic` 可手动指定已有构建 run ID，在云端重复特定场景并附加状态、Worker 等待记录和原生栈。复用前检查该构建与当前提交的应用源码、依赖及构建脚本完全一致；诊断允许修改测试代码，但不能以旧产物验证新的应用实现。这些诊断结果单独保存，不能替代完整 Tests 工作流。

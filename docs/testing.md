# GitHub Actions 验证

本项目的测试和可执行验证探测统一在 GitHub 托管 runner 上运行。本地只进行开发与代码检查，不运行 Node 测试、Playwright、专项探测或 `npm run check`，也不使用本机 self-hosted runner。

推送分支、创建/更新 PR 或手动运行 **Tests** 工作流都会启动验证。工作流定义见 [test.yml](../.github/workflows/test.yml)。

## 作业与产物

构建作业固定 Node.js 24.19.0 和 Emscripten 6.0.9，使用锁文件安装依赖，编译 Asyncify、JSPI 和 FreeType 内核，执行类型检查、生产构建和离线发布文件校验，再生成两个 PWA 更新样本。原生源码、第三方源码、构建脚本与工具链版本完全匹配时复用云端内核缓存，应用和 PWA 样本每次重新构建。缓存 key 和是否命中写入构建信息。生成目录、应用和 PWA 样本打包为 `test-build`，同次运行的所有测试作业共享这一份构建。

| 作业                       | 范围                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| Node                       | `tests/conformance`、`tests/integration`，含真实 WASM                   |
| Browser × 3                | Chromium、Firefox、WebKit 各自顺序执行常规浏览器、持久游戏库和 PWA 测试 |
| Chromium trusted lifecycle | 独立浏览器进程的真实隐藏、恢复、冻结与取消                              |
| Direct runtime             | 三浏览器 × Asyncify/JSPI，直接验证 compile、转储、异常和取消            |
| All tests                  | 要求所有上述作业成功；失败、取消或跳过均不能通过汇总门槛                |

Chromium/Firefox 套件使用 Ubuntu 24.04，WebKit 套件使用 GitHub 托管的 macOS 15。Linux runner 上的 Firefox 使用 Xvfb 虚拟显示和 Mesa 软件渲染；所有持久浏览器重开都沿用同一显示模式。套件开始前先在 Worker 中创建 WebGL2 上下文、清屏并读取像素，同时检查 JSPI；能力缺失会明确失败，避免每个场景重复超时。Chromium 和 macOS WebKit 保持 headless。

Playwright 1.63 的 Linux WebKit 在本次云端检查中不能创建 Worker WebGL2，即使使用 Xvfb 也失败。其上游版本的 [OffscreenCanvas 创建路径](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/html/OffscreenCanvas.cpp) 受 `allowWebGLInWorkers` 控制，[Cocoa 配置](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WTF/wtf/PlatformEnableCocoa.h) 启用了该能力。因此 WebKit 图形和持久场景放在 macOS 上验证；不需要渲染的直接 WASM 探测仍覆盖 Linux WebKit。这不表示 Linux GTK WebKit 可以运行当前播放器。

浏览器矩阵不在某一种浏览器失败后取消其他浏览器；通过图形检查的作业也会继续执行后面的游戏库与 PWA 套件。保留现有用例断言、并发和超时，不增加自动重试。原有 WebKit 网络模拟排除仍由 PWA 配置明确控制。

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

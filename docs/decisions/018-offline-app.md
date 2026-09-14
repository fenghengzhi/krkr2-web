# 应用离线启动与版本更新

生产构建支持将页面、脚本、Worker、Worklet、两种 TJS WASM、媒体解码组件、图标与许可证一起保存。用户先点击“准备离线启动”，完成后点击“停止并重新载入应用”；游戏资源另通过游戏库保存。准备好的应用和库中资源可以在服务器关闭后启动，也可以在浏览器进程重开后继续读取原存档。

开发服务器不启用 Service Worker。离线功能要求 HTTPS 或 localhost、安全上下文、Service Worker、CacheStorage 和 Web Locks 实际可用。普通文件导入和临时运行仍保留；应用缓存与 OPFS 游戏库是独立能力。

## 职责与发布产物

- `scripts/build/offline-shell.ts` 将 Service Worker 单独构建成经典脚本，为最终发布文件生成大小、MIME 和 SHA-256 清单。`public/` 中的许可证也通过构建流水线发出，避免被 Vite 直接复制而漏出清单。
- `src/pwa/manifest.ts` 定义清单与预算，`cache.ts` 管理下载校验和 CacheStorage，`service-worker.ts` 管理浏览器生命周期、消息来源及跨版本写锁。
- `src/pwa/client.ts` 负责注册、状态、更新与显式重新载入，`app/offline.ts` 负责页面控件。引擎和游戏资源解析器不依赖 Service Worker。
- `player/build-info.ts` 给当前文档绑定带内容哈希的 WASM 清单地址。稳定的 `wasm/manifest.json` 仅作为工具兼容入口，运行会话使用哈希地址。

构建 ID 包含全部应用文件的内容哈希与 Service Worker 核心代码哈希。HTML 中的构建标记先以占位符参与 ID 计算，再写入实际 ID 并计算最终 HTML 哈希，避免循环依赖。`sw.js` 在脚本开头携带完整清单，自身由浏览器更新机制获取，不放进应用缓存。

`scripts/verify-offline-build.mjs` 独立读取发布目录，检查所有文件均被列入清单、实际字节/哈希与构建 ID 一致、经典 Worker 可解析、图标可解压、页面子路径正确，以及 WASM 清单和 Worker/Worklet 产物完整。默认 `npm run build` 包含这一检查。构建测试还生成 `/player/` 下的真实 A/B 发布包，其中 B 的 WASM 清单有不同内容哈希；测试不修改原始 `.generated/wasm`。

## 安装、失败与修复

首次准备是用户主动操作。已有注册的页面会检查状态并尝试获取更新。新版本下载到独立缓存，先写未完成记录；四路下载全部通过长度与 SHA-256 校验后，最后才发布完成记录。资源缺失、内容损坏、网络或配额错误使安装失败，旧的完整版本保留。

下载只接受同源、无重定向的成功响应，并限制读取体积。HTTP 压缩在 Fetch 中解码后，缓存响应去掉原 Content-Encoding/Transfer-Encoding，使用实际大小和清单 MIME；其他响应头保留。任何下载失败都会取消其余下载，等所有任务收敛后再删除未发布缓存，防止晚到的写入复活该版本。

浏览器可能驱逐缓存。状态检查要求完成记录和全部文件仍存在；读取缺失的已知文件时，会尝试联网重新下载并校验，失败返回明确的 503。用户也可重新准备，修复当前版本，OPFS 游戏和 IndexedDB 存档保持独立。已有缓存读取不逐次重新计算哈希；这是传输/意外损坏检查，不是对恶意同源代码的认证机制。

## 更新与运行中的游戏

Service Worker 不自动调用 `skipWaiting()` 或 `clients.claim()`，页面不因 controllerchange 自动刷新。首次缓存完成后需要重新载入，使新文档进入已缓存版本。

“停止并重新载入应用”先等待当前会话停止和存档提交。提交失败时留在原页面，待写数据仍可导出；正在导入游戏库时该按钮不可用。准备缓存不会主动停止游戏。

有新版本等待时，点击重新载入才发送 ACTIVATE；确认新缓存完整后激活并重新载入当前页面。其他标签页的文档和 VM 保留。新 Worker 可以从保留的旧版本中提供旧哈希脚本和 WASM 清单，所以旧页面在更新后仍能停止并创建新会话。

旧缓存的清理使用保守条件：报告状态的文档必须与当前 Worker 同版本、作用域内只有该窗口，且没有安装中或等待中的版本。清理与安装共用 Web Lock，拿到锁后再次检查注册与窗口状态。多窗口运行时保留旧版本；达到预算会拒绝新安装，不删除正在使用的版本来腾空间。关闭旧窗口并重新载入当前版本后可以回收。

这些行为基于浏览器的安装、等待、激活与受控客户端生命周期，见 [Service Workers 规范](https://w3c.github.io/ServiceWorker/)。CacheStorage 的提交标记是本应用约定，不代表浏览器提供跨缓存事务。

## 缓存范围与预算

只缓存构建清单中的应用文件，以及作用域根/index.html 的导航；导航查询参数保留后端选择。未知文件、非 GET、带 Range/If-Match 的请求、非导航查询地址、其他路径和其他源都走原网络路径。游戏下载、个人存档、API 和任意远程响应不会自动进入应用缓存。

| 项目         | 当前上限                             |
| ------------ | ------------------------------------ |
| 单版本应用   | 32 MiB、1,024 个文件                 |
| 单个应用文件 | 16 MiB                               |
| 保留版本     | 最多 8 代、清单累计 64 MiB           |
| 并发下载     | 4 个                                 |
| 下载超时     | 单文件 15 秒、安装下载阶段总计 60 秒 |

预算约束应用资源字节；浏览器响应头、缓存元数据、Web Crypto 和复制缓冲另有开销，不表示进程峰值内存上限。浏览器存储操作本身仍可能挂起或失败。站点持久存储请求由既有游戏库入口发起，是否授予由浏览器决定；用户清除站点数据仍会删除缓存和游戏。

## 静态部署与安装入口

默认部署 `dist/` 到站点根目录。部署到子路径时使用以 `/` 开始、以 `/` 结束的 Vite base，例如：

```sh
npm run typecheck
npx vite build --base=/player/
node scripts/verify-offline-build.mjs dist /player/
```

静态服务器应将 `/player` 重定向到 `/player/`，以正确 MIME 提供 JS/MJS、WASM、JSON 与 manifest，并允许更新 `sw.js`。建议 HTML 和 `sw.js` 使用可重新验证的缓存策略，内容哈希资源可长期缓存。整个发布目录应一致上线；滚动部署仍应保留旧哈希文件，为尚未受 Worker 控制的旧页面提供资源。开发与生产预览宜用不同端口，避免已注册的生产 Worker 接管开发路径。

应用支持根路径与 `/player/` 子路径的验证。没有验证相对 base、跨域 CDN 脚本、服务端动态改写 HTML 或带个性化内容的发布响应。

构建输出 Web App Manifest、192/512 PNG 与 SVG 图标。manifest 的 scope/start_url 相对当前目录，显示模式为 standalone，见 [Web Application Manifest 规范](https://www.w3.org/TR/appmanifest/)。浏览器提供 beforeinstallprompt 时显示“安装应用”按钮，只有用户点击才弹出安装界面。自动测试检查发布配置和离线行为，没有验证操作系统层面的安装、启动器图标或所有移动浏览器的安装 UI。

## 验证范围

`npm run test:pwa` 构建应用和 A/B 发布包，再执行 PWA 浏览器测试；`npm run check` 顺序执行全部行为、常规浏览器、磁盘游戏库和 PWA 测试。

三种浏览器都使用隔离磁盘 profile，测试真实关闭应用服务器后的重新载入、完整浏览器进程重启、OPFS 游戏与存档、两种 TJS 后端、离线 Vorbis/AudioWorklet/MP4、双标签页更新与旧清单加载、损坏更新回退/重试、缓存驱逐修复、Range/范围隔离、导入锁与存档提交失败。

额外的 `context.setOffline(true)` 网络模拟用例只在 Chromium/Firefox 执行。当前 Playwright WebKit 的模拟会使一个完全不访问网络、直接返回固定 HTML 的最小 Service Worker 也无法正常返回；对照源码与日志保存在 `out/verification/pwa/platform-probe-source.ts` 和 `platform-probe.log`。因此 WebKit 采用真实服务器关闭测试，不把模拟失败计为通过，也不将其推断为所有 Safari 的行为。`playwright.pwa.config.ts` 显式记录该排除项。

本阶段不等于完整非插件目标完成。GPU 丢失恢复随后已在 [图形恢复阶段](019-graphics-recovery.md) 接入；后台策略、流式媒体、完整字体/系统/图形接口、持久 HTTP 分块缓存与续传等仍见 [非插件进度](../non-plugin-progress.md)。

完整回归曾在 WebKit 的既有双标签页游戏库案例耗尽 30 秒用例预算。trace 显示最后的列表断言只运行约 0.1 秒，此前普通点击已变慢到约 3 秒；单独重跑也超时。关闭 trace 后同一案例 3.8 秒通过，仅关闭 trace 连续截图、保留 DOM/网络记录时 3.5 秒通过。基于这一对照，磁盘游戏库/PWA 配置仅对 WebKit 禁用连续截图，保留失败截图、DOM 快照、源码与网络 trace；没有删除断言、增加超时或降低 worker 数。失败完整日志和两份 trace 在 `out/verification/pwa/library-refresh-failure/`，两种对照日志在 `library-refresh-no-trace.log` 和 `library-refresh-dom-trace.log`。这属于本机自动化记录开销的实测限制，不推断为应用广播同步错误，也不把历史 Playwright 问题当作原因证明。

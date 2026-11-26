# 第 140 批游戏图像缓存

原 KRKR2 启动时，`System.graphicCacheLimit` 为零。启动参数 `-gclim` 设定游戏可以申请的系统上限，单位是 MiB。游戏向 `System.graphicCacheLimit` 写入 `gcsAuto` 才按该上限启用图像缓存。例如 `.cf` 中的 `gclim=2` 会让原 KAG 的 `Config.tjs` 在设置 `gcsAuto` 后得到 2,097,152 字节。若游戏直接给属性写字节数，则按系统上限钳制。运行中修改 `System.getArgument` 所读的参数表不会改变已经确定的上限。[原版启动上限](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/base/win32/SysInitImpl.cpp#L1136-L1180) · [原版属性设置](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/GraphicsLoaderIntf.cpp#L2700-L2728)

原版的自动上限取决于机器内存。Web 会话统一使用原版高内存分档的 64 MiB。显式数值经过 TJS 原生整数转换，再从带符号的 32 位 MiB 转为无符号的 32 位字节数。脚本属性读回带符号的字节数。较大的显式上限可以通过属性查询，实际保留的成品图像仍受 Web 宿主 64 MiB 驻留预算约束。这个预算也计入元数据和正在解码的图片。[启动参数转换](../../src/engine/system/graphic-cache-option.ts) · [图像驻留与淘汰](../../src/engine/storage/processed-image-cache.ts)

显式写入零会清空并关闭缓存。若系统上限为零，写入 `gcsAuto` 之后，预加载仍会直接返回。普通图片读取则可以保留最后载入的一张图片，因为原版在插入下一张图片前才检查容量。同一张图片若直接命中，可以继续使用。显式关闭后仍在进行的解码可以向原调用者交付结果，随后启用的缓存只保留新请求的结果。[引擎验收](../../tests/integration/graphic-cache-limit.test.ts)

## 验证

浏览器验收通过真实按钮预加载、换图、改限和清理。游戏提供三张各占 1 MiB 的背景。把系统上限从 1 MiB 改为 2 MiB 后，玩家切换到第二张图片时，预加载命中与新解码的次数应有明确差异。检查同时覆盖实际画面像素、停止后的资源释放和关闭缓存后的连续重载。独立 Windows 作业读取原版属性在启动、自动选择、超限写入、关闭和再次开启各阶段的值，并保留原始日志。[浏览器画廊](../../tests/browser/graphic-cache-game.spec.ts) · [原版对照](../../tests/probes/player-config-sdk.ts)

Firefox 的窗口轨迹显示，实际滚动到 `30,40` 后，同一版窗口状态再次呈现，位置回到 `0,0`。本批修正了重复呈现覆盖用户刚滚动的位置；来自引擎的新位置、滚动范围和窗口几何版本仍会更新界面。验收保留游戏窗口的鼠标与坐标断言，并单独检查真实 DOM 上的重复更新。[窗口呈现](../../src/app/game-windows.ts) · [滚动验收](../../tests/browser/window-scroll-presentation.spec.ts)

WebKit 的两个目录用例在不同阶段超时。一份记录已捕获选中的 41 个文件和游戏 B 的就绪日志，另一份已完成上传，超时发生在收集启动证据时。验收现在经过页面的目录选择按钮与原生文件选择器，并在游戏就绪后检查实际相对路径、文件大小和项目模式。这两个历史失败仍保留。[目录验收](../../tests/helpers/game-directory-input.ts)

第 133 批首版已结束。原版介绍游戏在三种浏览器的两种后端上均完成了菜单、书签、刷新恢复和退出。九份常规浏览器分片共 3,285 项，其中 3,185 项通过、98 项失败、2 项跳过。第 133 批最终版已取得 56 项图形对照全部匹配的结果，常规 Node 和浏览器用例在取回时尚未报告。第 134 至 139 批当时均在排队。[133 首版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623) · [133 最终版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490)

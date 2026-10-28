# 112 托管验证入口与失败证据

状态：候选，等待 GitHub-hosted Actions。上一轮 111 已提交并推送实现，是有进展的一轮；本轮从干净的 `3831560` 继续。整体目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。本批修复阻碍真实验证的夹具入口和清理问题，并为仍未定位的失败保留更具体的原件；没有修改生产实现或宣称新增模拟器功能。协议 **42**、TJS ABI **5**、字体 ABI **2** 和能力版本保持。

本地只做源码读改、Git，以及原报告／ZIP／trace 的下载、哈希核对和解析，没有运行测试、构建、类型检查、浏览器或候选探针。108–111 的 run、jobs、artifacts 各读一次后冻结；已终态的 107 没有再查询。整批推送后只取一次新运行身份，下轮回收，不实时监控。

## 固定结果

保留 **32 个原 ZIP、391,071,974 字节**，全部与固定 API 的 SHA-256 和大小一致；其中两个新增、三十个复核。两份新失败作业日志及七份已有原日志保留。入口为 `out/verification/github-actions/112-archive-summary.{json,md}`，原失败和解码附件索引在各运行的 `112-browser-failures.json`、`112-browser-decoded/index.json`。

108／`40776092450`／`3e246bf771af3c2f84a1a4a94679449997a9016c` 仍 in_progress：34 jobs 为 22 success、9 failure、3 running。新增 Chromium 主报告 **896 pass／33 fail**，Firefox 第一主分片 **451 pass／15 fail／1 skip**，合计仅这两份报告的 **1347 pass、48 fail、1 skip／1396**；其余三主浏览器报告尚无产物。之前 62 项 Node 失败、两项可信生命周期失败、一项 Library 恢复启动失败及六项兼容未报告范围保持。

109／`40779041112`／`35c1f3f569fa2170196be04b97f5b785f3661eba`、110／`40781763654`／`260cb0aae2ef649b62962618911bbb3fd6698383`、111／`40785212878`／`de046be70c7a9517e9b9d35a0a8baaf8afcac1d1` 都仍 pending、零 jobs／artifacts，不能提前确认修复通过。107 的 117 浏览器失败、两项 skip 和 472 未报告定义，以及历史堆崩溃和未比较范围全部保留。

## Library 归因勘误

111 曾根据共用 `load()` helper 的报错行，将 108 的 metadata-commit 案例误写为“初始启动失败，回滚断言未执行”。本轮读原 trace 后纠正：call 717／719 首次 `game.zip` 加载成功，725 确认注入的提交失败，727 确认取消按钮隐藏，729 确认游戏条目为零，731 确认临时目录为空；这些断言均通过。733 移除故障路由、735 重载、737 导入 `another.zip` 后，739 的第二次 ready 等待才超时。

失败末态为运行中、一个隐藏 Window、零 Layer、graphics=restoring，原 trace 不足以确定具体未完成的图形阶段。原 111 摘要和原件不删除，新增此勘误及对应阶段记录。生产回滚代码没有被凭错误归因修改。

Library 的既有四个注入失败场景现在保留初次启动、回滚、重载、再次启动和保存的完成阶段；真实 Worker RPC 与 surface MessagePort 的有界元数据、canvas transfer、DOM 末态独立附加。观察器不启动原本闲置的端口、不更改消息／transfer list，也不替换 Worker 或 renderer。三秒取证上限不会改动原启动 deadline；取证失败与首错分别保存。

108 新增 JSPI ZIP Stop 案例观测到 mount 已发布。原 UI 的 ready 通知与后续定时 Stop 之间存在时序窗口，原件没有精确请求／回复证据，不能直接归为索引取消实现缺陷。本批为该原用例添加相同被动状态证据及 ready-observed／stop-dispatched 时间，保留原本的 mount 未发布、及时 Stop 和无强制终止断言；没有将取消边界换成更容易的提前停止。

## 字体 Worker 入口

108 的 BMP 模块新增运行时依赖 `selection.ts`，两个字体夹具手写的模块路由白名单没有同步加入。Chromium 原 trace 三次对该模块返回 404，随后 Worker 抛空错误事件；Firefox 的两例同一路由失败并最终超时。错误发生在字体内核和字形比较之前。

两个路由补齐真实模块，抽出共用 Worker 管理 helper，保留原模块 Worker、十二秒 deadline、原生字体资产、512 个原生字形向量及全部纵排／alpha／尺寸断言。helper 记录有界模块 HTTP／requestfailed、普通 Event／ErrorEvent、messageerror、创建／传入／清理过程和原错误；失败不使用字体回退掩盖。审计为 `out/verification/browser-regressions/112-font-worker.md`。

## 视频换轨观察

107 取消分片中七个已报告 Firefox 案例都卡在第一次 canvas `locator.screenshot()`，尚未执行第一次换轨表达式。原 canvas 已具有实际 96×64 bitmap 与非零 DOM 矩形；不能把截图协议等待写成换轨或零尺寸故障。捕获改用实际 viewport 的 device PNG，再用独立 PNG 解码器按真实 DPR／CSS viewport 和 canvas 矩形严格裁出完整像素，要求截图前后布局一致且范围完整。截图操作限十秒，原测试总时限九十秒不变，给 Stop 和原件保存留下时间。

WebKit 八例在时间零的第一次换轨后，原独立默认 OffscreenCanvas 读回有 129 个通道字节相差 1，但整张画布截图完全一致，生产 decodedPixels 比较未报告失败。它不足以证明产品换轨改变像素，也不足以删除原严格比较。本批同时记录默认／`willReadFrequently:true` 的重复 read／redraw，观察实际生产 video readback 原字节，并与实际 Layer 和完整画布交叉核对；原默认路径跨换轨逐字节比较继续作为失败条件。已复制到测试进程的完整数据先保存，不依赖后续页面仍可响应。

没有增加 ±1 容差、跳过 WebKit 或改变生产解码器；该字节差异仍待新原件解释。审计及七份 Firefox／八份 WebKit 原始提取为 `out/verification/video/112-handoff-regressions.md`、`112-handoff-raw-summary.json`。

## 菜单、OPFS 与 KAG 报告

WebKit 以及新回收 Firefox 的 JSPI 菜单光标失败发生在第二次 fullscreen blocking popup 返回后。原 Timer mutation 与 menu-return marker 已到，主 marker 缺失仍未定位，不能直接归为 111 的控制台鼠标移动问题。新增真实 DOM、Session input／菜单状态、物理输入 RPC 及有界 canvas alpha 阶段观察；所有 marker／CSS／坐标断言保持。只修复已确认的清理竞态：首次 dispatch Stop 后不再对即将禁用的 Stop 进行第二次点击。

OPFS 原件只显示一段 evaluate 内的 UnknownError，未指出具体原生操作。本批逐项记录真实 getDirectory、创建、写入、关闭、枚举、读取和移除；writer abort／目录清理失败不覆盖首错，没有重试或新增能力 skip。菜单和 OPFS 主因仍未解决。审计为 `out/verification/browser-regressions/112-webkit.md`。

108 原 KAG 诊断的日志明确显示 Initialize.tjs 的异常处理器无法从旧上下文读取 Debug，符合 109 待验证的原生调用上下文修复，未据此再改变 KAG 程序。诊断 probe 现在预先记录完整后端库存，各后端独立保存 running／passed／failed／unreported 状态、实际完成阶段、首错、取证／清理错误及 trace。第一个后端失败后仍尝试第二个，最终存在失败仍返回失败。兼容 inventory 仅在 passed、原日志 hash、六个阶段、对话框截图及非空 trace 全部成立时计为通过；中断仍未报告。

## 验证与后续

本批**新增 Node／浏览器定义均为零**，保留并恢复既有真实消费者验证，增加诊断与严格交叉检查。字体、截图及清理候选尚待托管执行；静态交叉审查不等于通过。109–111 的生产修复仍待结果，Library 恢复启动、ZIP 发布时序、菜单 marker、OPFS、WebKit readback 差异，以及完整非插件功能／真实游戏验收继续未完成。

## 推送与交接

候选提交 `22d09757467f30273546eed72255fa8f0d644f01` 共 **17 个文件**，已推送到 `codex/migrated-window-attention`。[Full test suite 40787500591](https://github.com/fenghengzhi/krkr2-web/actions/runs/40787500591) 首次唯一查询为 **pending／conclusion=null**，精确 head SHA、push 事件及 attempt 1 匹配。原响应保存在 `out/verification/github-actions/40787500591/initial-run-discovery.json`。本轮不再查询其 jobs、日志或产物；下一轮补取 108–111 未报告范围并回收本批结果。完整目标继续 active。

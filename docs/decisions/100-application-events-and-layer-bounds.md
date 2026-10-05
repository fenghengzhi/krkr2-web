# 100 应用激活事件、Layer 整组边界与回归修复

状态：开发候选，尚待 GitHub-hosted Actions 执行。整体目标仍是完成 KRKR2 Web 模拟器的插件以外功能，未完成。本轮从干净的 `4328ca6` 继续；上一轮 099 的实现和托管交接已提交，是实际进展。会话协议 **40**、`nativeSystem:3`，TJS ABI **5**、字体 ABI **2**。

实现提交 `2a513d4eec3b1174d7da86ec8a1625bc1b8b9592` 的 42 个文件已推送至 `codex/migrated-window-attention`。[完整托管验证 37344510171](https://github.com/fenghengzhi/krkr2-web/actions/runs/37344510171) 的首次唯一身份查询为 **queued／conclusion=null**，原始响应保存在 `out/verification/github-actions/37344510171/initial-run-discovery.json`。本轮不实时查询 jobs／artifacts；下一轮补取 098／099 缺失结果并回收本批固定快照。记录交接的文档提交使用 `[skip ci]`，不是另一次验证结果。

本地仅源码检查、编辑、Git 操作及历史原件的下载、解包、哈希核对和解析。所有构建、测试、浏览器及可执行参考探针仅在 GitHub-hosted runners 执行。大批次推送后，下轮取回固定结果，不实时监控。

## 本轮固定证据

对 098／`37335381893` 与 099／`37340665748` 的 run、jobs、artifacts 各查询一次并冻结。098 仍为 in_progress，28 个 jobs 为 19 success、5 failure、4 running；099 为 pending，0 jobs、0 artifacts。**25 份原 ZIP、338,511,765 字节**全部匹配 API SHA-256 与大小，其中 8 份旧包重新核对、17 份新包。总表是 `out/verification/github-actions/100-archive-summary.json`；旧快照及失败保持原样。

098 构建成功。Node 完整报告 **3,293 = 3,287 pass + 6 failure**，没有 skip／cancel；此前 097 的 32 个失败已不再出现。直接运行时三浏览器／双后端 **6/6**、原 KAG 兼容 **96/96**、可信生命周期 **11/11** 已报告通过。新的惰性归档核心 8／集成 6、时钟呈现 9、Window update 28、视频图状态 10 以及项目目录 9+8 个 Node 定义均有通过记录。

主浏览器只收到 Chromium **775 pass／54 failure／829** 和 Firefox shard 1 **401 pass／27 failure／428**。合计已报告 **1,176 pass、81 failure／1,257**；这不是完整三浏览器分母。Firefox shard 2 和 WebKit 两个主分片未报告，另缺 Chromium library 作业产物；已报告 library 38/38、PWA 59/59。缺失部分不能计为通过。

双 Windows 的 183 个光标样本仍各 **536/596 matched、60 failure、3,178 uncompared**，mask 各 **3,770/3,770**。有界 Layer 生命周期诊断各 3×20 正常、分配失败诊断每后端 60 项完整，不证明历史宿主堆故障根因已解决。冻结产物中没有完整 core。099 的构建及全部测试仍未报告，本批不追认其通过。

## 应用级 System 激活回调

固定原版 `SystemImpl.cpp:552–590` 为 Application 共用一个输入 source/tag；activate 与 deactivate 用 REMOVE_POST 相互替换，派发前核对当前实际状态。它没有 last-delivered 去重，原注释明确允许再次交付当前相同状态。固定 `SystemIntf` 在实际派发时动态读取当前 global.System 及对应 slot，读取异常记日志，调用异常由事件异常处理路径处理。

候选增加独立 page/application 观察与 RPC，跟随页面实际 focus／blur、visibility、freeze／resume、pagehide／pageshow。游戏 Window 互切、输入框失焦、菜单和页面控件的 popup-close 信号不能冒充应用失活。初始化只保存当时事实；普通事件禁用或用户暂停保留最后一个待交付事件，Stop 撤销事件与观察器。

私有 native 调用桥保留一次动态读取、绑定 this 与精确异常边界，初始化后从公开 System 删除，放进既有事件泵闭包。新增能力 `nativeSystem:3` 防止旧缓存内核缺少该桥却进入应用；旧 1／2 和缺失能力的拒绝、恢复完整内核的路径均保留验证。没有增加公开脚本 API。

固定源、URL、哈希和逐项合同在 `out/verification/system-application/100-source/manifest.json` 与 `100-audit.md`。普通三浏览器覆盖内部焦点负控；真实应用焦点只在专用 Chromium noDefaults 环境取证，不据此宣称 Firefox／WebKit 的外部 OS 失活已验证。

## Layer.setPos 原子边界

固定 `LayerIntf.cpp:7013–7033` 仅在**恰好四参数且两尺寸都非 void**时调用 SetBounds；三参数、五参数或 void 尺寸仅设置位置，额外参数仍由 TJS 求值但不转换成尺寸。`InternalSetBounds:1851–1876` 在改变矩形前检查负尺寸和主图层移动限制。真实 KAGLayer 与 MessageLayer 使用该四参数入口。

旧 Web 方法顺次调用公开 left／top／setSize，可能触发脚本覆写或在两轴中间重入鼠标回调，也错误地让五参数调用调整尺寸。候选通过真实 Layer 身份直接进入一个 host 操作，在校验后提交完整矩形，并处理旧区域曝光、图像扩容、clip／image offset 和主图层几何同步。固定原版此方法通知视觉状态而不直接 ForceMouseRecheck；下一次真实指针事件读取最终矩形。

Web 保留已有尺寸／内存预算，先准备图像扩容，再提交坐标；不宣称重现原 C++ 内存分配失败时的部分矩形状态。原源哈希与行号在 `out/verification/layer-set-pos/100-source-manifest.json`。

## 播放中换音轨

098 的两个 fragmented 失败都已完成暂停换轨和完整像素比较，随后在播放中换轨失败。旧呈现时间为 1083.333 ms，冻结时钟分别为 1089.333／1116 ms，新解码器在同一时钟呈现 1166.667 ms。旧实现要求它仍与前一呈现帧逐字节相同，因此把合法的播放中换轨拒绝了。

候选按**事务开始时是否实际播放**分开处理。实际播放分支冻结时钟，要求候选精确到该时钟并得到其新呈现，再退休旧图和恢复播放。事务开始时已暂停或被外部挂起的图仍要求完整 RGBA 一致。中途暂停不改变已选分支，但继续阻止提交后的自动播放。底层选轨器仍验证保留原视频样本；这不构成无缝音频切换承诺。

新增真实 App 场景通过被动 pause／play 观察记录旧图冻结时钟、新图开始播放前的时钟和元素身份，检查实际音频频率、单个 graph／URL、反复换轨及 Stop 清理。已有暂停图像不一致故障注入和完整图像比较不变。

## 光标与旧验收修订

097 双 Windows 的 `scale-policy-64x64-zero-alpha` 原始 GetIconInfo RGB 完全一致，且与同尺寸 alpha 样本的 RGB 相同。原候选只给 alpha 使用 2×2 平均，zero-alpha 却误入点采样。现在两种 32 位颜色平面共用已被原件支持的半尺寸平均，AND mask 继续独立计算；新回归使用原始平面的完整字节哈希。证据在 `out/verification/cursor/100-half-size-evidence.json`，本地没有执行缩放候选。

现有样本证明 65 仍平滑、80 已点采样，但不足以选定其间阈值。托管原生库存追加 66–79 每个整数在方形、横纵非等比缩小和横纵放大组合的两种 alpha，共 **140 个样本，总计 323**。旧 183 项的身份、顺序、字节及 288 个诊断候选保留；未执行的新样本不是观察结论。

098 六个 Node 失败的修订保持原合同：同步资源查询在光标 decoder 重入前加入同一解码请求；文件存在／路径查找直接拒绝目录末尾，实际归档成员及损坏错误仍按访问传播；System 纯配置校验在时钟及 host 订阅之前；字体测试等待真实读取已进入后检查去重和取消，不再假定异步枚举在第一次 await 前完成。

浏览器原件另证明：8×4 的 activity 画布被点击在 10,10；graphics／window geometry 的小数 client 坐标截到了上一像素；项目测试在 TJS 不支持的 finally 处报语法错误。候选改成实际范围内可表示的整数坐标与合法 TJS 清理路径，原坐标、焦点、输入和归档错误断言保持。

独立视频校准的原件显示 rVFC 可在 readyState=1 时先于 loadeddata 到达，旧夹具立即结束并记成首帧失败。现在分别等待呈现与数据就绪，保留早期回调的原始事件，所有初始化和 seek 仍必须产生完整的最终画面；原 5 秒／4 秒期限及像素读取要求不变。

## 剩余范围

本批新增 **27 个 Node、每浏览器 20 个定义及 4 个可信 Chromium 生命周期定义**：应用事件 14／4／4，Layer.setPos 12／8，光标半尺寸 1 个 Node，播放换轨 8 个浏览器定义。原生光标另追加 140 个样本。这里是源码库存，全部仍待执行，不是通过数量。

本批全部候选尚待托管执行；098 的剩余作业和 099 的全部结果留待下轮固定回收。System.doCompact／assignMessage／exitOnNoWindowStartup、terminate 与 exit 的区别、视频流选择／更多媒体格式、完整光标缩放分支、历史堆故障、Firefox 媒体截图阻塞、真实 OS 拖放与更多真实游戏兼容仍在完整目标内。完成本批不等于完成模拟器。

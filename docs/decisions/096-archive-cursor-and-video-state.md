# 096 归档补丁、临时隐藏光标与视频状态生命周期

状态：开发候选，尚未取得本批托管执行结果。本轮从干净的 `312416d` 继续完整非插件目标。会话协议由 35 升至 **36**，增加独立屏幕位置观察及输入元数据；TJS ABI **5**、字体 ABI **2** 不变。归档别名只在 Worker 导入后生成，不增加游戏库持久化字段。

所有测试、构建、类型检查、浏览器和原生可执行探针只在 GitHub-hosted Actions 运行。本地仅源码检查、编辑及历史原始产物的下载、解包、哈希核对与解析。按较大批次推送，下轮取回固定结果，不实时轮询；静态审阅、未执行和跳过均不计为通过。

## 固定回收与构建修订

本轮各查询一次 094／`37312988058` 与 095／`37318168828` 的 run、jobs、artifacts，随后冻结清单。保存 **16 个原 ZIP、36,296,641 字节**，7 个旧包重新核对、9 个新包下载，全部 API SHA-256／大小匹配。总表为 `out/verification/github-actions/096-archive-summary.json`，分项见对应运行的 `096-final-summary.*` 与 `096-snapshot-summary.*`；旧快照不覆盖。

| 范围 | 094 终态 | 095 固定快照 |
| --- | --- | --- |
| run | completed／failure | in_progress／conclusion=null |
| jobs | 6 success、4 failure、6 skipped | 6 success、1 build failure、2 cursor running、6 skipped |
| 原 ZIP | 9／32,949,666 字节 | 7／3,346,975 字节 |
| 应用测试与堆诊断 | 构建失败后未执行 | 构建失败后未执行 |

094 原六条测试类型错误仍保留在原 build.log；095 曾修订它们，却在生产代码出现两条新的 TS2551：Layer 记录使用 `window.id`，清理回调误读 `windowId`。本批修正两处。原 095 build ZIP 为 200,993 字节，SHA-256 `3c692e71556619e3b52cb322c6d8d7ed99b2ce876e802a9d797135013d5ec5d3`。这不证明 094／095 的功能候选已经通过。

094 双 Windows 183 光标观察已归档，strict 各 **536/596 matched、60 failure、3,178 uncompared**，mask 各 **3,770/3,770**；13 个双方拒绝属于预期拒绝，不计为失败。288 个候选算法诊断没有全域零差异。095 两光标作业在快照中仍运行、无 ZIP，留待下一轮补取。两轮 User32 窗口几何每系统 24 配置／960 测量及 beginMove 7 项已完成清理，仅证明自有 User32 观察，不证明全部 VCL 行为。历史应用失败、宿主崩溃和未报告继续保留。

## 原 KAG 决定补丁搜索顺序

旧导入器把归档成员的裸名与 `archive>member` 都登记为真实文件。裸名先命中，使 KAG 后续注册的补丁自动路径失效，而且不同包的同名成员取决于选择顺序。

候选给导入别名标记 `aliasOf`，与真实资源分开。查询先看当前路径的存档／散装文件，再按自动路径的逆注册顺序查找，最后才回退裸名别名。成功查找返回规范归档 Resource 和同一缓存身份；移除、重加路径自然切换图片缓存，不清空缓存规避问题。普通 WRITE 可以创建 loose 存档覆盖，UPDATE／append 若解析到归档成员则维持只读。整批别名先验证后挂载，大小写歧义规则保留。

固定原 KAG `Initialize.tjs:48–95` 自己检测 `patch.xp3`、`patch2.xp3` 等并在编号缺口停止；引擎没有另加补丁排序。固定 `StorageIntf.cpp:1171–1192` 支持真实当前目录优先和后注册自动路径优先。证据、哈希及边界保存在 `out/verification/storage/096-archive-search/`。单包裸名启动仍是 Web 适配，不宣称实现全部原生当前目录语义。

Node 定义覆盖两种包输入顺序、实际脚本源码／编译字节码、规范路径、缓存命中、只读拒绝及持久存档。浏览器采用完整原 KAG XP3，Startup／Initialize 和原方法保持原样；仅自有观察脚本参数化为源码／字节码。故意按 patch2、patch4、patch、base 导入，缺 patch3，验证 patch4 不自动注册、patch2→patch→base→重新注册 patch、真实 PNG 字面颜色和游戏库重启后的存档优先。原 parser 的公开 clear 用于重新装载同名 scenario，图片缓存不清空。

## 临时隐藏光标的屏幕位置

固定 `WindowFormUnit.cpp:1214–1248` 在首次进入 TempHidden 时记录 `GetCursorPos`；重复赋值不重设基线。恢复条件是客户区移动时屏幕坐标确实变化。按下、释放、滚轮、同点移动或窗口本身移动不能凭输入序号恢复；脚本 SetCursorPos 保留强制恢复语义。

候选使用真实 MouseEvent.screenX／screenY 和全会话单调序号。全页观察 RPC、窗口观察 RPC 及输入包携带同一个事实；同序号重放和迟到包不能恢复后来隐藏的光标，也不改写虚拟光标权限。仅实际客户区 mousemove 或鼠标捕获接收者带恢复目标；标题、菜单和页面其他区域只更新可观察的屏幕位置。

进入隐藏时取最近已观察的屏幕位置，重复隐藏不改变它。如果页面从未观察过位置，第一条屏幕事实只建立基线，不能冒充隐藏瞬间未知的 OS 坐标。无协调器的旧注入接口仍只比较自身 viewport 域，不宣称屏幕坐标一致性。协议 36 明确区分这两种来源；恢复后即时发布窗口视图。三份固定原源、SHA-256 与定位见 `out/verification/window-cursor-hidden/096-source-manifest.json`。

## 视频对象与媒体图分开保留状态

固定 `VideoOvlImpl.cpp` 的 Rect、Visible、Loop、Mode、分段循环和周期事件属于 VideoOverlay 对象；播放速率、音量／平衡和 mixer 控制属于已打开的媒体图。旧实现把它们一起带入下次 open，并允许尚未打开时预设这些图属性。

候选在 close、Window 断开及失败重开后清掉媒体图控制，只保留对象属性。新图使用默认速率、音量／平衡和 mixer 设置；未打开的 getter 对速率／alpha 返回 0，音量 100000、平衡 0，音视频流选择返回 -1。关闭时 setter 在 TJS 绑定转换之后空操作，仍保留转换错误。固定 dsmovie 只对正数调用 SetRate，因此已打开时零／负速率也空操作；Web 可支持的正速率上限仍明确保留。loop 按原版布尔转换处理非零实数和对象。

新增真实浏览器场景检查 HTML 媒体速率、CSS 混合属性、实际 AudioContext 音频、关闭和重开后的 graph／URL 清理；静音阶段同时要求图仍运行，避免把图被销毁或暂停误算为静音成功。

新增 `dsmixer.cpp`／`WaveImpl.cpp` 原件及哈希见 `out/verification/video-tracks/reference/096-graph-controls-manifest.json`。本批未实现活跃 DirectShow 音量衰减量化及固定 GetAudioVolume 的无条件 return 特性，不宣称全部活跃控制一致。原版无图的 mixingBG getter 使用未初始化局部变量；Web 的确定性 0 属于适配值，不能写成原生观测证明。

## 验收与后续

本批新增 **33 个 Node、每浏览器 16 个定义**：存储 10／4，视频 10／4，光标 13／8。光标含 12 个真实源码／字节码 Session 定义和一个协调器事实复制定义；浏览器区分可信鼠标观察与显式合成 DOM 的坐标负对照。所有新增验收尚待托管执行。未在本机运行测试、检查、浏览器或候选算法。

整体目标继续 active。下轮取回本批结果、补取 095 缺失光标原 ZIP；继续处理原生光标严格差异、历史宿主崩溃、媒体换轨／旧编码、原生活跃音频控制和更多真实游戏兼容。应用门禁通过前，不把 094／095／096 的新增功能记为已验证完成。

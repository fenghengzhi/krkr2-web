# 089 托管回归修订与原生边界校准

状态：开发候选，尚未取得本批执行结果。整体目标仍是完成插件以外的 KRKR2 Web 模拟器。协议 **33**、TJS ABI **5**、字体 ABI **2** 不变。全部构建、测试、浏览器及原生探针只在 GitHub-hosted Actions 执行；整批推送后，下次工作再回收结果，不实时监控。

## 固定证据回收

本批对两次运行的 run、jobs、artifacts 端点各读取一次，固定其清单；没有刷新后来发布的结果。原始 ZIP、失败、旧快照与未比较范围均保留。

- [087／37275964642](https://github.com/fenghengzhi/krkr2-web/actions/runs/37275964642)，提交 `c87bc28347dda8d9aa1d2a8e3871129408aedf97`：**completed／failure**；23 jobs 中 12 成功、11 失败。23/23 ZIP、257,561,705 字节全部核对 API SHA-256 与大小。
- [088／37279350828](https://github.com/fenghengzhi/krkr2-web/actions/runs/37279350828)，提交 `7ebb8f65a9ecfffee8826b14a65dd3c739e14759`：**in_progress／conclusion=null**；24 jobs 中 8 成功、2 光标比较失败、14 运行中。固定 11/11 ZIP、32,793,832 字节全部核对。Node、主浏览器、runtime、KAG 等未发布，不能记为通过。

087 Node 完整 TAP 为 **3,007 通过、29 失败／3,036**，没有 cancelled、skipped 或 todo。失败分布：光标 2、ZIP 文件名 1、MP4 音轨 6、鼠标键 8、PhaseVocoder 4、窗口区域 8。11 份浏览器报告合计 43 unexpected，无 skipped、flaky 或全局报告错误；其中主浏览器 41、WebKit PWA 2。兼容库存 **94/96**，Firefox 原 KAG 光标的双后端失败。原始错误与汇总分别保存在两运行目录的 `089-final-summary.md`、`089-snapshot-summary.md` 及对应 JSON 中。

## 分片 MP4 随机访问索引

087 的 FFmpeg 6.1.1 原始 fragmented／interleaved 文件各有 36 条 tfra，其中 24 条声明音轨 2／3，却把 traf ordinal 写成 1。[该版本 mov_write_tfra_tag](https://github.com/FFmpeg/FFmpeg/blob/n6.1.1/libavformat/movenc.c#L4972-L4992) 固定写入 traf／trun／sample 三个 1，与原始字节吻合。独立解析记录在 `out/verification/github-actions/37275964642/089-mp4-original-tfra.json`；原视频和 ffprobe 包位置／哈希库存未改写。

选择器现在仅对这种首样本形式恢复冗余序号：三字段必须为 1；原 moof 内同 track ID 的 traf 必须唯一；tfra 时间必须等于该 traf 首样本的实际 CTS。正常全局 ordinal 仍按原序号检验；未知 moof、零／错误序号、非法 run／sample、错误时间及歧义不进入恢复。每个 moof 预建唯一轨道索引，避免每条 tfra 重扫所有 traf；修订后的序号必须装得进原字段宽度。

保留原媒体位置、mdat 和原始样本／时间轴校验；原夹具直接进入选择器，另外构造正确全局 ordinal 的副本进行等价对照。新增反例覆盖 time、run、sample、ordinal、offset 及重复 track。保留独立 ffprobe 哈希和全部旧非法容器断言，尚待 Actions 执行。

## 暂停视频的呈现时间戳

087 Chromium 原 trace 显示换轨候选已经呈现 `0.833333` 秒、累计两帧，但尚未安装为有效 video。独立 ffprobe 的第十帧为 `10240/12288` 秒，即 `833.333333…` ms；把回调的 `833.333` ms 交给播放位置的 floor 查询会落到第九帧，暂停候选随后不会再产生回调。

[rVFC 规范](https://wicg.github.io/video-rvfc/#dom-videoframecallbackmetadata-mediatime) 将 mediaTime 定义为已呈现帧的 PTS；[Chromium 回调实现](https://chromium.googlesource.com/chromium/src/+/5f0a846a46897e5bb123c7be9baeaef20cf6343d/third_party/blink/renderer/modules/video_rvfc/video_frame_callback_requester_impl.cc) 从媒体时间转换为秒。候选增加专用呈现匹配：选择唯一最近的 PTS，误差最多一微秒；普通播放位置仍使用原 floor 规则，没有扩大到一帧的模糊匹配或延长超时。

新增原始 `833.333` 字面值和边界负例；浏览器保留 frame 6 的既有检查，再增加 frame 10 的暂停寻址与双向换轨。WebKit 另一次普通文件失败停在 pause／frame 6 组合，原 trace 不足以归为相同原因，继续保留未定位状态。四份媒体 trace 的独立提取见 `out/verification/github-actions/37275964642/089-media-trace-evidence.json`。

## 测试程序入口与音频交付

087 WebKit 的两个 encoded-audio 和两个 PWA 媒体失败在 Vorbis 播放后出现 `Session has not been initialized`。原构建的 Ogg 模块从 `session.worker-BfhkMKao.js` 反向导入七个共享 parser 符号，入口本身也安装 `exposeRpc`；原网络记录出现重复入口请求。图结构与错误已经实测，入口实际重复求值、竞争空 Session 回复仍是待验证的因果推断。

本批将 Worker 使用的 codec-parser 固定到独立共享模块，保持 Ogg 延迟导入；增加构建图门禁，以真实 imports／dynamicImports 拒绝任何 chunk 导入有副作用的 Worker 入口。锁定的 Vite 8.3.0 在 Worker 构建内固定 `preserveEntrySignatures:false`，配置类型也不接受该选项，因此没有采用无效的 strict 配置。三项 Node 定义覆盖门禁，真实构建也必须通过它。原音频浏览器用例保留 sample position=100 和超时；额外记录实际 Worker、RPC 调用、同 ID 重复回复及异常，完成时严格核对单一 Session Worker 和零重复／错误，原运行的推断不冒充新结果。

MouseKey、WindowRegion 和 WindowMove 集成测试中的多语句经 `Scripts.exec` 执行，查询仍使用表达式接口。原问题是后续语句未执行，导致禁用状态、窗口变量、图像和终止标记未建立。补充状态／像素后置条件，原事件、坐标、矩形和取消期望不降低；生产求值接口不变。ZIP 范围读取改为覆盖仓库真实存在的 local ZIP64 与完整 ZIP64 两份 descriptor 夹具。

PhaseVocoder 的合成时钟一次推进 200 ms，需要 8,820 帧，超过初始 8,192 帧缓存；同一次同步调用不能让后台解码的宏任务交付新页。测试改为十次 20 ms，每步等待实际 pending 页归零，仍观察 200 ms、两个声道共 17,640 帧，并保持原非静音阈值。新增真实 WAV 范围源的受控缺页回归：缺页期间输出静音且音频位置冻结，交付后逐样本等于同滤波器的 resident PCM。没有据此改写 DSP，也没有把运行状态视为非静音证据。

## 无左键的同步窗口移动

088 两套托管 Windows 各七项观察完整，编译和进程退出为 0、清理完成。普通与无边框按住左键的两项进入／退出移动循环各一次，位移为 `(37,23)`；其余五项未按左键，均立即返回，没有 ENTER／EXIT，也没有位置变化。disabled、hidden、noactivate 三项同时没有按左键，因此不能单独归因于窗口标志。

页面候选据此在未观察到左键按住时立即提交原位置，不创建拖动预览或把嵌入窗口转为浮动。新增双后端、源码／字节码浏览器回归，验证可见和隐藏窗口的调用返回及嵌入布局保留。页面观测不能代表全局 OS 输入；原生证据来自自有 HWND 和受控 SendInput，不是原版 VCL／Layer 捕获实测。088 决策中的无指针报错策略在本批被此行为替代。

## 光标与原 KAG 验收

088 两 Windows strict 各 **335/392 matched、57 failures、2,158 uncompared**；3,770 条 mask 比较各全匹配，仅证明对应 plane。新增非对称 XY 和 checker 的完整颜色 plane 区分出 Y 比例也需先舍入 binary32，再以 binary64 累加。生产修订通用 Y 步长，增加原生像素／整 plane 哈希回归；其他放大比例的严格差异继续保留。

原 115 份参考样本不变，追加 13×32、13×63 各五种独立色场，总计 125 份。诊断保留原 176 个候选前缀，新增 112 个定点步长组合，总计 288；这些候选只在托管 runner 执行，不是生产量化策略或通过结论。WebKit CSS auto 1.5 的边缘颜色差异尚未定位，保留严格零差异断言并采集额外边缘采样诊断。

原 composition trace 的 canvas 中心位于视口上方，鼠标没有实际进入 canvas；测试先滚动并确认真实指针已接管，再检验离开后的隐藏。Firefox KAG 两后端已进入第二标签，但测试一直按住确认键等待整页排版，最终报告输入队列满。候选在原 Conductor 确认新标签后释放，再验证中立采样和原有页面完成条件；保留真实输入、原 KAG、脚本变量及错误严格检查。长时间持键产生队列满的生产行为没有据此宣称解决。

## 后续范围

新增 **8 个 Node 定义**：MP4 索引 2、呈现时间戳 1、真实流式 PCM 1、光标 1、Worker 构建门禁 3。新增**每浏览器 4 个定义**验证无左键移动；原多音轨、音频和 KAG 定义补充严格检查。普通多音轨另添加有限、被动的媒体事件／最终 candidate 状态附件，不改 currentTime、不增加 rVFC 或轮询，供继续定位 WebKit 暂停寻址。

088 的应用结果待下批补取；089 全部变更仍待新的 GitHub-hosted 结果。普通多音轨切换、WebKit 音频／PWA 媒体、剩余原生颜色差异分别保留证据并继续处理。非插件兼容功能、真实游戏覆盖与跨浏览器运行仍属于整体目标，当前没有完成结论。

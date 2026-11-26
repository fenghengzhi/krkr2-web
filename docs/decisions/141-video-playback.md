# 第 141 批影片播放

游戏可以先调用 `VideoOverlay.setSegmentLoop` 指定循环区间，再打开片头或过场影片。原版将两个参数保存为有符号的 32 位帧号。播放器到达正的结束帧时才使用起点，起点为负数时回到第零帧。因此使用 `setSegmentLoop(-9,14)` 的游戏现在可以看到第 14 帧处的回环，并在第二次经过提示帧时继续剧情。结束帧大于片长也可以保存，影片自然播放时不会经过该边界。[原版脚本绑定](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp#L342-L363) · [原版帧更新](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp#L679-L696)

结束帧为零或负数时，保存的范围仍可读取。取消循环会把两端都恢复为 `-1`。当有效边界触发、目标帧却超出片尾时，Web 播放器将此次跳转停在媒体结尾，并按游戏的整段循环开关处理。这个片尾落点是浏览器宿主的处理方式。原版源码将跳转请求交给 DirectShow，Windows 无影片对照只核查设置、读回、参数错误和取消。[源代码与字节码验收](../../tests/integration/video-graph-controls.test.ts) · [Windows 原版对照](../../tests/probes/player-config-sdk.ts) · [浏览器片尾验收](../../tests/browser/video-graph-controls.spec.ts)

浏览器中的剧情按钮分别验证负起点回环、打开前已设置的远端结束帧、结束帧为零时的普通播放。记录包含实际回调顺序、暂停位置和游戏画面上的提示标记。[剧情脚本](../../tests/helpers/video-period.ts) · [浏览器验收](../../tests/browser/video-period.spec.ts)

## 多轨影片在什么阶段停住

第 133 批首版的 Firefox 失败分成两组。八组交错封装案例都已定位到 1 秒，Firefox 也提交了新的画面。回调给出的 1 秒位于 0.938070 秒和 1.021403 秒两个样本起点之间，此前的判断始终在等恰好等于样本起点的时间戳。另八组普通封装案例已经完成主影片的音轨切换，随后卡在打开第一部隐藏的对照影片。浏览器报告数据就绪，记录里还没有这部影片的首帧回调。[第 133 批首版运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623)

同一批 WebKit 的 16 个失败中，14 个在第一次取图时就出现通道值相差 1，另一个在第一次比较窗口中的三块画面时失败。当时脚本还未尝试切换视频轨道。余下一个在启动时超时。因此判定切轨需要分别记录解码图像、实际图层画布和屏幕合成结果，再和同一时刻的独立单轨影片作比较。[多轨影片验收](../../tests/browser/video-stream-selection.spec.ts)

普通按时间定位现在同时核对媒体时钟、新提交的帧计数和选中样本。已经能呈现的影片沿用游戏窗口。隐藏影片等待首帧时会暂用一个透明、非零尺寸的呈现区域，完成或取消后释放。首帧仍须由浏览器实际提交。新增验收连续打开两部隐藏影片，检查暂停时钟、整幅首帧的颜色以及关闭后迟到回调的处理。Firefox 首帧超时的成因仍需在托管运行中确认。[播放宿主](../../src/backends/video/browser/host.ts) · [真实首帧](../../tests/browser/video-host-lifetime.spec.ts)

WebKit 验收保留默认解码读回，同时用与实际图层相同的读取方式比较整幅参考影片。屏幕上的三幅图像各自留出相同的黑色边距，以免浏览器缩放时从不同颜色的邻居采样。测试读取实际视口截图中的整个影片区域，并另行检查游戏画布中的两块绑定图层与参考图层。通道比较仍要求精确相等。[截图与像素比较](../../tests/helpers/video-selection-capture.ts)

## 已取回的结果

第 133 批最终版的 Chromium、Firefox 和 WebKit 兼容清单各通过 32 项。Node 来自同一提交的 4,059 项已全部报告，其中 4,055 项通过，4 项图层断言失败。常规浏览器的九个分片在此次取回时仍在运行。这些结果对应第 133 批提交。第 134 至 140 批当时仍在等待执行。[第 133 批最终版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490) · [第 140 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45771395938)

本次清点的 43 份归档中有 42 份按大小和 SHA-256 核验。缺少的 Chromium PWA 归档仍待取回。已取得的三浏览器游戏库共 57 项通过，Firefox 和 WebKit 的 PWA 共 39 项通过。原版书签跨引擎对照为 124/124。[第 133 批最终版作业及产物](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490)

第 141 批实现提交为 `0d64d8214f24ba61affb5bba7d0cd5c025caaf91`，新增三个 Node 用例和每个浏览器一个连续打开隐藏影片的用例，并扩充了分段回环、切轨和原版属性对照。GitHub 首次登记的状态为 `pending`，下一批取回结果。[第 141 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45773107877)

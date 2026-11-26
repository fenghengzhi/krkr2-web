# 第 173 批触屏选章与影片起点

## 单指点击原版章节

原版 KAG 通过鼠标移动选择指针下方的链接，随后处理按键。此前触屏直接按下时，播放器会发送原始触摸和兼容鼠标按下，图层可能要到抬手后才收到移动。现在主触点在新位置落下时先把该位置交给游戏，再按下左键。浏览器已经送过同一位置的移动时会沿用该次输入。玩家在同一位置再次触摸时，输入坐标保持原值，原版剧情可以继续用自己的距离阈值防止误选。[浏览器输入](../../src/backends/input/browser.ts) · [W3C 触屏兼容鼠标事件](https://www.w3.org/TR/pointerevents3/#mapping-for-devices-that-do-not-support-hover)

新增验收用一次触屏点击，在未经修改的 Introduction 发行包中从菜单进入第一章，核对剧情标签、背景和原版停顿。另一项浏览器验收连续点两个控件，检查按下时游戏已选中正确控件，每次均收到一个原始触摸按下和一次点击。输入队列用例另对照浏览器已发送移动、Ctrl 修饰键和双指操作。第二指落在同一或另一游戏窗口时，各窗口仍按接触编号收取原始消息，第一指的兼容点击取消。[浏览器章节与控件](../../tests/browser/input.spec.ts) · [触摸事件次序](../../tests/conformance/browser-input-coordinator.test.ts)

## 首帧在零秒之后的影片

第 170 批 Firefox 的两种分段 MP4 已经交付了时间戳为 1/6 秒的首帧。播放器随后尝试恢复零秒，浏览器停在 1/6 秒，播放器仍等时间变成零，游戏没有返回影片菜单。旧报告记录了帧和时钟，未记录当时的可定位区间。现在当目标早于浏览器报告的最早可定位位置时，定位和暂停画面的检查使用该起点。浏览器允许定位到零秒的影片仍使用零秒。首帧回调、游戏画面和音轨各自按原始时间轴观察。[影片定位](../../src/backends/video/browser/host.ts) · [HTML 媒体定位规则](https://html.spec.whatwg.org/multipage/media.html#seeking)

托管用例将记录浏览器的可定位区间，比较打开影片、游戏设置第零帧和设置零秒后的画面，再从两秒处验证暂停、换语言和播放。另一份多音轨影片曾经从头播到结尾，浏览器仍未交付期望的画面回调，该失败继续保留。普通 WAVE 播完时会先把采样位置归零，既有系统事件验收按此修订了预期值，仍分别核对音视频的停止和回调。[影片与双层像素验收](../../tests/browser/video-fragment-duration.spec.ts) · [系统事件验收](../../tests/browser/system-events.spec.ts)

## 本次取回的托管结果

第 170 批 Firefox 游戏库报告有 65 项通过、37 项失败。36 项属于 Chromium 报告中已记录的光盘选择、章节输入及 CD 音轨用例；第 172 批为这些问题提交的改动在本次取回时仍在排队。另外一项 Firefox 大影片用例没有到达游戏预期的暂停状态。WebKit 离线验收 21 项全部通过。[Firefox 游戏库](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168920) · [WebKit 离线验收](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168952)

Firefox 的四项字幕报告均在普通字形阶段出现首个像素差，当时尚未画下划线或删除线。此前记录的画布尺寸问题已越过。为区分字体选择与实际绘图差异，本批会在失败时保存游戏画布、页面参考和独立 Worker 用两组字体设置绘出的字形、测量值及首个不同字节。五个样式仍按整幅像素逐字节核对。[字幕像素验收](../../tests/browser/text-decoration.spec.ts) · [字体测量与图像记录](../../tests/helpers/text-decoration-observation.ts)

第 170 批 Firefox 主浏览器第 3 分片有 302 项通过、22 项失败。其中 16 项涉及影片启动或换音轨，4 项是文字像素对照，2 项是声音结束位置。Node 作业在运行期间被取消，顶层 TAP 文件只写出了 14 项通过记录，缺少完整结果。此次取回的第 171、172 批均尚无作业结果。[Firefox 主浏览器分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169122) · [Node 作业](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168400) · [第 171 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320) · [第 172 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217)

第 173 批实现提交 `5c22ca8` 登记时为 `pending`，下一批取回运行结果。[第 173 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259)

# 第 175 批旧 AVI 过场、触屏选择和游戏库重试

## 旧 AVI 过场与 WMV 定位

影片转换器新增 Microsoft Video 1（MSVC）和 DivX 3（DIV3）视频解码，以及 IMA ADPCM 和 Microsoft ADPCM 声音解码。托管流程分别制作两段 AVI，每帧写入可读编号，音轨含静音和三个不同音调。游戏脚本通过普通 `VideoOverlay` 打开影片、暂停、按帧定位、播放和停止。验收同时观察视频元素、两个游戏图层、帧回调及实际声音输出。[转换器构建](../../scripts/build-legacy-media.mjs) · [独立制片](../../scripts/generate-legacy-video-fixtures.mjs) · [浏览器过场验收](../../tests/browser/legacy-video.spec.ts)

第 170 批 Firefox 的 WMV1 在游戏时钟 1 秒时读到编号 24 的画面，源文件时间轴在该时刻指向编号 23。本批给浏览器记录增加相邻源帧的显示时间和实际可定位区间，并用系统 FFmpeg 独立解码 WASM 转出的 WMV1、WMV2 对应 MP4，逐帧对照画面编号和显示时间。偏差的原因仍待验证。[托管转换验收](../../tests/conformance/legacy-media.test.ts) · [原始 Firefox 分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169027)

## 触屏与游戏库

手指在一个控件按下、拖到另一个控件后松开时，游戏的单击事件现在使用按下时的画布坐标，抬起事件仍收到松开坐标。鼠标和触屏都在输入进入队列时保存坐标，即使游戏在拖动中改变缩放或图层原点，也能区分这两个位置。验收覆盖跨控件拖动、焦点、原始触点和点击次数，Chromium 还会实际发送持续到松开的触摸手势。[输入实现](../../src/backends/input/browser.ts) · [跨缩放坐标](../../tests/conformance/browser-input-coordinator.test.ts) · [浏览器控件](../../tests/browser/input.spec.ts)

游戏库首次连接 Worker 失败后会释放这次连接，清除失败的连接请求与进行中的导入标记，允许玩家重新导入。已被替换的连接即使稍后才失败，也不会关闭新的连接。[游戏库客户端](../../src/player/library-client.ts) · [连接、重试与取消验收](../../tests/browser/client-stop.spec.ts)

## 剧情、音乐和字体

原版 Introduction 增加键盘游玩验收，覆盖选章、逐句推进、翻阅多页历史、回到原来的一句和退出。另有四组自编 KAG 剧情在新章节用原版 `[hr]` 开始历史新行，对应 Firefox 的 16 个失败。长 Vorbis 音乐的旧报告同时记录了连续输出和循环标签，标签名中的双引号也被原样读入。验收素材现采用原版 SLI 的单引号语法，并检查同一段音乐两次触发游戏内可见的剧情变化。[原版键盘游玩](../../tests/browser/kag-intro-history.spec.ts) · [章节历史](../../tests/helpers/kag-condition-stack.ts) · [音乐触发剧情](../../tests/browser/long-vorbis.spec.ts)

Firefox 另有八个字体候选及字体合集用例的画布顶部处在小数 CSS 坐标，元素截图因此多出一行。修订后的用例独立核对 CSS 尺寸和绘图缓冲区的全部像素，并保留截图。另一个旋转删除线用例在缓冲区内的透明度值存在差异，仍保留失败记录。[字体候选](../../tests/browser/font-candidates.spec.ts) · [字体合集](../../tests/browser/font-collection.spec.ts) · [Firefox 原始分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168958)

## 此次取回的历史结果

第 170 批新取得六份普通验证报告。下表为其中已经写入报告的用例，取消作业中没有结果的用例单独列出。

| 作业 | 通过 | 失败 | 跳过 | 未报告 |
| --- | ---: | ---: | ---: | ---: |
| [Firefox 浏览器 1/4](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168958) | 315 | 32 | 1 | 0 |
| [Firefox 浏览器 4/4](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168964) | 284 | 54 | 0 | 0 |
| [WebKit 游戏库](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168668) | 65 | 37 | 0 | 0 |
| [WebKit 浏览器 2/4，已取消](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169069) | 177 | 48 | 0 | 146 |
| [WebKit 浏览器 4/4，已取消](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169015) | 161 | 42 | 0 | 135 |
| [Chromium 浏览器，已取消](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169086) | 578 | 82 | 0 | 721 |

取回时第 170 批还有一个作业在运行，第 171 至 174 批仍在排队。[第 170 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668) · [第 174 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45863379478)

第 175 批实现提交 `aed119f` 登记时为 `pending`，下一批取回结果。[第 175 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45865578673)

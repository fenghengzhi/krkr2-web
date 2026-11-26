# 大过场、剧情滚轮与音频定位

## 从游戏包和原始光盘读取过场

原始 CUE/BIN 光盘的 2352 字节扇区中只有一部分是影片数据，压缩包成员也需要先解压。两种资源都可以分段读取，但无法直接把原文件的一段交给视频元素。此前，即使游戏已经读到了目录，超过 128 MiB 的这类影片也会在打开时被拒绝。

当影片超过 128 MiB、具有分段读取能力且无法直接借用文件时，游戏 Worker 现在按最多 1 MiB 一段写入浏览器的源私有文件系统（OPFS）。播放器等待写入、刷新、关闭和长度检查完成，随后把文件交给解码器。一个会话中的临时影片合计最多 2 GiB，实际可用空间也受浏览器配额限制。打开影片需要等这份临时文件写完。已有原始文件切片的散装影片、已存储的 XP3 成员和普通 ISO 仍直接读取。[影片准备](../../src/backends/video/port-backend.ts) · [临时文件](../../src/backends/files/temporary-movies.ts) · [File System 标准](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle)

浏览器播放器在最后一份影片或换轨用的文件引用释放后通知 Worker 删除临时文件。会话中止时会清理未完成的写入。若标签页在清理前关闭，下次需要暂存影片时会检查遗留文件。每份活动文件从创建前就持有独立的 Web Lock，其他标签页回收遗留文件时会保留它。[文件引用](../../src/backends/video/browser/encoded-source.ts) · [Web Locks](https://www.w3.org/TR/web-locks/#api-lock-manager-request)

托管验收把同一段含两条画面轨和两条音轨的 MP4 分别放入 Python 压缩的 ZIP，以及带 2352 字节扇区头、两个非连续文件区段的 CUE/BIN 测试盘。实际音视频包和索引均在 144 MiB 之后。游戏按钮切换画面和音轨，验收读取解码器与游戏画布的像素、播放位置和声音，再检查关闭影片后临时文件已删除。独立的浏览器 Worker 用例覆盖活动文件、遗留文件、短读和取消。[大影片播放](../../tests/browser/video-large-file.spec.ts) · [临时文件回收](../../tests/browser/temporary-movies.spec.ts)

## 横向滚动与原版 KAG 阅读

原版 KAG 在等待玩家推进对白时会根据滚轮方向决定打开历史还是继续阅读。此前，水平滚动也会把数值为零的垂直滚轮通知送给游戏，导致剧情意外前进。现在玩家横向滚动时可使用页面原有的滚动行为，垂直触控板的细小位移会按方向累积。验收用原模板的脚本与字节码检查横向滚动后剧情仍停在原行，上滚能打开历史，下滚能继续阅读。[滚轮输入](../../src/backends/input/browser.ts) · [原版 KAG 阅读验收](../../tests/browser/kag-wheel-axis.spec.ts)

## 长音轨定位

第 171 批 Firefox 的长 Vorbis 曲目在游戏脚本设置播放位置后，先输出了 896 帧静音，约 18.7 毫秒。后面的实际输出是预期的 440 Hz。此前混音器会先提交新位置，再等 Worker 解码该处的音频。现在流式 Wave 定位先请求目标采样所在的数据页，混音器收到后才提交位置并回复脚本。已经缓存的采样可以直接使用。新的定位或关闭声部可以取消尚在等待的操作。[混音器](../../src/engine/media/mixer.ts) · [数据页交付与定位](../../src/backends/audio/source-seeks.ts)

新的定位用例在目标页仍被占用、稍后到达、读取失败，以及播放被停止或新定位替代时检查实际混音器状态。浏览器录音验收保留原有的 2 毫秒循环乐句，每次采集后清理已随该次结果返回的事件，同时核对后续事件的连续编号。WAVE 自然播放结束后，测试通过原声部编号查询停止状态。[流式定位验收](../../tests/conformance/audio-source-seek.test.ts) · [循环乐句](../../tests/browser/wave-speaker-mask.spec.ts) · [自然停止](../../tests/browser/wave-riff-layout.spec.ts)

## 本次取回的托管结果

第 171 批以失败结束。全部 15 份常规浏览器报告已取回，3,258 项通过、501 项失败、2 项跳过，另有 789 项未报告。此前下载失败的 Firefox 第 1 分片现已取得。原版 Introduction 第一条路线的书签保存与刷新读档，以及完整第二条路线，均在 Firefox 的 Asyncify 和 JSPI 后端通过。[第 171 批 Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320)

第 172 批已取得生产构建和独立类型检查的成功结果。三种浏览器的离线用例共 65 项通过，原版 KAG 与运行时兼容用例共 96 项通过。取证时主 Node 和常规浏览器报告尚未发布，已有 3 个作业失败。第 173 至 179 批当时仍在排队。[第 172 批 Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217) · [第 179 批 Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45875774925)

第 171 批有七份 WebKit 播放中换轨记录，候选解码器最后一次定位都精确等于原影片冻结时刻。此前验收还把准备首帧时的定位算进了换轨次数。本批保留每次真实定位，单独核对提交前的准备位置、最终恢复时钟、音调和资源释放。另有一个用例在首次打开影片时超时，仍记为独立失败。[换轨验收](../../tests/browser/video-playing-audio-switch.spec.ts)

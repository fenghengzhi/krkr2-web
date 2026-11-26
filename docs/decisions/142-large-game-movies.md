# 第 142 批大体积过场影片

此前游戏通过 `VideoOverlay.open` 打开影片时，会话先调用资源的整读接口。有些文件源和归档成员在这一步最多允许读取 64 MiB。播放端为多轨 MP4 建立另一条音轨或画面时，还会复制整个文件。在原游戏里能正常播放的大型片头可能因此无法打开或切轨。

浏览器现在可以让解码器直接使用本地文件的不可变切片。MP4 解析器按原始偏移读取文件顶层的盒头、轨道表和片段索引，跳过 `mdat` 的音视频内容以及顶层填充。索引在媒体之后的影片也走这条路径。切换轨道时，用一组小范围的元数据修改和原文件切片组成新的播放文件。原有音视频包保持原位，因此暂停定位、图层输出和音轨选择可继续使用同一组原始时间戳。[时间轴解析](../../src/formats/video/mp4.ts) · [选轨](../../src/formats/video/mp4-audio.ts) · [播放资源持有](../../src/backends/video/browser/encoded-source.ts)

文件视图和需要在内存中拼出的数据各自计量。浏览器播放端同时持有的借用文件视图上限为 2 GiB，已缓冲的影片源上限为 128 MiB。每次读取 MP4 元数据最多使用 64 MiB 的输入预算。切轨时旧影片保持可用，直到新影片成功安装。新影片准备失败或用户停止游戏时会释放对应的元数据额度和对象 URL。宿主对已持有的编码字节另有 256 MiB 预算，浏览器解码器的内部分配由浏览器管理。

散装影片和未受保护、在 XP3 内物理连续的原始片段可以借用原文件。ZIP 中以存储方式保存的成员要先完成整项 CRC 校验。游戏库中的 OPFS 文件要先按 1 MiB 块验证覆盖该影片的每一项 SHA-256，再把同一份文件快照的切片交给播放端。HTTP 范围源及可分块解压的影片按最多 1 MiB 的读取请求拼成 Blob，准备好完整文件后才开始播放。只提供整读接口的嵌入环境仍受其 64 MiB 整读上限约束。[XP3](../../src/formats/xp3/archive.ts) · [ZIP](../../src/formats/zip/archive.ts) · [游戏库读取](../../src/backends/files/opfs-library.ts)

## 游戏验收

托管浏览器使用一部含两条 H.264 视频轨和两条 AAC 音轨的影片。测试把 FFmpeg 生成的原始音视频包放在一个超过 144 MiB 的 `mdat` 盒子末尾，并把 `moov` 索引放在文件尾部。测试文件使用稀疏存储。游戏分别从散装文件和 XP3 打开影片，实际显示红色背景和白色标记，再通过游戏按钮切换到蓝色背景和黄色标记。验收还核对 3 秒处的暂停位置、第二条音轨的 880 Hz 声音，以及退出后媒体资源的释放。[影片制作](../../tests/helpers/large-video-game.ts) · [游戏验收](../../tests/browser/video-large-file.spec.ts)

游戏库用例在保存 XP3 后刷新页面，移除测试目录的原文件，再从库内启动游戏、选择第二条视频轨。HTTP 用例使用另一份超过 68 MiB 的 XP3 成员，记录收到的范围请求并在第二次打开时暂停服务器响应，验证停止游戏能取消等待。测试从实际的窗口消息端口观察文件大小和来源标记。[游戏库重开](../../tests/library-browser/video-large-file.spec.ts) · [HTTP 读取与取消](../../tests/browser/video-range-fallback.spec.ts)

会话协议升至 51。此前向嵌入式后端传递 `Uint8Array` 的调用方式继续可用，浏览器端口还可传递文件切片和缓冲来源标记。游戏关闭影片或在同一个 VideoOverlay 上打开另一部影片时，会丢弃旧请求迟到的读取结果。超时的打开请求按本次打开的标识清理。[端口与资源回收验收](../../tests/conformance/video-resource-source.test.ts)

格式层对四种普通和分段 MP4 布局逐字节比较两种选轨输出，并用 224 MiB 的稀疏文件检查头部或尾部索引。整个第 142 批新增 24 个 Node 用例，每个浏览器新增 6 个常规用例和 1 个游戏库用例。[MP4 字节对照](../../tests/conformance/video-mp4-blob.test.ts) · [源码与字节码会话](../../tests/integration/video-resource-source.test.ts)

## 已取回的托管结果

第 133 批最终版新增四份常规浏览器分片报告，共 1,066 项通过、28 项失败、1 项跳过。Firefox 的两条原版介绍游戏路线和四项缩略图保存恢复均通过。此前缺少的 Chromium PWA 原件已取回，三个浏览器的游戏库及 PWA 用例合计 116/116 通过。本次清单列出的 47 份 ZIP 均已核对官方 SHA-256。第 134 至 141 批在此次取回时仍在队列中。[第 133 批最终版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490) · [第 141 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45773107877)

第 142 批实现提交为 `fd5f66b12a0f9e0b31a589eeafded7142a18f085`，GitHub 首次登记时为 `pending`。本批运行结果留到下一批取回。[第 142 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45775883723)

# 大型远程游戏、空间音效与字幕验收

## 从静态服务器读取游戏

部分发行站为游戏包提供字节范围和修改时间，但没有提供强 ETag。过去，超过 64 MiB 的此类游戏会在读取第一个字节后停止。现在播放器可按需读取它们。首次 206 响应须给出标准 GMT 格式的 `Last-Modified` 和至少晚一分钟的 `Date`。这个间隔为服务器时钟差预留余量。后续读取带上 `If-Unmodified-Since`，并逐次核对返回的修改时间、最终地址、总长度和区间。如果文件被换成较老的版本，服务器仍可能返回 206，此时播放器也会因修改时间不同而丢弃该来源的缓存。[HTTP 日期校验](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.2.2) · [条件范围读取](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.4)

跨域站点需要允许请求头 `Range, If-Unmodified-Since`，并让页面可以读取 `Content-Range, Date, Last-Modified, Content-Encoding`。提供强 ETag 的站点继续使用 `If-Match`。原先以完整快照打开的小文件仍使用相同的内容哈希定位存档。仅支持整文件下载的服务器仍受每会话合计 64 MiB 的快照预算限制。[HTTP 来源实现](../../src/backends/files/http-range.ts) · [分段、版本变化和旧存档用例](../../tests/conformance/http-range.test.ts)

托管浏览器用例通过播放器的远程链接打开一个原版 KAG 游戏。ZIP 中的启动和剧情文件位于 70 MiB 填充区之后。用例选到章节 7，保存，改到章节 99，停止并刷新页面，然后从同一地址启动，检查存档字节和读回的章节。[远程游戏验收](../../tests/browser/remote-date-game.spec.ts)

## 游戏脚本控制声音位置

原版游戏可以在启动配置中开启 `-wsuse3d`，再用 `WaveSoundBuffer.setPos` 或单个坐标属性移动音源。网页播放器在双扬声器上表达这种位置变化。横向移动改变左右声道的能量分布，移远会减小音量。验收覆盖真实脚本调用和浏览器音频输出；这个实现的比较范围是声源方向、距离和播放状态。[Wave 脚本入口](../../src/engine/media/sounds.ts)

首个 Wave 实例确定本次会话的选项。未声明扬声器位置的单、双声道素材可进入空间混音，双声道先转单声道。带扬声器掩码的素材和三个以上声道的素材保留原有布局。浏览器采用左右等功率分配和距离衰减，输出为立体声。会话协议版本为 72。[原版 Wave 实现](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L2090) · [双扬声器混音](../../src/engine/media/wave-spatial.ts)

浏览器验收通过游戏按钮移动声源、暂停、恢复和停止播放，并分别录取左右声道。双声道 32 位整数素材经过 Float32 再做 16 位单声道转换，量化边界附近的最低位存在精度差异。[浏览器音频验收](../../tests/browser/wave-spatial.spec.ts)

## 本次取回的托管结果

第 173 批 Firefox 常规浏览器第 3 分片共 324 项，其中 304 项通过、20 项失败。4 项字幕用例中，初始画面的每个 RGBA 字节均与独立 Worker 中的参考画面一致。页面中同名通用字体给出了不同的字符宽度和基线。此次改用独立 Worker 生成参考画面，逐字节比较五种字幕样式，保留实际玩家点击和页面对照。后续四种样式仍待托管验收。[第 173 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259) · [字幕验收](../../tests/browser/text-decoration.spec.ts)

其余 16 项分别在等候视频音轨交接、换轨时失败。这份报告来自较早的提交；取回时第 174 至 184 批仍在排队。历次证据按其原始提交和状态保留。

# 第 162 批游戏章节跳转、书签与 MPEG 过场时序

## 第 160 批揭示的游戏问题

Chromium 游戏库共执行 74 项，25 项通过，49 项失败。16 项在自定义入口首次加载 KAG 的 `system/Initialize.tjs` 时失败，4 项在读取日文模板的 `Config.tjs` 时解码失败。另有 28 项已进入目标章节，标题的历史记录含有上一页的选项。余下 1 项在远程下载阶段提前失败。取回时常规 Node 和主浏览器分片尚无结果。[原始游戏库报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938356422)

第 160 批的生产构建和工具类型检查通过，三个浏览器的 PWA 合计 65/65 通过。常规兼容检查中 Chromium 为 32/32、Firefox 为 31/32、WebKit 为 32/32，Firefox 有一项帮助菜单截图超时。原版图形为 124/124，原版 KAG 为 122/124。两种 Web 脚本执行模式都观测到了宏转发时的属性提前读取。旧影片素材的独立检查也失败。第 161 批在同一次取回时仍为 `pending`，尚无作业结果。此次新归档 21 份普通原件，复用 22 份，43 份均核对了大小和 SHA-256。[第 160 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404) · [KAG Web 对照](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938355903) · [第 161 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45831107660)

## 在游戏脚本选章时读取属性

宏用 `*` 转发一个由 getter 计算的属性时，转发过程现在保留属性本身。执行条件、嵌入文本、调用章节、跳转或返回时才读取相应字段。一个游戏可以在读取 `storage` 时选定新场景，再由 `target` 读取该场景的入口。原版和 Web 共用五组新对照，另外从模板游戏点击进入新章节，保存、重启、读档并返回调用处。[KAG 解析器](../../src/engine/kag/parser.ts) · [宏属性桥接](../../src/engine/tvp/kag.ts) · [原版对照剧情](../../tests/helpers/kag-control-properties.ts) · [浏览器游戏验收](../../tests/browser/kag-control-properties.spec.ts)

## 原版模板的启动与剧情验收

自定义启动脚本现在显式注册原版 XP3 里的系统和剧情目录，供初次启动和从游戏库重开时使用。桌面脚本选择规则保留，松散章节仍优先于模板自带的章节。GBK 游戏在载入模板前显式切换为 Shift_JIS，模板运行后再切回 GBK 读取汉化剧情。各游戏验收中的章节标题用原版 `[hr]` 开始独立的历史行。链接文字、标题全文、书签内容和重开后的剧情仍须逐项匹配。[自定义启动脚本](../../tests/helpers/custom-entry-distribution.ts) · [汉化游戏启动](../../tests/helpers/script-encoding-game.ts) · [章节与书签验收](../../tests/helpers/combined-launcher.ts)

远程下载用例在实际游戏库 Worker 启动后注入一次目录提交失败，保留原始 Worker 和实际 HTTP 范围请求。用例记录故障是否命中，并要求第二个标签页只取回损坏的块，完成入库后能启动游戏。[下载修复验收](../../tests/library-browser/remote-download-integrity.spec.ts)

## MPEG-1 过场的逐帧定位

上一批的 25 fps 裸视频里，独立解码器报告 100 个时长 40 毫秒的画面。探测工具生成的时间戳却从 40 毫秒跳到 120 毫秒。对于这种没有容器时间戳的 MPEG-1 基本流，播放器的转换器现在按解码器从序列头取得的帧率，依显示顺序计算每幅画面的起始时间。带音轨的 MPEG 节目流、AVI 与 ASF 继续使用容器时间戳，从同一原点计算音画偏移。[旧素材失败记录](https://github.com/fenghengzhi/krkr2-web/actions/runs/45828022404/job/139938355906) · [上游 MPEG 解码器](https://github.com/FFmpeg/FFmpeg/blob/n5.1.9/libavcodec/mpeg12dec.c) · [转换器修改](../../native/legacy-media/elementary-mpeg1-clock.patch)

托管机器独立生成两种裸流，一种为 25 fps，另一种为 30000/1001 fps 并包含 B 帧。原生 FFmpeg 检查每一帧的时长、颜色和画面编号，另保存探测工具生成的时间戳。发布使用的 WASM 转换器输出 MP4 后，其全部 100 个呈现时间要与独立参考相符。[素材与时间基准](../../scripts/generate-legacy-video-fixtures.mjs) · [WASM 输出对照](../../tests/conformance/legacy-media.test.ts)

# 第 137 批图层透明度、剧情开关与影片播放

## 游戏画面与截图

游戏可以把多个图块挂在一个没有主图像的 `ltOpaque` 图层上，再改变这组图块的透明度。原版对每块区域分别绘制。单个同类型、完全不透明的子图块在独占区域可以直接绘制到祖先图层，保留自己的亮度。重叠区域、父层自己的填色，以及启用缓存后的整组图像，随父层一起淡化。窗口绘制现在复用截图已有的按区域绘制逻辑，并使用窗口图层自己的缓存设置。[原版区域划分与转交](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1780-L1835) · [合成实现](../../src/engine/scene/completion.ts)

原版 Windows 对照新增两组观测。一组读取父层填色与子图块在独占、重叠和缓存状态下的 RGB，另一组把完全透明的子树绘制到两个已有像素上，分别检查原来的遮罩 255 和 73。浏览器在显示画面和游戏截取的画面中取同一位置的像素，并在开启、关闭缓存后再次比较。[共用场景](../../tests/helpers/layer-alpha-rows.ts) · [浏览器验收](../../tests/browser/layer-neutral-color.spec.ts)

## 剧情与影片

`KAGParser.processSpecialTags` 和 `ignoreCR` 现在按 TJS 的布尔值规则读取。游戏写入非零小数也能开启剧情标签处理和忽略物理换行，`debugLevel` 仍按整数读取。原版对照同时观察属性、实际跳转到的标签和换行。浏览器使用原 KAG 模板处理玩家点击的剧情选项。[解析器绑定](../../src/engine/tvp/kag.ts) · [剧情用例](../../tests/helpers/kag-modes.ts)

已有影片正在播放时，游戏调用 `VideoOverlay.open` 若缺少文件名或传入无法转换为字符串的值，当前影片继续播放，原来的提示点仍然有效。传入能转换成字符串的名称后，先关闭旧影片，再尝试打开新资源。验收分别检查错误、状态回调、后续帧及重新播放。[影片绑定](../../src/engine/tvp/video.ts) · [浏览器验收](../../tests/browser/video-open.spec.ts)

## 托管验证

第 132 批已结束。常规浏览器记录共 3,243 项，其中 3,160 项通过、81 项失败、2 项跳过。原版介绍游戏六条路线全部完成。第 133 批首版的 Node 结果为 4,055 项通过、4 项失败。上一批的 11 项失败与 2 项超时在此版本全部通过。新出现的 4 项失败来自两个图层用例的源码版和字节码版。本批将这些差异交给原版 Windows 和浏览器交叉核对。[132 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45757288264) · [133 首版运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623)

133 首版已取回的原版对照包括 61 个 KAG 场景、124 项跨引擎书签观察和 55 项图层等图形观察，均已匹配。WebKit 的原 KAG 模板走到剧情停顿后，打开历史记录时超过用例的五秒等待，随后 11 项未执行。133 最终版以及 134 至 136 在本次取回时仍处于排队状态。已列出的 92 个历史归档均通过大小和 SHA-256 核对。

原始日志显示首次打开历史记录期间加载了 `ButtonLayer.tjs`。这一步的验收现在只提交一次打开操作，给首次加载二十秒，并在成功或失败时记录耗时。游戏须实际显示历史记录、把它设为当前模态图层、响应 Escape 并继续剧情才能通过。[原 KAG 路线验收](../../tests/probes/kag-browser.ts)

本批实现提交为 `a9693783004e6cd0fa783f32e3c0a2dced971a61`。托管工作流首次登记为 `pending`，结果留待下一批取回。[第 137 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45766826621)

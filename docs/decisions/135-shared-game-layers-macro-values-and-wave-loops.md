# 第 135 批图层图片共享、KAG 宏参数与平滑音乐循环

## 复制画面与点击区域

在原版中，`Layer.assignImages` 让目标层引用源层的主图和区域图（Province）。每层仍有自己的绘图裁剪、显示位置和大小。修改主图时只复制主图，修改点击区域时只复制区域图。再次赋予同一张主图会重置目标的裁剪和修改标记，原版不会为这次赋值单独要求重画。[原版图层赋值](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2085) · [原版位图赋值和写入分离](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L1857)

Web 的渲染、截图和命中测试直接读取共享图像。绘图或加载新内容时，原来引用它的其他层仍能看到自己的画面。图层持有的 64 MiB 预算按实际像素分配计数。例如一张 2048 × 1536 的 RGBA 底图和同尺寸点击区域分别占 12 MiB 和 3 MiB。八个页面引用这两张图时，仍只占 15 MiB 图像数据。编辑其中一页后才为该页修改的图像分配独立存储。显式调用 `independMainImage(false)` 或 `independProvinceImage(false)` 分离共享图像时，Web 将新存储初始化为零。原版未规定这种新存储的初始像素。[图层实现](../../src/engine/scene/layers.ts)

浏览器验收创建八页共用背景的画廊，实际点击热点改变第一页的颜色和点击区域，再返回另一页检查原色与命中。源码和字节码通过两种 WASM 后端分别运行。另有三组脚本交给原版 Windows SDK 和 Web，比较主图、遮罩、区域像素、裁剪及修改标记。[画廊验收](../../tests/browser/shared-layer-images.spec.ts) · [原版共用场景](../../tests/helpers/layer-image-sharing.ts)

## 剧本引用与书签

原版 KAG 会把宏参数中的 TJS 值传给标签。游戏可以把同一个角色对象以及绑定到该角色的方法交给两个标签。以前，Web 在这一步会把对象展开成普通数据，可能丢失身份或在执行标签前报错。本批把实际引用保存在当前 TJS 调用中，嵌套解析和路由回调各自恢复相应的值。内存中的书签按原版浅复制参数字典。写入文件并重新启动的书签另以可序列化的字典和字节串验收。原版解析器增加了八个观察场景，包括嵌套宏、脚本异常和缺少参数字段的旧书签。[宏参数实现](../../src/engine/tvp/kag.ts) · [原 KAG 游戏点击场景](../../tests/browser/kag-reference-values.spec.ts)

## 音乐循环接缝

游戏可以在 SLI 文件中给循环跳转设置 `Smooth`。原版在跳转前把目标片段的占比提高到一半，跳转后再从一半提高到全量。如果目标附近还有另一个跳转点，后一段会在该点截短，前后两段的长度可以不同。此前普通 Wave 播放按整段长度计算一次比例，容易在短循环中把两段声音混到错误的位置。本批将普通平滑循环接入与滤镜共用的分段读取路径。WAVE 原始位深随资源传至混音器。8、16 和 24 位整数 PCM 可从已解码样本还原，32 位整数及 64 位浮点资源仍受内部 Float32 精度限制。[原版循环代码](../../third_party/phase-vocoder/original/WaveLoopManager.cpp) · [混音实现](../../src/engine/media/wave-crossfade.ts)

## 已取回的托管结果

第 131 批最终为失败。完整常规浏览器报告有 3,140 项通过、65 项失败和 2 项跳过。原版介绍游戏的六种浏览器与后端组合中五种走完全部路线，Firefox Asyncify 在完成读档和四页剧情后等待返回菜单时超时。新取回的 WebKit 第三分片还记录了两项位图断言失败。该批列出的原始报告均已归档。[131 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45755797755)

第 132 批取回时仍在运行。Node 已报告全部 4,036 项，其中 4,023 项通过、11 项失败、2 项因超时取消。原版有损 ERI 对照 15/15 匹配，KAG 解析器 57/57、跨引擎书签比较 116/116。声音对照在 Wine 上完成 40/40，Windows 上完成 37/40，另三项报告没有声音驱动。原版十进制数值的 Web 比较仍只有 6/18 匹配。第 133 批的两个提交和第 134 批在这次取回时均在排队。[132 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45757288264) · [133 首版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759125623) · [133 最终版](https://github.com/fenghengzhi/krkr2-web/actions/runs/45759226490) · [134 托管运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45761489263)

本批新增 20 个 Node 用例，每个常规浏览器项目新增 12 个用例。Windows SDK 图层组增至 60 个场景，KAG 解析器组增至 69 个场景。Node 托管作业也会使用固定原版 C++ 混音函数逐采样校验 16 位 PCM，并将比较数据随作业归档。会话协议为 48，以传递音频源的 PCM 格式。已列出的历史产物共 92 份，均已按大小和 SHA-256 核验。本批新行为等待 GitHub 托管运行，下一批集中取回结果。

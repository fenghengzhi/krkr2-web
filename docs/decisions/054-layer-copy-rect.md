# 054：copyRect 的 mask 复制和空写入

本阶段基于 053 的 `40cedd4`，修正 `copyRect` 的 opaque mask 复制，以及 `copyRect`／`fillRect`／main、mask 单像素写入的空区域和主图检查顺序。代码和回归用例已编写，尚未通过本阶段 GitHub Actions 验证。没有本地测试、构建、类型检查、浏览器或执行探针；没有运行历史 allocation reproduction。

## 固定原版依据

参考官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 中 `kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/`，与此前原始归档交叉阅读。

- [LayerIntf.cpp CopyRect，3900行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3900)：先按目标 Layer 的 ClipRect 裁剪；空请求直接返回。随后才按 drawFace 检查所需主图。`dfOpaque` 在 holdAlpha=true 时复制 MAIN，false 时复制 MAIN＋MASK；`dfAlpha`／`dfAddAlpha` 复制 MAIN＋MASK，`dfMask` 只复制 MASK。
- [LayerBitmapIntf.cpp CopyRect，802行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerBitmapIntf.cpp#L802)：检查主图后，底层还会裁剪源和目标的物理边界。这里变为空时返回false，Layer保留原imageModified。源图的绘图clip不参与源边界裁剪。
- [FillRect，3654行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3654)：同样先裁目标，再按face读取所需图像。
- [SetMainPixel／SetMaskPixel，2467行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2467)：顺序不同，先检查主图，再判断是否位于clip。无主图时，即使坐标位于空clip外也必须抛错。
- [DeallocateImage，2040行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2040)：删除main／province，不清ClipRect。type变为binder／effect／filter也经过该路径；再次AllocateImage才重置clip。

底层bool表示经过裁剪后是否执行有效写入路径，不是比较前后像素。同值fill、同值setPixel、同图同位置copy仍可置imageModified=true。其后Update通知与imageModified也是两个不同观察量：CopyRect通过目标clip后，即使底层再因源越界返回false，仍请求目标区域更新。

## 实现

`src/engine/graphics/bitmap.ts` 的copy显式接收holdAlpha。只有dfOpaque且holdAlpha=true时跳过mask，其他main复制分支保持原始RGBA字节；dfMask路径仍只写mask。main／mask复制在物理源裁剪为空时提前返回false，不做整图临时复制或touch。setPixel和fill也返回是否进入有效几何写入。

`src/engine/scene/layers.ts` 在释放bitmap时仅保存 `clipBeforeRelease` 的四个数值；不保留像素、Bitmap或TJS强引用。主图存在时总读取其当前clip，无主图时用保留值进行copyRect／fillRect目标预检查。重复释放不覆盖此前clip，重新创建后使用新图clip。失效清理的直接图像释放也记录该矩形，沿用既有对象清理顺序。

LayerTree分别处理“请求了目标区域更新”和“实际写入main／mask”的返回值；没有把底层false赋回imageModified，因此原true不会被空请求清除。单像素main／mask的clip外写入保持标志，但仍先要求主图。`src/engine/session.ts` 仅在该方法按原版需要Update时标记帧为脏，不用imageModified代替更新通知。

例子：

```tjs
src.setMaskPixel(0,0,128); dst.setMaskPixel(0,0,17);
dst.face=dfOpaque; dst.holdAlpha=false;
dst.copyRect(0,0,src,0,0,1,1);
// dst.getMaskPixel(0,0) == 128

dst.setClip(0,0,0,0); dst.hasImage=false; dst.imageModified=false;
dst.copyRect(0,0,src,0,0,1,1); // 空目标，在读取主图前返回
dst.fillRect(0,0,1,1,0xff000000); // 同样早退
// dst.imageModified仍false，hasImage仍false
// dst.setMainPixel(0,0,0)以及piledCopy仍须报告无主图错误。
```

## 验收与未完成范围

新增 `tests/integration/layer-copy-rect.test.ts`，共 **15组×源码／字节码＝30项**，用非均匀RGB／alpha样本覆盖holdAlpha两值、各main／mask drawFace、重叠自复制、目标clip与源物理边界、源drawing clip不参与、同值有效写入、空请求保留imageModified及无主图异常先后。重复释放、转binder、assignImages源无主图的间接释放，以及重新分配再释放分别检查裁剪保留；`piledCopy`作为反向对照，继续保持049要求的主图先行规则。停止后检查句柄与所有权归零。

原 `tests/conformance/graphics.test.ts` 的main-only低层复制用例显式传holdAlpha=true，保留它原来检查“仅main复制保留mask”的目的。其余既有像素断言不放宽。

源码调用点审查：产品中Bitmap.copy仅由LayerTree.copy调用，并显式传目标holdAlpha；另外两处低层调用都在graphics.test.ts，face0默认行为不变，face1现明确传true。其他 `.copy()` 属于Buffer或声音测试辅助对象，不是Bitmap。LayerState仅由LayerTree.create构造；src／tests未发现手造该类型的字面量。两个直接 `layer.bitmap=undefined` 位置（LayerTree.hasImage和Session的失效释放）都保存旧clip，assignImages源无主图走前者。

**Province不套用统一的空写入规则。** 原版copyRect的缺source province分支在通过目标clip后无条件设置imageModified，即使没有可写plane；分配province也先置true，且原版缺源时Fill使用裁后的源矩形坐标。本阶段只让目标clip为空的请求提前返回，保留既有非空province路径；不宣称已对齐独立province、缺源清零坐标、分配与全部province标记语义。无主图上的非空province操作仍属于后续独立province切片。

colorRect、drawText、assignImages、转场、System、模态pump、native ABI均未修改。原版方法参数数量／对象身份／超范围算术的全面对齐也不由本阶段的像素修复代替。

## 首次 Actions 回归

[完整回归 34947500803](https://github.com/fenghengzhi/krkr2-web/actions/runs/34947500803)，提交 `a76af99`：Node **1,367／1,367** 通过，包含本阶段 30 项及前阶段 clip 20 项；浏览器 **1,040／1,041** 通过，直接运行时 **6／6** 通过。三浏览器常规套件各 306 项全通过，WebKit 游戏库／PWA 也分别 19／19 通过。唯一失败为 Firefox 的既有离线缓存修复用例，尚不能把整轮计为通过。

该用例删除缓存、点击再次准备后，立即接受了上次的 ready／enabled 状态；随后关闭服务器，重载得到应用自定义的“离线缓存不完整”503 页面，再等待游戏启动按钮耗尽 30 秒。trace 显示游戏库仍在恢复，按钮点击前后页面布局发生变化；没有证明本次点击处理器收到操作或 REPAIR 实际执行。产品 PWA 源码不在本次 copyRect 变更内，不能把这一失败归因于像素复制。

夹具修订先等待已保存游戏行恢复，再真实点击一次；只观察并原样转发 ServiceWorker.postMessage，要求本次 REPAIR 已发送后才接受完成状态。删除前后的缓存、重建的完整标记、全部资源 URL／状态／字节长度作为附件保留；随后仍关闭服务器、离线重载并启动原保存游戏。没有强制点击、重复点击或直接调用准备函数，也没有移除原离线启动断言。此修订尚待新 Actions，原失败完整产物和单独的 Firefox/PWA trace 分析继续保留。

# piledCopy 空目标区域与回调顺序

状态：已实现，等待 GitHub Actions 验证；本地未运行测试、构建或执行探针。

`Layer.piledCopy` 先检查目标与源的主图像，再按调用开始时的目标绘图裁剪框裁剪目标矩形。宽高为空、负值，或请求完全落在目标裁剪框外时直接返回，不调用源或子层的 `onPaint`，不清除待绘制标志，也不设置目标 `imageModified`。主图像缺失仍先报错，回调不能修复这个无效请求。

这个前置检查只使用目标绘图裁剪框。源的绘图裁剪框不限制读取；源图像范围在完成回调后裁剪，因为 `onPaint` 可以扩展源图像。部分目标重叠会同步平移源矩形原点，保持像素对应关系。

原生代码在 `Complete` 前把目标坐标与裁剪后的源矩形保存为局部值；回调之后调用 `MainImage->CopyRect`，不再应用 Layer 的绘图裁剪框。本实现保存同样的请求，在回调后读取当前目标图像、按其物理边界复制。回调缩小、扩大或清空目标绘图裁剪框不会改变已经确定的请求；图像被缩小后仍按新图像边界保证访问有效。没有任何源像素落入有效目标时，不设置 `imageModified`。

`Bitmap.copyPixels` 接受显式裁剪区域，缺省仍使用当前绘图裁剪框，并返回是否实际复制了像素。这样无需在回调返回后临时修改用户可见的 clip 属性。原生失效或图像删除导致当前图像不存在时，仍通过现有检查报错，不访问已释放的资源。

新增 `tests/integration/piled-copy-empty-region.test.ts` 覆盖源码与原生字节码：空尺寸和四边界外请求、空目标裁剪框和子层回调、部分重叠的源坐标、忽略源绘图 clip、回调修改目标 clip/图像尺寸、源越界和回调扩图，以及缺少主图像先于空区域返回的错误次序。断言记录在 `piledCopy` 内完成的脚本语句之后，区别于脚本返回后普通绘制流程可以继续消费的待绘制事件。

原生依据：krkr2 2.32stable [ClipDestPointAndSrcRect](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3553) 与 [PiledCopy](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3858)。原生 `CopyRect` 的物理图像裁剪与 Layer 绘图裁剪属于不同步骤；此实现保留该顺序，不把源图像当前范围提前当作空操作判定。

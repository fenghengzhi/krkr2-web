# piledCopy 空目标区域与回调顺序

状态：已实现，并随组合版本 `f1f6a3d` 通过[完整回归 34931803098](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931803098)。14 个作业全部成功，**1,118 项 Node、846 项浏览器和 6 组直接运行时**通过，所选测试零失败、取消、跳过、flaky 或重试。本地未运行测试、构建或执行探针。

[兼容检查 34931188627](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931188627) 在 `54ecd16` 使用构建 `34931093453` 的精确产物通过 **78 项**，三浏览器各 26 项。至 `f1f6a3d` 应用源码与构建配置未改变，后续仅调整测试和记录；该兼容结果对应原构建，不是最终构建的重跑。

`Layer.piledCopy` 先检查目标与源的主图像，再按调用开始时的目标绘图裁剪框裁剪目标矩形。宽高为空、负值，或请求完全落在目标裁剪框外时直接返回，不调用源或子层的 `onPaint`，不清除待绘制标志，也不设置目标 `imageModified`。主图像缺失仍先报错，回调不能修复这个无效请求。

这个前置检查只使用目标绘图裁剪框。源的绘图裁剪框不限制读取；源图像范围在完成回调后裁剪，因为 `onPaint` 可以扩展源图像。部分目标重叠会同步平移源矩形原点，保持像素对应关系。

原生代码在 `Complete` 前把目标坐标与裁剪后的源矩形保存为局部值；回调之后调用 `MainImage->CopyRect`，不再应用 Layer 的绘图裁剪框。本实现保存同样的请求，在回调后读取当前目标图像、按其物理边界复制。回调缩小、扩大或清空目标绘图裁剪框不会改变已经确定的请求；图像被缩小后仍按新图像边界保证访问有效。没有任何源像素落入有效目标时，不设置 `imageModified`。

`Bitmap.copyPixels` 接受显式裁剪区域，缺省仍使用当前绘图裁剪框，并返回是否实际复制了像素。这样无需在回调返回后临时修改用户可见的 clip 属性。原生失效或图像删除导致当前图像不存在时，仍通过现有检查报错，不访问已释放的资源。

新增 `tests/integration/piled-copy-empty-region.test.ts` 覆盖源码与原生字节码：空尺寸和四边界外请求、空目标裁剪框和子层回调、部分重叠的源坐标、忽略源绘图 clip、回调修改目标 clip/图像尺寸、源越界和回调扩图，以及缺少主图像先于空区域返回的错误次序。断言记录在 `piledCopy` 内完成的脚本语句之后，区别于脚本返回后普通绘制流程可以继续消费的待绘制事件。

原生依据：krkr2 2.32stable [ClipDestPointAndSrcRect](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3553) 与 [PiledCopy](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3858)。原生 `CopyRect` 的物理图像裁剪与 Layer 绘图裁剪属于不同步骤；此实现保留该顺序，不把源图像当前范围提前当作空操作判定。

[Node 诊断 34930516583](https://github.com/fenghengzhi/krkr2-web/actions/runs/34930516583) 在 `f48429c` 通过全部 1,087 项，无失败、取消或跳过。后续增加两组浏览器模板，覆盖源码／字节码和双后端，三浏览器共 24 项。

[首次完整回归 34931093453](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931093453) 的 Node 子进程在 `layer-redraw.test.ts` 触发 V8 内部断言 `jit_page_->allocations_.erase(addr)==1` 并以 SIGTRAP 退出。已报告 1,068 项通过、1 个文件失败；该文件余下 19 项没有结果，不能计为通过。与前次 Node 诊断相比，仅增加浏览器测试，Node／应用／原生源码和 Node v24.19.0 相同。保存了 core 哈希和原生回溯；其中 libc 符号存在版本不匹配警告，根因尚未确定。

该轮最终浏览器结果为 **842/846 通过、4 项失败**，6 组直接运行时通过。Chromium 的一个新测试错误假定控制台动作之间已有普通帧消费 onPaint，读取到的状态仍为 pending；WebKit 另有暂停视频时间漂移约 1.228 ms、player 重启失败和 Scripts JSPI 初始化 SyntaxError 三项失败。该轮终态为失败，不能仅按先完成的作业或已报告的 Node 个案宣称通过。完整归档保留全部失败，V8 断言及这些 WebKit 失败的根因没有因后续绿色回归而被证明修复。

复制夹具的四项同脚本顺序证明均通过。正对照现显式恢复有效目标 clip，保留原有回调计数和 pending 请求，写入已知源像素再执行非空 piledCopy；精确断言总回调次数为 1、pending 清除及复制的 RGB/mask。这样不依赖控制台操作之间是否已经呈现普通帧，也不通过重置计数或重新请求绘制掩盖原请求丢失。

修订期间，[050 首次完整回归 34931476851](https://github.com/fenghengzhi/krkr2-web/actions/runs/34931476851) 在 `65c7e16` 仍有旧复制正对照失败：Asyncify／字节码预期 `1,0`，实际 `0,1`，浏览器 **845/846 通过**。它也保持失败记录。包含有效复制正对照的 `f1f6a3d` 才取得本文开头的完整通过；产品的裁剪与 onPaint 顺序没有为迁就这些夹具而改写。

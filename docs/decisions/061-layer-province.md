# 061：独立 Province 平面与图像独占入口

首次组合回归 [35009948147](https://github.com/fenghengzhi/krkr2-web/actions/runs/35009948147) 在 `a88f3fdccd773aafa5d96a9ae8eb565458102f43` 实际为 Node **2,010/2,010**、浏览器 **1,385/1,401**、直接运行时 **6/6**，整轮失败。新增省图浏览器案例 **24/24** 通过；16 个失败均在同组合的 Clipboard 测试，涉及 Chromium 的空文本／权限预期和 WebKit 自动化的读取授权，详见 [060](060-web-clipboard.md)。同源构建的 [78 项兼容检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/35010819208) 全部通过，但不替代失败的完整回归。

过时的第二轮 [35012318277](https://github.com/fenghengzhi/krkr2-web/actions/runs/35012318277) 被取消：取消请求检查时仍在排队，实际 runner 已开始并在 setup-node 阶段中止，存在六个作业，普通测试执行数为 **0**。首轮失败、取消时序和所有原件均保留。

第三轮 [35014242871](https://github.com/fenghengzhi/krkr2-web/actions/runs/35014242871) 在 `70476b9e24e05d486cb5a15c505276bba3657f6c` 实际为 Node **2,010/2,010**、浏览器 **1,400/1,401**、直接运行时 **6/6**；Clipboard 三浏览器 **51/51** 通过，整轮仍失败。唯一失败是 WebKit JSPI 的 TLG6 写出 Stop 场景，等待 `encode-start` 12 秒超时。原 trace 在导入后约 221 ms 记录 `WebGL: context lost.`；末次快照已有 VM 和 Window，页面为“等待画面恢复”，但尚无编码标记，Stop 观察事件为空。因此本次未进入该例的 Stop 触发阶段，不能据此认定编码取消失效，也没有证据确定图形上下文丢失的根因。三个 WebKit 原生诊断清单均为空；不把清单为空视作没有引擎故障的证明。所有实际用例无跳过、重试或未报告。

后续与 062／063 的整合回归独立验收；其结果不会覆盖本轮失败。上述 78 项兼容检查使用首轮构建，与第三轮应用源码相同，但不是第三轮的同一构建产物。

Layer 可以在 `hasImage=false` 时保存和访问 Province。此前 Province 数组附着在 RGBA Bitmap 上，读写、命中和复制都会错误地要求 MainImage；图像尺寸也无法表示“无主图后改变 Layer 大小，旧省图尺寸保持不变”的状态。

本片把 Province 交给 Layer 单独持有，保留其自身宽高及 8 位像素；`Bitmap` 只负责 Main/Mask。已有主图的绘制、转场与合成继续使用原 Bitmap 对象；省图不会成为可见 RGBA 图像。原生实现会共享图像，本项目目前仍使用独占深复制，见下文边界。

## 固定依据

参考官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 中 `kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/`：

- [LayerIntf.cpp 图像分配与赋值](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2001)：省图独立分配；删除 MainImage 时仍同时删除 Province；AllocateImage 和 ChangeImageSize 调整已有省图。
- [Province 像素入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2510)：读取无省图或越界返回零；写入先分配，然后检查 Layer clip，再检查实际省图边界。
- [FillRect](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3654)、[CopyRect](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3899) 与 [HitTest](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2747)：省图分支不以主图存在为前提。
- [independ 入口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7071) 与 [底层独占检查](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerBitmapImpl.cpp#L1903)：两种 copy 参数都先判断图像是否已经独占。

原始文件 SHA-256：

| 文件                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| LayerIntf.cpp             | `05a8279842f1e4a057c7b9005437fbc85579524307864509e47429228f59240b` |
| LayerIntf.h               | `dd4e07bf42e58052d0cfccad8ac579dd56190834902b3d7d89e94e066a6efd0e` |
| win32/LayerBitmapImpl.cpp | `d286842fc363a3d8678d4600ae20ec545c04b644ff73b10d870abd9ae2bad6a2` |
| LayerBitmapIntf.cpp       | `c08bfb10aef9c7d9939a63eb6a7c636e661164c55c2c0c8ed46cfba26b4b71b4` |

## 操作与生命周期

`ProvincePlane` 持有宽高和独占 Uint8Array，不持有 clip 或 TJS 对象。绘图 clip 仍由 Layer 当前 Bitmap 或释放主图时复制的 `clipBeforeRelease` 决定。没有主图时可读 clip 属性；修改或重置 clip 仍要求主图。

省图不存在时按主图尺寸分配；没有主图则按 Layer 当前大小分配。之后修改没有主图的 Layer 大小不调整已有省图。重新分配主图时，已有省图保留左上交集，扩展区域填零。`hasImage` 只报告主图；即使原本没有主图，再次写 `hasImage=false` 也会删除新建省图。进入 Binder/Effect/Filter 会释放两个平面；赋相同 type 是原有的空操作。

`setProvincePixel` 在 clip 检查前分配，颜色截取低字节。首次写到 clip 外可能分配和标记 `imageModified`，但没有像素更新请求；已有省图的 clip 外写入不改变标志。读取越界为零；写入若位于保留的 clip 内、却超出当前省图实际尺寸，则报错。

像素读取/写入、填充、着色、复制及图像加载先检查原生要求的最少参数数目，缺参不会落入宿主分配路径；显式 void 仍是已提供的参数。colorRect 的 void opacity 使用 255，loadImages 的 void key 使用 clNone。点、矩形和颜色参数在转成 Number 前保留低 32 位，避免大 TJS 整数丢失低位。

`dfProvince` 的 fill/color/copy 不要求 MainImage。fill/color 先裁剪；零色不分配省图，精确覆盖整个省图的清零释放其字节，局部清零保留分配。`colorRect` 的 opacity 对省图无效。复制按两个省图各自的尺寸处理，自身重叠只暂存实际传输区域。

原版缺省图来源的 `copyRect` 有特殊行为：目标 clip 预检通过后，不分配目标省图，并把已有目标省图的**裁剪调整后的源坐标矩形**填零，随后设置 `imageModified=true`。这里没有改成更直观的目标坐标，也没有以来源 MainImage 大小裁剪。普通空预检仍直接返回。

`assignImages` 分别处理两平面。不同的省图独占来源会先让目标失去主图，再复制省图尺寸及字节，保留目标 Layer 几何和 clip。来源没有主图的自身赋值会先删除自己的省图，后续来源读取也为空；有主图的自身赋值仍保留像素、重置 clip、标记 modified，且不增加原本没有的主图更新请求。flip 仍先要求 MainImage，忽略绘图 face/clip，一起翻转完整 MainImage 和 Province。

`htProvince` 使用省图实际范围和 `imageLeft/imageTop` 偏移，非零值命中，不依赖主图 mask 或 hitThreshold。外层可见、Layer 显示范围、层级、enabled 与输入回调的既有规则继续适用。

现有 Layer 原生失效顺序保留：省图在 manager/tree detach 时仍存活，到 `Layer.releaseImage` 才与主图一起释放。销毁、Window/Session 清理和最终 tree.clear 都移除持有字节；没有增加 TJS 强引用。

## 异步加载与预算

显式 `loadProvinceImage` 仍先要求 MainImage，并在等待解码前分配或保留已有省图、标记 modified。原版失败会删除省图；现在缺文件、错误像素格式或尺寸失败也删除仍匹配此次加载的省图，保留主图和 clip。

Web 解码可以挂起，原版的同步调用没有同一种迟到结果。每次加载捕获 LayerState、LayerRecord、MainImage 身份与尺寸及省图写入代次。新的省图写入、图像替换、释放或下一次加载使旧票据失效。成功结果只发布到匹配目标；失败清理同样只删除匹配目标，避免旧失败清掉新数据。完成前检查原生 Layer finished；closing 本身不能拒绝加载，因为 Font.finalize 等清理回调此时仍能合法使用尚未 releaseImage 的图像。Stop 通过可取消等待立即退出；底层解码稍后成功或失败都已被接住，不再发布。这是异步 Web 边界下的身份保护，不宣称原版有同样的并发状态。

`loadImages` 的主图、mask 和 matte 成功，而后续 `_p` 解码或格式/尺寸检查失败时，ImageLoader 返回携带已准备主图和原错误的明确失败类型。Layer 入口只对仍有效的目标发布该主图、清除省图、重置 clip 并保留 imageModified，然后重新抛原来的省图错误。原版失败分支不会执行末尾 Update；因此仅在新主图迫使 Layer 显示宽高变化时新增呈现请求，同尺寸失败不新增 dirty。失败的读取或解码不进入成功缓存；已经成功解码、仅不能作为本次省图的原始图像仍可保留在 ImageCache，已成功主图缓存也保持原规则。旧票据另外检查 MainImage 像素 revision，所以新的主图写入、省图写入、替换、失效或 Stop 都不能被迟到的部分结果覆盖。若发布部分图本身超过 Layer 位图预算，则保留原图并抛预算错误，不谎称部分发布已经完成。

LayerTree 的 64 MiB 持久位图预算计入所有 Layer 的 RGBA 字节和独立省图字节，包括没有主图的省图。新建、赋值、读入、主图扩展与重新启用主图都先计算两个平面的总差额；必要的替换先准备好，再发布。拒绝预算时保留旧平面、尺寸和 type。全清省图、释放图像和销毁及时归还持有额度。该数值不包括解码、自拷贝和 resize 的临时缓冲峰值，也不合并独立的 ImageCache/SceneComposer 预算。

## independ 的范围

`independMainImage(copy=void)` 和 `independProvinceImage(copy=void)` 默认或显式 void 使用 true，其他值先执行 TJS bool 转换，返回 void。宿主验证活 Layer 后保留独占字节；不分配缺失图像，不重置 clip、修改 modified 或触发绘制。false 不是强制清空图像，因为原版 `IndependNoCopy` 对已独占图像同样直接返回。

这不补做共享存储。原版 `Assign` 和整图 `CopyRect` 可能共享缓冲，[8 bpp SetPoint](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerBitmapIntf.cpp#L308) 还存在直接写共享省图的路径。Web 的深复制避免跨 Layer 共享，不能称为这些原生共享行为的逐像素等价。

原生扫描线地址、Windows 分配器和不确定的共享 `copy=false` 新缓冲内容不属于此片的等价声明。`loadImages` 主图本身失败或 mask/matte 阶段失败的既有细节也没有扩大成完整原生加载器重写。

## 验证状态

新增 95 项 Node 用例定义：独立平面 12 项、联合预算 2 项、ImageLoader 部分失败 11 项，以及 70 项 source/bytecode 的省图操作、生命周期和加载用例。真实 Worker 浏览器输入及独占方法有 8 项定义，交由既有三浏览器矩阵发现，实际执行/跳过数量以 Actions 为准。迁移原先直接访问 Bitmap.province 的测试时保留原像素期望，并把加载失败测试改为固定原版的清省图和部分主图行为。

本片首次组合验证及后续状态见文首；尚未完成新一轮完整回归的验收。所有测试和可执行检查只在 GitHub-hosted Actions 执行。未启动的、失败的或中断的运行不能记作通过；已有验证证据保持不变。

# 053：Layer 绘图裁剪的参数与分配重置

本阶段仅实现 `Layer.setClip` 和图像分配路径的裁剪语义。代码基于 051 的 `2593a71`；尚未通过本阶段 GitHub Actions 验证，不能计入已验证范围。所有执行验证由 GitHub-hosted runner 完成，本地只读源码、编辑和格式化。

## 原版依据

参考固定官方 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 `kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp`，不是 Kirikiroid 扩展。既有原始文件归档在 main 的 `out/verification/window-layer-ownership/reference/LayerIntf.cpp`，来源记录为同目录上一层 `audit.md`。

- [setClip 注册，7093行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L7093)：零参数调用 ResetClip，1—3参数返回数量错误，至少4参数只读取前4个；坐标与尺寸转换为 `tjs_int`。
- [ResetClip／SetClip，3508—3551行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L3508)：无主图拒绝；ResetClip使用整个主图尺寸。SetClip先限制左／上为非负，右／下裁至图像边界，再把反向边界收敛至对应起点；负尺寸得到空区域。正起点超出图像时仍保留该起点，不能统一变成原点空矩形。四个clip属性复用同一个SetClip。
- [AllocateImage，2017行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2017)：仅无主图才分配并填充；已有主图也ResetClip，保留原像素与图像位置。
- [SetHasImage，2152行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L2152)：true调用AllocateImage。
- [SetType，1417行](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp#L1417)：仅真正改变类型才进入分配／释放路径。同值写入不重置裁剪、neutralColor或imageModified。

## 具体变化

`src/engine/tvp/layer.ts` 的setClip使用可变参数，保留零参数分支，数量不足时在转换参数和调用宿主前抛错，多余参数不用于裁剪。`src/engine/session.ts` 的Layer.clip分别进入resetClip或setClip，clip参数和clip属性在BigInt转Number前按原版保留有符号低32位，因此超过Number精确范围的TJS整数也不丢失低位。

`src/engine/graphics/bitmap.ts` 继续拒绝非安全整数内部坐标，允许负宽／高经过现有边界相交逻辑收敛为空区域。改变裁剪不会改写main／mask／province，也不会单独标记imageModified。

`src/engine/scene/layers.ts` 在hasImage=true路径统一重置裁剪；已有bitmap继续复用，原像素、province、imageLeft／imageTop保持。真正type变化已使用该分配路径，因此同时获得正确重置；同type的已有提前返回保持不变。neutralColor的类型默认值／实例覆盖规则保留046实现。

例子：

```tjs
layer.setImageSize(4,3);
layer.setClip(1,1,1,1);
layer.setClip();              // 整个4×3主图
layer.setClip(2,1,-1,1);      // (2,1,0,1)，合法空区域
layer.hasImage=true;          // 整个4×3，保留原图和province
layer.setClip(1,1,1,1);
layer.type=layer.type;        // 保留(1,1,1,1)
layer.type=ltAddAlpha;        // 真正类型改变时重置为4×3
```

## 验收与当前状态

新增 `tests/integration/layer-clip.test.ts` 共 **10组×源码／字节码＝20项**：零参数与空clip后的恢复、1—3参数失败且旧状态不变、多余参数、负尺寸和图像外起点、clip属性、数值转换、真type变化、同type、已有主图hasImage=true及无主图拒绝。使用已知main／mask／province样本和独立的图像／显示尺寸，断言复用原图、坐标和neutralColor，而非只检查“不抛错”。停止后检查宿主句柄与所有权清理。

既有 `tests/integration/image-writing.test.ts` 的准备顺序调整为先改变type再设置clip；其保存后clip不变的断言保持。旧准备顺序依赖“改变type保留clip”的错误行为，无法继续表达保存函数自身的合同。

尚未执行本阶段测试、类型检查或构建；没有通过计数或绿色结论。原版C++有符号坐标加法溢出不作为定义良好的裁剪合同，本阶段不据此增加溢出行为断言。

copyRect的mask／空操作、assignImages、独立province、文字混合、转场时序和其他剩余API都不在本阶段；输入、模态、窗口surface与VM重入没有改动。

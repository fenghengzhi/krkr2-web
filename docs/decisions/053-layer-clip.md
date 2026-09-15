# 053：Layer 绘图裁剪的参数与分配重置

本阶段仅实现 `Layer.setClip` 和图像分配路径的裁剪语义。当前提交 `40cedd4` 包含 051 的 `3ef7f09`；Node 和兼容检查通过，但完整回归有一项 WebKit 启动失败，尚未合入已验证主分支。所有执行验证由 GitHub-hosted runner 完成，本地只读源码、编辑和格式化。

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

原版C++有符号坐标加法溢出不作为定义良好的裁剪合同，本阶段不据此增加溢出行为断言。

copyRect的mask／空操作、assignImages、独立province、文字混合、转场时序和其他剩余API都不在本阶段；输入、模态、窗口surface与VM重入没有改动。

## Actions 记录

[Node 诊断 34945488350](https://github.com/fenghengzhi/krkr2-web/actions/runs/34945488350)在 `40cedd4` 完成类型检查和构建，实际 **1,337／1,337** 通过，包含本阶段 20 项。无失败、取消、跳过或未报告的 Node 案例；浏览器、直接运行时及可信生命周期未运行，不能计完整回归通过。

[首次完整回归 34946407444](https://github.com/fenghengzhi/krkr2-web/actions/runs/34946407444)使用同一提交：Node **1,337／1,337**、直接运行时 **6／6** 通过；浏览器 **1,040／1,041** 通过，零跳过或 flaky。14 个作业中 12 成功，WebKit 常规套件及汇总作业失败。唯一失败为原有 `layer-neutral-color.spec.ts` 的 JSPI／源码场景，在 launch 等待 evaluate 按钮可用时失败，未进入 neutralColor 像素断言。该 expect 配置 12 秒却约 219ms 后提前结束，整个案例约 1,246ms；不能描述为等满超时。完整错误、trace 和作业日志没有直接记录原始协议异常类型；结合该版本 Playwright 源码，仅能推断与内部协议会话关闭分支一致，不能认定原生崩溃、OOM 或历史故障同因。

[兼容检查 34947049788](https://github.com/fenghengzhi/krkr2-web/actions/runs/34947049788)使用 `40cedd4` 和精确构建 `34946407444`，实际原矩阵 **78／78** 通过，三浏览器各 26 项。KAG 流程／存档／转场 36、调试面板 6、异常恢复 6、ABI 迁移 30 项均执行。三轮完整产物、run.json 和逐项 evidence-summary 分别归档；首次完整回归另保存 failure-details 与版本匹配的只读源码分析，失败状态继续保留。

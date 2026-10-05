# 087 窗口形状遮罩与构建修订

状态：开发候选，本批尚未取得执行结果。整体目标继续是完成插件以外的 KRKR2 Web 模拟器；功能实现、原生行为差分和回归验收均未全部完成。会话协议 **32**，TJS ABI **5**、字体 ABI **2** 不变。所有可执行验证只在 GitHub-hosted Actions 运行，整批推送，下次工作时回收结果，不实时监控。

## Window.setMaskRegion / removeMaskRegion

原生依据是固定 KRKR2 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788` 的 [LayerImpl.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/LayerImpl.cpp)、[WindowIntf.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/WindowIntf.cpp)、[WindowImpl.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowImpl.cpp) 和 [WindowFormUnit.cpp](https://raw.githubusercontent.com/krkrz/krkr2/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/WindowFormUnit.cpp)。本轮读取缓存的固定源码，不冒称执行原版 VCL 引擎。

`setMaskRegion` 对主 Layer 的完整 MainImage 取快照，保留 alpha 大于等于阈值的像素。未提供或显式 `void` 使用 1；TJS 先转整数，再按 uint32 解释，负数也不裁到 0…255。图像偏移、绘图 clip、Layer 显示尺寸、opacity、子层、Window zoom 不参与。没有主 Layer 或可绘制图像时抛错。空图／没有符合条件的像素得到空 region；`removeMaskRegion` 去除限制，二者保持区别。

横向连续像素转为半开矩形，相同横段跨相邻行合并。先同步取得 alpha 快照，再分行让出执行并检查取消和 Window 身份；后续 bitmap 修改不会改变已保存的形状。每 region 最多 **65,536 个矩形／512 KiB**，Session 保存的矩形数据最多 **8 MiB**，临时 alpha 最多 **16 MiB**；临时数组、副本、SVG 字符串和 DOM 另计，8 MiB 不是总 heap 上限。准备、预算或发布失败保留旧区域；失败与取消不发送部分形状。

区域通过专门 `window-region` 事件传递，包含 Window ID、单调 revision 和自有 Uint16Array；每四个数为 x、y、width、height。WindowView 只携带小型 revision 标记，常规帧和 roster 不重复复制所有矩形。Window 退休、Stop 和取消清理保存区域与待完成请求。Player 另保存有界副本，区域先于 canvas 到达也可在 attach 时应用，替换 surface 时重放；退休和停止拒绝迟到事件。

Web host 用一个 SVG clipPath／path 裁剪整个外框，包括标题和菜单；原点是整个 Window 的左上角，不平移到 canvas 客户区。普通鼠标命中由 clip-path 的几何范围处理，因此孔洞可穿透到后面的窗口。此行为依据 [W3C SVG 指针命中规范](https://www.w3.org/TR/SVG/interact.html)；没有给脚本投递和键盘模拟鼠标增加原生没有的统一形状过滤。

页面响应式缩放按 canvas 的实际 CSS 尺寸与逻辑 Window 尺寸投影，原点仍为外框原点；这属于 Web 容器适配。Window zoom、主图像后续绘制不重新生成区域。窗口缩放、标题尺寸和全屏留边不能据此称为与桌面系统像素完全一致。宿主只接受准确的 live surface epoch 和递增 revision，拒绝坏几何时保留旧 path；替换、detach 和 dispose 清理 SVG 定义。源码／字节码 Session 和真实浏览器验收随本批执行。

新增 **17 个 Node 定义**（纯区域算法／预算 7，真实 Session 5 场景 × 源码／字节码 10），以及**每浏览器 7 个定义**（真实 host 命中／生命周期 3，应用双后端 × 源码／字节码 4）。包括阈值、孔洞、外框标题原点、CSS 缩放、快照独立、复杂度拒绝、Window 退休及等待生成期间 Stop。所有定义均尚待托管执行，不计为通过。

## 085／086 固定结果

本批对 [085／37270916669](https://github.com/fenghengzhi/krkr2-web/actions/runs/37270916669) 和 [086／37273929294](https://github.com/fenghengzhi/krkr2-web/actions/runs/37273929294) 的 run、jobs、artifacts 分别只查询一次。两次均 **completed／failure**，各 **11 jobs：2 success、4 failure、5 skipped**。失败为 build、两套 Windows strict 和 All tests；Node、浏览器、KAG、直接 runtime 与 trusted 验收均 skipped。

固定清单共 **10/10 ZIP、40,544,098 字节**，每份大小和 API SHA-256 均匹配。085 的五份共 18,316,984 字节，其中补齐上批尚缺的 JSPI 产物；086 五份共 22,227,114 字节。各 run 的双后端 allocator 均 **60/60**，范围仅限独立分配诊断。旧快照、失败、跳过和未报告记录继续保留，完整摘要位于相应运行目录的 `087-final-summary.md`。

086 build 的 **5 条 TypeScript 诊断**包括 MP4 测试 `box` 默认参数将 Uint8Array 推断为过窄的 ArrayBuffer 所有权类型，以及 mask 比较器循环声明的隐式 any 推断。本批显式标注参数与循环字段类型。修订尚待托管构建确认；083 手柄、084 流式音频和后续应用候选不能因本次源码修改而追认为通过。

## 光标证据范围和后续诊断

086 两套 Windows 的 mask 比较各 **3,770/3,770 matched，0 failed**：原 1,100 观察及新增七种正方／混合尺寸的 2,670 观察均包含在严格比较内。该结果支持已采样尺寸的 AND 和单色双高 XOR plane 处理，不扩大为所有尺寸或光标整体通过。

同批主严格绘制比较各 **293/332 matched、39 mismatch（13 份 fixture）、1,858 uncompared**；085 为 270/332 matched、62 mismatch。portable raw 的 173/173 仍标为 partial。原 158 个颜色缩放候选没有全域零差异方案。

新增 geometry 的常量色原始 plane 提供进一步诊断：64×64 的 1,024 个像素保留源色，另六种尺寸只有首列与底行的 63 个像素保留，其余 961 个像素各 RGB 通道少 1；同尺寸的所有 AND 变化有相同 color hash。该观察提示需要测量“比例先按 binary32 舍入、坐标按 binary64 累加”的独立路径，尚不足以更换生产颜色核。

本批保留原 158 个候选及顺序，补齐该路径与既有轴算术的 X/Y 组合，净增 18 项为 **176 项**；增加七份已有常量源的独立 raw color plane 输入。原 95 份完整光标 fixture、严格 gate、所有不匹配与未比较范围保持。本地只解析历史原始产物，没有运行候选或生产代码对历史数据试算。

后续继续处理颜色量化、剩余 Window 接口（包括 `beginMove`）、输入与字体／几何行为差分、Vorbis 高效跳转、其他音频流式化、旧视频编码与长视频读取、存储边界及复杂 KAG／媒体恢复。整体目标保持 active，本批候选和有限正证据均不代表项目完成。

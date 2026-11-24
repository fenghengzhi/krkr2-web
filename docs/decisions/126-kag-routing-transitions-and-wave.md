# 126　剧情回调后的跳转、画面转场与声音坐标

## 剧情与书签

KAG 游戏可以在 `onJump` 或 `onCall` 回调里加载另一个剧本或跳到标签。此前 Web 解析器会把旧标签的结束位置写回新剧本，可能跳过对白开头，也可能保存错误的返回位置。现在跳转从回调留下的位置重新解析。调用子程序时，解析器先推进当前游标再保存返回点。六组新场景还检查回调拒绝跳转、修改标签对象和清空剧本后请求中断的行为。[原版 KAGParser](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp) · [剧情与预期输出](../../tests/helpers/kag-routing.ts)

第 125 批的一段验证脚本使用了原版 TJS 语法不接受的 `finally`。本批修正了脚本。Windows 作业还会先写进度记录，再用 `Scripts.execStorage` 加载单独保存并校验的场景脚本。报告区分已经返回的结果和未执行完的场景，并保留原生书签供 Web 读档。125 的原始书签报告在取回时尚未发布，因此上次 Windows 作业的具体失败位置仍待核实。[TJS 语法](../../third_party/tjs2/bison/tjs.y) · [Windows 书签验证](../../tests/probes/kag-sdk.ts)

## 画面转场

`Layer.beginTransition` 按原版顺序读取选项。它先检查转场是否已经启动、源层是否与目标层互相引用，以及指定的效果是否存在，然后各读取一次 `selfupdate` 和 `callback`。尺寸检查通过后，淡入淡出只读取 `time`，规则图转场再读取 `vague`、`rule`，滚动转场再读取 `from`、`stay`。带有 getter 的脚本可以观察到这个顺序。三个效果使用当前脚本设置的原版错误消息。若 getter 启动了新的转场，播放器保留已经启动的转场及其完成回调。[原版 Layer](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/LayerIntf.cpp) · [Windows 对照场景](../../tests/helpers/transition-options.ts) · [Session 对照](../../tests/helpers/session-transition-options.ts)

滚动转场先用经过的时间乘以图像宽度或高度，再除以总时长取整。100 像素宽、100 毫秒的转场在第 29 毫秒应移动 29 列。原先先算浮点进度会在这里少移一列。新增验收在四个方向逐通道比较实际提交的 100 × 100 画面，覆盖第 28、29、30 毫秒及两个端点。[原版转场实现](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/TransIntf.cpp) · [浏览器画布验收](../../tests/browser/scroll-phase.spec.ts)

## 声音与运行时

`WaveSoundBuffer.setPos(x,y,z)` 与 `posX`、`posY`、`posZ` 支持原版默认立体声模式下的脚本行为。坐标逐个转换为实数，再保存为单精度值。参数转换失败会保留原坐标。首次成功播放前，改变声像会按原版规则同步坐标。播放建立普通立体声缓冲后，设置坐标会保留声像，调整声像也会保留坐标。验收同时检查脚本属性和实际左右声道 PCM。可选 DirectSound3D 的空间声场渲染仍待实现。[原版声音接口](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp) · [脚本场景](../../tests/helpers/wave-position.ts) · [PCM 验收](../../tests/integration/wave-position.test.ts)

转场和声音的参数数量错误读取当前 VM 的 `TJSBadParamCount`。游戏可通过 `System.assignMessage` 自定义文案，包括原样显示的百分号。对应的 `nativeMessages` 能力版本升至 3，播放器在启动前检查加载的模块。[原生消息接口](../../native/tjs2/tvp-messages.cpp) · [能力与文案验收](../../tests/conformance/tvp-messages.test.ts)

## 已取回的托管证据

- 124 已终态失败，24 个作业成功、3 个失败、8 个跳过。JPEG 的 43 项原版对照匹配，Windows 原版 KAG 为 26/30，应用构建失败后未运行常规 Node 和浏览器验收。[124 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45491545439)
- 125 取回时有 15 个作业成功，另有 10 个运行中。已取得的原版 ERI 编码器对照 10/10 匹配。Windows 原版介绍样例的准备、首次菜单或分页观察、保存步骤成功。该作业中的 KAG 书签执行与比较步骤失败。应用发布构建仍在类型检查步骤，尚无本批浏览器游戏路线结果。[125 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45494717147)
- 这两个运行当时列出的 47 份 ZIP 已逐份核实字节数与 SHA-256，共 413,615,461 字节。

第 126 批增加 8 个常规 Node 测试和每个浏览器项目 12 个测试。Windows 原版作业执行 41 个 KAG 场景、20 个 SLI／WAVE 场景和 21 个转场选项场景。下批取回本批报告后，先核对发布构建、原版书签及 Web 读档，再核对介绍游戏的实际交互路线。[托管工作流](../../.github/workflows/test.yml)

实现提交 `ed9628ce0f01502c56545de48b0cf07d862cc218` 已推送。首次登记时，GitHub 托管全套验证正在排队。[126 运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45497700733)

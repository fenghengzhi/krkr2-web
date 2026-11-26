# 第 174 批剧情历史、过场声音与 CD 配乐

## 保留旧过场的音画时间差

第 170 批 Firefox 播放两段 MPEG 过场时，游戏时钟约为 0.6 秒就能听到 440 Hz，而制片时设定此时仍应静音。转换得到的 MP4 以音轨开头的空编辑区间表示延迟。现在转换器按共同时间原点在音轨中实际补入静音。托管验收用独立的 FFmpeg 解码转换后的文件，检查开头的采样、后续三段音调和视频帧时间，再交给原有浏览器用例核对播放器实际输出。另有 WMV 帧号差异和长 Vorbis 音乐回归待核实。[转换器](../../src/backends/video/legacy/convert.ts) · [独立音频检查](../../tests/helpers/legacy-audio-reference.ts) · [Firefox 原始报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169027)

## 带预加重标记的 CD 音轨

过去，CUE 中的 `FLAGS PRE` 会让游戏打开音轨时直接报错。现在 `CDDASoundBuffer` 会在源采样率下按 50/15 微秒的 CD 去加重曲线还原这类音轨。标记跟随各轨内容，包括录在下一轨 INDEX 00 的声音。连续播放接续滤波器状态，跳转时从选定音轨内的前置样本恢复。未标记部分直接使用原样本。[CD 读取与滤波](../../src/formats/audio/cdda-source.ts) · [CD 去加重时间常数](https://www.nxp.com.cn/docs/en/data-sheet/SAF784X.pdf)

验收以模拟曲线独立检查 400 Hz 到 20 kHz 的六个频点，另外核对双声道、音轨标记切换、间隙和非顺序定位。浏览器用例通过实际声音输出比较同一段配乐开启和关闭预加重标记时的音量。[数值和音轨边界验收](../../tests/conformance/cdda.test.ts) · [浏览器输出验收](../../tests/browser/cdda-preemphasis.spec.ts)

## 章节历史、画面和玩家点击

第 170 批 Firefox 第 2 分片 371 项中 311 项通过，60 项失败。其中 20 项已经进入正确章节，但预期单独出现的新对白前面还有上一页菜单文字。原版 KAG 在默认历史模式下运行 `[cm]` 会清空画面，历史层则继续写当前行。这五组用例现在用原版 `[hr]` 指定新章节的历史行，同时检查旧选项仍能从历史中读到。章节、变量、访问次数和存档内容沿用原来的验收条件。[剧情设置](../../tests/helpers/kag-modes.ts) · [历史记录断言](../../tests/browser/kag-names.spec.ts) · [存档剧情](../../tests/helpers/native-saves.ts)

另有 20 项在比较像素时读到多一行的元素截图。托管记录显示绘图缓冲区尺寸正确，画布的 CSS 顶部落在小数坐标上。现在按绘图缓冲区宽高检查全部像素，另存实际页面截图。还有四项鼠标用例已经在正确坐标收到真实右键事件，但场景对窗口自身的事件也读取了图层名，脚本随即中断。本批让场景在读取名称前检查目标是否为图层，继续核对左键选择、右键菜单、中键历史、双击及图层命中结果。[默认字体画面](../../tests/browser/layer-default-font.spec.ts) · [按钮与事件次序](../../tests/browser/mouse-button-choice.spec.ts)

同次取回的 WebKit 第 3 分片为 320 项通过、4 项失败。第 171 至 173 批在此次取回时仍在排队。[WebKit 原始报告](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032169006) · [第 171 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320) · [第 172 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217) · [第 173 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45861660259)

第 174 批实现提交 `972205a` 登记时为 `pending`，下一批取回运行结果。[第 174 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45863379478)

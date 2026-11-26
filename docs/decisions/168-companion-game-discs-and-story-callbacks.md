# 第 168 批配套光盘与剧情回调

## 安装包与剧情盘分开发行

玩家可以在“自动识别”模式下一起导入主程序 ZIP 和配套光盘。安装包中没有光盘时，一张额外的 CUE 及其轨道文件，或单独一张 ISO，可以自动挂到 D 盘。若没有散装光盘，游戏首次查盘时也会检查其他 ZIP 的文件目录，唯一的配套盘可自动挂载。若需选择盘片或指定盘符，可填写 `G=Voices.zip>Media/story.cue`。游戏可以按卷标找盘，从盘里读取章节、图像和压缩素材，也可以播放音频轨。若两个压缩包都含有可启动的游戏，可在“游戏程序名或发行包”指定主包。[项目准备](../../src/engine/storage/distribution.ts) · [盘符与 CUE 轨道解析](../../src/engine/storage/cdda.ts)

配套媒体由独立的只读文件目录提供。脚本搜索路径和程序配置仍来自安装包，CUE 中的 `FILE` 在该 CUE 自己所在的目录或压缩包内查找。即使主程序恰有同名配乐，也不会被用作外部盘的音轨。原先可以解析的游戏内绑定继续优先。游戏库保留原始输入文件，重开时可以按已保存的绑定重新挂盘。[会话](../../src/engine/session.ts) · [Worker 准备与重开](../../src/workers/session.worker.ts) · [同名文件与多盘验收](../../tests/conformance/distribution-disc-imports.test.ts)

托管游戏库用例将固定原版 KAG 的主程序、补丁与启动脚本置于 `Game.zip`。源码组导入旁边的 CUE 和 ISO，字节码组从另一个 ZIP 打开光盘。各组都需要实际进入章节，显示盘内图像，保存进度 42，修改到 99，刷新后读回 42，并核对书签字节与游戏身份。另有会话用例从同一配套盘执行包里的剧本并播放第二轨，核对左右声道的实际样本。[游戏库验收](../../tests/library-browser/disc-story.spec.ts) · [数据轨与音轨](../../tests/integration/distribution-disc-imports.test.ts)

## KAG 控制标签与声音结束时的位置

原版处理满足执行条件的标签时，会先读宏字典中的同名属性，再处理内置的 `if`、`call` 等控制标签。游戏可以在这个读取函数中更新状态或选择跳转章节。网页端此前遗漏了部分读取，使同一份脚本可能走进另一条分支。本批修订了这个顺序，也保留了条件排除与宏录制期间的处理规则。[原版 KAG 解析器](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/utils/KAGParser.cpp#L1692-L1701) · [网页 KAG 解析器](../../src/engine/kag/parser.ts) · [原版共用对照](../../tests/helpers/kag-macro-directory.ts) · [模板章节与存档](../../tests/browser/kag-macro-directory.spec.ts)

当普通 WAVE 自然播放完毕，原版先交付曲尾标签，再将位置归零。游戏在停止回调里可以依此播放下一句。网页端现在对普通与带平滑处理的 WAVE 提供一致的位置。整曲循环和在终点触发的 SLI 跳转仍可继续播放。[原版曲尾处理](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L2592-L2612) · [音频混音器](../../src/engine/media/mixer.ts) · [浏览器声音接续](../../tests/browser/wave-tail.spec.ts)

## 已发布的托管结果

第 166 批影片转换器构建成功。应用生产构建随后因纯引擎 TypeScript 配置无法识别 CUE 解码器中的 `TextDecoder` 而失败，依赖该构建的 Node 和浏览器作业被跳过。本批将同一套文本解码逻辑放回文件后端，光盘读取使用后端提供的解码器。托管验收涵盖 UTF-8、两种字节序的 UTF-16 和 Shift-JIS。独立类型检查作业也开始使用纯引擎配置，可以在原生媒体构建结束前报告这类错误。[第 166 批转换器](https://github.com/fenghengzhi/krkr2-web/actions/runs/45843758935/job/139991941317) · [应用构建日志](https://github.com/fenghengzhi/krkr2-web/actions/runs/45843758935/job/139993446443) · [文本解码](../../src/backends/files/blob-source.ts)

第 167 批的工具类型检查和影片转换器构建均已通过。已发布的 FFmpeg 比较文件记录 10/10 个声道布局匹配，取证时该作业与应用构建都还在运行，尚无该批游戏库报告。本批新增行为等待下一批取回托管证据。[第 167 批声道对照](https://github.com/fenghengzhi/krkr2-web/actions/runs/45846712743/job/140002166277) · [第 167 批应用构建](https://github.com/fenghengzhi/krkr2-web/actions/runs/45846712743/job/140002713374)

第 168 批实现提交 `fea67c6` 登记时为 `queued`，运行结果在下一批取回。[第 168 批托管验证](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408)

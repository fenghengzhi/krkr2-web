# 设备书签、模态阅读层焦点与多声道配乐

## 从设备读档后继续游戏

原版 KAG 的自由书签模式允许玩家从“Follow Bookmark”菜单指定文件。网页中的打开对话框现在可以唤起设备的文件选择器，将玩家选中的单个文件以原文件名提供给正在等待的 `Storages.selectFile`。游戏获得本次会话内的只读路径，文件按需读取。关闭游戏会释放这份引用。之后用“Place Bookmark”保存进度时，即使 KAG 沿用了外部书签的目录，保存对话框也能回到游戏配置的存档目录。[KAG 菜单验收](../../tests/browser/kag-named-bookmarks.spec.ts) · [目录选择与写入检查](../../src/engine/storage/selector.ts)

浏览器验收从原版 KAG 菜单保存章节 7，在游戏进到章节 99 后，从设备重新选取先前导出的书签，再检查剧情、书签内的数据和新存档的位置。同时覆盖普通 KDT 和带缩略图的 BMP。原版 KAG 会记住上次的设备文件名。游戏重开后若该路径已经失效，对话框从游戏存档目录开始。会话验收还检查无扩展名的文件、选中的筛选项，以及取消后迟到的文件选择结果。[会话验收](../../tests/integration/storage-selector.test.ts)

手机的系统文件选择器可能暂时将游戏转入后台。玩家选定文件后，页面等同一个游戏对话框恢复输入再提交。如果游戏已经换了对话框，该次选择会随原请求释放。[对话框验收](../../tests/browser/system-dialog-host.spec.ts)

## 阅读层的第一个键盘事件

原版 `Layer.setMode()` 进入模态时，会从该层开始寻找可取得焦点的图层。有些游戏把阅读区排除在 Tab 顺序之外，却需要它在弹窗刚打开时接收 Enter。现在进入模态时按原版规则选中阅读层，之后按 Tab 仍按游戏指定的顺序移动。用例同时检查模态层自身、子层和不可取得焦点的图层。[输入控制器](../../src/engine/input/controller.ts) · [焦点验收](../../tests/integration/layer-focus-result.test.ts)

## 多声道 Vorbis 配乐

完整解码和分段播放共用 Vorbis 声道顺序及扬声器位置。此前五声道文件的左后方声音可能消失，右后方的声音可能出现在左侧，6.1 声道的后中置也可能偏向一侧。本批按声道位置向混音器提供采样。托管 runner 用 FFmpeg 生成每个扬声器具有不同频率的 5.0、6.1、7.1 配乐，并独立导出各声道和双声道混音作对照。[声道映射](../../src/formats/audio/vorbis-layout.ts) · [托管素材与参考混音](../../scripts/generate-vorbis-speaker-fixtures.mjs)

会话验收用游戏脚本切换配乐、暂停、定位、跨越 SLI 循环点并重播。浏览器验收录制实际输出的左右声道，检查各扬声器对应的频率在混音中的位置。[会话播放验收](../../tests/integration/vorbis-speakers.test.ts) · [浏览器录音验收](../../tests/browser/vorbis-speakers.spec.ts)

## 已取回的托管结果

第 172 批 Firefox 游戏库 **109/110 通过**。第 171 批在这个套件出现的 36 个失败用例此次均已通过，其中包括从光盘启动、换盘、恢复下载和存档迁移。剩余一项在大型影片换轨后等待游戏回报新轨道时超时。第 172 批 Chromium 游戏库的完整结果为 **110/110 通过**。[第 172 批 GitHub Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217)

本次新取回九份第 172 批浏览器产物，合计 2,988 项通过、356 项失败、2 项跳过，另有 613 项未报告。部分作业已取消。已取回的失败还涉及 WebKit 加载滚动场景时的启动状态和影片音画时钟。取回时第 173 至 181 批仍在队列中。以上计数仅属于已标明的提交和套件。[第 172 批 GitHub Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45859775217) · [第 181 批 GitHub Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45880484737)

第 182 批实现提交 `76a8f35` 登记时为 `pending`，结果留到下一批取回。[第 182 批 GitHub Actions](https://github.com/fenghengzhi/krkr2-web/actions/runs/45883191112)

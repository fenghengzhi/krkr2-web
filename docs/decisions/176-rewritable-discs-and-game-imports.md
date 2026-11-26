# 第 176 批可擦写光盘、分段过场和游戏导入

## 从可擦写游戏盘进入剧情

部分 CD-RW 和 DVD-RW 把一组数据块迁移到备用位置，盘中目录仍记录原来的逻辑地址。播放器现在可以读取单卷 UDF 的可替换分区（Sparable Partition Map），在查找卷标、游戏目录、XP3、剧情或影片时跟随备用位置。读取器检查映射表副本，并在有多个有效版本时采用序号最高的版本。读取跨过迁移区域的文件时，会在边界处分别定位，目录和文件标记仍按逻辑地址校验。[UDF 分区读取](../../src/formats/disc/udf-volume.ts) · [UDF 2.01 第 2.2.9、2.2.11 节](https://ecma-international.org/wp-content/uploads/ECMA_TR-112-4_1st_edition_december_2023.pdf)

新验收在 GitHub 托管 Linux 上制作一张 UDF 2.01 DVD-RW。它把包含文件集描述符的 16 个块移动到制盘工具预留的备用位置，写入两份映射表，再清空原块。Linux 只读挂载这张盘，逐个核对文件和目录。浏览器用同一张盘启动原版 KAG，进入章节、保存、刷新并读回原进度。已有 UDF 1.02、2.01 物理分区盘保留各自的制盘和比对结果。[独立制盘](../../scripts/generate-udf-game-discs.py) · [原版章节和存档](../../tests/library-browser/disc-boot.spec.ts)

## 播放分段存放的大过场

浏览器现在能把来自同一光盘镜像、分散存放的多个 Blob 切片按文件顺序拼接。ISO 的多段文件，以及 UDF 中被分段记录或迁移到备用块的文件，都可以沿用这个路径。普通单段读取仍可直接取一片。可借用范围限于有实际文件支撑的连续数据扇区，稀疏区和带交错间隙的数据继续通过范围读取。这样，超过 128 MiB 缓冲上限的过场也能从分段镜像播放。[光盘文件分段](../../src/formats/disc/track.ts) · [浏览器 Blob 拼接](../../src/backends/files/archive-reader.ts)

托管验收以 genisoimage 生成的 ISO 为底盘，把一段双画面、双音轨 MP4 分成两段，中间插入其他数据。游戏通过盘符打开影片，检查播放器借用了文件、跨段取到了 144 MiB 以后的画面，并通过游戏按钮换轨，核对渲染后的像素和实际发出的声音。[制片与布局](../../tests/helpers/large-video-disc.ts) · [游戏内播放](../../tests/browser/video-large-file.spec.ts) · [备用块内外的读数](../../tests/conformance/udf.test.ts)

## 拖入游戏与停止声音

玩家可以把 XP3 文件或游戏目录拖到“载入你的文件”区域，再从同一处启动游戏。单个文件夹沿用“选择文件夹”的相对路径，多个根目录各自保留名称，以便游戏继续找到同目录的脚本、素材和补丁。游戏窗口内的文件投递仍交给游戏脚本处理。[播放器导入](../../src/app/app.ts) · [文件和目录拖放](../../src/app/game-file-drop.ts)

验收先从文件夹选择器启动原版 KAG 并存档，再经拖放导入同一组文件，核对游戏身份、书签字节和读回的章节，最后从游戏库重开。测试使用浏览器文件句柄及文件拖放事件，桌面文件管理器到浏览器的实际手势仍待实机验收。[拖入与重开验收](../../tests/library-browser/game-import-drop.spec.ts)

游戏调用 `WaveSoundBuffer.freeDirectSound()` 时，播放器按 Wave 的创建顺序停止播放、派发状态回调，再释放各自的播放缓冲。游戏仍可通过原声音对象重新播放已打开的素材。MIDI 和 CD 音轨使用独立通道。用于传递播放缓冲释放命令的会话协议升到 65。[原版方法](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp#L3347) · [脚本方法](../../src/engine/tvp/sound.ts) · [声音混合器](../../src/engine/media/mixer.ts) · [实际输出、释放与恢复验收](../../tests/browser/wave-free.spec.ts)

## 已取回的托管结果

第 170 批已以失败结束，42 个作业成功，12 个失败，3 个跳过，5 个取消。最后一个 WebKit 分片的日志记录了 294 项通过、30 项失败、1 项跳过，剩余 23 项未报告。[第 170 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668) · [WebKit 第 1 分片](https://github.com/fenghengzhi/krkr2-web/actions/runs/45854886668/job/140032168981)

第 171 批取回时已有 36 个作业成功，包括生产构建、类型检查和 Chromium 离线验收（22/22）。原版 SDK 的游戏注册表对照有 3 组匹配、光盘识别 5 组匹配，4 组存档搬运完成。另有 3 个作业失败，其余仍有作业在运行或排队。第 172 至 175 批当时尚无作业结果。[第 171 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45857270320) · [第 175 批](https://github.com/fenghengzhi/krkr2-web/actions/runs/45865578673)

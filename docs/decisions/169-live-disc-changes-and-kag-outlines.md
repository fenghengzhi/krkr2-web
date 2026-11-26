# 第 169 批运行中换盘与 KAG 描边对白

## 在同一盘符继续下一章

多盘游戏可能一直从 D 盘找素材，并在需要下一张盘时显示提示。现在可展开“运行中换盘”，指定盘符后换入已导入的 ISO 或 CUE，也可从设备选择新的光盘文件。CUE 的轨道放在子目录时，可以选择整个文件夹。游戏通过 `System.inform` 提示换盘时，对话框内也能操作，换好后再按游戏的确定按钮即可继续。[播放器控件](../../src/app/live-disc.ts) · [游戏对话框](../../src/app/game-dialogs.ts) · [光驱实现](../../src/engine/storage/cdda.ts)

插盘前会检查镜像的文件系统或 CUE 引用的轨道。选错文件、缺少轨道时，原盘仍可读。弹出后盘符保留，游戏查不到原卷标或文件。“恢复启动时的光盘”恢复该盘符原有的设置。临时选取的文件只用于这次游玩。游戏库记录、存档身份及下次启动的盘片均使用原来的导入配置。[会话接口](../../src/engine/session.ts) · [文件来源](../../src/workers/session.worker.ts)

换盘后，新读取的同名脚本、KAG 场景、图片和归档成员使用新盘内容。已经载入游戏的当前场景可以继续执行。音频服务卸载旧盘上的 CD 音轨，下一次打开同一盘符可读新轨。其他盘上的音轨和普通声音可以继续播放。[存储目录与搜索](../../src/engine/storage/resolver.ts) · [归档目录缓存](../../src/engine/storage/archives.ts) · [CD 声音](../../src/engine/media/sounds.ts)

托管 Linux 独立制作两张把不同剧本、像素和归档内容放在相同路径的 Joliet 镜像，其中归档由 Python 生成。制盘后用 `isoinfo` 从镜像逐个提取文件，再与原始输入逐字节比对。会话测试在同一 D 盘读 A、换 B、弹出并恢复 A。游戏库测试从原版 KAG 模板进入章节、保存进度 42、修改到 99，重开后换盘并恢复原书签，另核对原始文件清单。[镜像制作](../../scripts/generate-disc-swap.py) · [同名资源与存档](../../tests/integration/disc-change.test.ts) · [CD 音轨验收](../../tests/integration/cdda-change.test.ts) · [游戏库验收](../../tests/library-browser/disc-swap.spec.ts)

## 原版 Introduction 的描边对白

原版 KAG 的 MessageLayer 用强度 512 绘制描边。此前网页字体服务把强度当作单个透明度字节处理，在 Introduction 第二条路线显示描边对白时拒绝了这个值。本批允许该强度，并在增强后的字形覆盖度达到上限时取最大值。零半径与带半径两种路径都有验收，Web 端支持的强度为 0 到 32767。新增浏览器用例使用未经修改的原版样例，经过注音、描边、纵排和转场，在算题中先答错再答对，回到标题后退出。[字体绘制](../../src/engine/graphics/fonts.ts) · [字形覆盖度](../../src/engine/graphics/glyph.ts) · [原版映射字形对照](../../tests/helpers/mapped-text.ts) · [Introduction 第二条路线](../../tests/browser/kag-intro-complete.spec.ts)

## 已取回的结果

第 167 批最终失败，应用构建仍遇到此前的 `TextDecoder` 类型错误。第 168 批在独立作业中用纯引擎配置检查成功。同一作业的工具类型检查遇到一处新的测试断言类型错误。第 169 批改用数组长度验证此前没有读取 ZIP，后续实际开盘和命中缓存的断言一并保留。取证时第 168 批的应用构建仍在运行，尚无新的主浏览器或游戏库报告。[第 167 批运行](https://github.com/fenghengzhi/krkr2-web/actions/runs/45846712743) · [第 168 批类型检查](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408/job/140011251690) · [第 168 批应用构建](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408/job/140011737201)

第 168 批的 KAG 原版比较为 136/138，四项新增的宏目录、条件、章节选择和书签对照全部匹配。Windows 声音对照记录了两种 WAVE 曲尾用例的运行环境缺少声音驱动。第 169 批的换盘与描边结果等待后续批次取回。[第 168 批原版对照](https://github.com/fenghengzhi/krkr2-web/actions/runs/45849334408)

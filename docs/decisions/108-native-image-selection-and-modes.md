# 108 原版图像选择与加载模式

状态：开发候选，尚待 GitHub-hosted Actions。上一轮 107 已提交并推送实际修复与诊断，属于有进展的一轮；本轮从干净的 `dc4d046` 继续。完整目标仍为完成插件以外的 KRKR2 Web 模拟器，未完成。协议 **41**、TJS ABI **5**、字体 ABI **2** 和现有能力版本保持；本批只改变内部图像接口。

本地只读取／编辑源码、操作 Git，并下载、保存、核对及解析历史原件。没有运行测试、构建、类型检查、生成验证、浏览器或候选探针。批次推送后只取一次新运行身份，下轮回收结果。

## 上轮固定结果快照

107／`40773899535` 的精确提交为 `ff9a73ed0213b50f03b342d5cb4f3cbb44955629`。本轮分别取一次 run／jobs／artifacts，run 仍 **in_progress、无 conclusion**；十三个已出现的作业为七 success、一 failure、五 running。主 build 仍运行、没有构建产物；Node、浏览器、直接 runtime、兼容、可信生命周期以及 Layer／菜单诊断尚未报告，不能写成已通过或 skipped。

固定九份原 ZIP、**3,147,682 字节**全部与 API 大小及 SHA-256 一致；原响应、原 ZIP、日志和摘要保存在 `out/verification/github-actions/40773899535/` 与 `108-archive-summary.{json,md}`，此前失败及缺失记录保持。三个端点不是原子快照：独立 Asyncify identity 的完整原报告已有六十记录、零 failure，但 job 快照仍 running，两个事实分别保留。

唯一已失败作业是 Win2022 beginMove：caption-left-up 在调用 SC_MOVE 前未满足消息标签确认，`invoked=false`、`leftDownInjections=0`。真实目标、前台、焦点、坐标和按钮状态已满足，而消息 extraInfo 为零，预期为 1263357782；之后清理移动的正确标签不能替代原位置的确认。清理已完成，其他六个场景 observed；Win2025 七项 observed。本批保留该失败，不改变输入确认门槛或推断 Web 拖动结果。双系统几何各二十四场景／960 字段、原版退出各七被动加一受控关闭菜单场景、双 sanitizer 栈池各六场景的报告也只代表各自范围。光标和 JSPI identity 原件仍未报告，不刷新。

## 选定后缀、模式和真实消费者

原版依据是固定 KRKR2 2.32stable 提交 `dec49af97e174d31059c3ccd7efc700ba3c6b788`。无插件时后缀推断按 `.tlg6,.tlg5,.tlg,.eri,.png,.jif,.jpg,.jpeg,.dib,.bmp` 查找，不先读取裸文件。显式后缀按 ASCII 大小写折叠选择 handler；未知后缀在查询／打开资源前抛 `TVPUnknownGraphicFormat`。无后缀而无候选抛 `TVPCannotSuggestGraphicExtension`，已知格式但缺文件抛 `TVPCannotOpenStorage`，使用规范化的请求名称。真实异步存储查询、AutoPath、XP3 和存档覆盖继续保留原异常，不吞掉损坏的高优先级归档来选择后面的格式。

ImageLoader 将选定的 format 和 normal／grayscale／palettized 模式传到 Session 的独立入口。后者只调用所选格式，不因不匹配或解码失败尝试其他格式。浏览器 host 同样检查选定格式签名；合法但 portable BMP 尚不支持的分支只交同格式 host。直接字节解码和 CUR 内 PNG 路径保留既有用途，不借此绕开脚本图像 handler。

主图使用 normal，遮罩和 universal rule 使用 grayscale，省份图使用 palettized。普通模式缓存不能绕过后续 TLG 模式拒绝、JPEG 省份拒绝或 PNG 模式限制；缓存按规范资源、handler 和模式分区。原资源 token、在途工作上限、字节预算、拷贝隔离、清理和取消规则保留，按原资源名失效会清除全部模式和在途条目。

已确认的 BMP magic／header／compression／palette、PNG signature／特定模式与原尺寸上限、TLG signature／mode／结构分支使用对应原生消息及原原因。ERI 仍是注册的格式，当前实现返回 `TVPNotImplemented`，不能忽略 `.eri` 而继续选 PNG。来自预算、取消、短读、宿主或尚无对应原原因的解码错误保持原身份，不按英文文本猜测分类。transition provider 的失败使用外层 `TVPCannotLoadRuleGraphic` 和调用者原 rule 名，取消继续直接退出。

## 灰度、伴随资源和审计更正

固定 `tvpgl.c` 的 BMP／PNG palette 灰度为 `(54R+183G+19B)>>8`。固定构建头为 libpng 1.0.6；原加载器对 RGB(A) 调用 `png_set_rgb_to_gray_fixed(...,1,0,0)`，同版本实现的零红／绿系数实际保留蓝通道。新 selected PNG 路径按这个真实参数转换并去除 alpha，既有 direct PNG 像素解码保持。原件和来源清单存于 `out/verification/image-loading/108-source/`；新增不同 RGB／alpha 的字面像素断言，不能以颜色相同的灰图掩盖公式差异。

伴随资源使用规范化请求 stem，而不是主图最终放置在归档／AutoPath 中的名称；显式主后缀先用于 mask，无后缀请求不会因推断出主格式就新增 mask 优先项。主图完成后先发现省份名称，再读取／应用 mask 与 matte，最后加载省份像素。省份失败仍保留已完成的主图，并沿用原有目标变更／Stop 检查；尺寸诊断区分发现的 companion 名和直接调用者原名。

**更正 107 审计：** TouchImages 传入的 province 输出指针虽为 NULL，`TVPLoadGraphic` 在 GraphicsLoaderIntf.cpp:2541 内部仍传 `&pn`，因此 cache miss 时仍发现省份名称。它不读取或解码省份像素。本批按该源码实现查找顺序，预加载也实际处理 mask、检查尺寸及取消；107 原审计保留，不能把此前“完全不查省份”的推断当原版事实。详见 `108-loader-audit.md`。

## 验证范围与剩余缺口

新增 **45 个常规 Node 定义**：十三个 selected decoder、十五个选择／顺序、三个多模式缓存生命周期、十四个真实源脚本／字节码场景；另新增**每浏览器四个定义**，覆盖 Asyncify／JSPI 与源／字节码组合。它们检查真实消息 holder、后缀优先级和别名、错格式、无后缀裸文件、ERI、模式缓存、跨 AutoPath 伴随图、压缩 XP3、存档替换、Stop、完整参考像素和实际画布。浏览器还自行编码／独立解码 JPEG，检查三种 JPEG 后缀的真实 host 路径；此参考不代表历史 libjpeg 像素等价。

原 roundtrip 测试改为与编码匹配的 `.png/.tlg5/.tlg6`，保留所有像素、路径、存档恢复和生命周期断言。默认 writer 写到 `.png` 仍产生 BMP 的原契约继续单独核对；只写不读的取消场景仍可用任意后缀。原 palette GIF 场景换成相同参考 RGBA／indices 的 indexed PNG，direct GIF decoder 验证保留。TLG rule 场景先断言真实外层拒绝，再用相同灰度样本的 PNG 保留原正向转场画面与完成次数。

本批不声称完整图像兼容：原版处理后缓存的请求／key／尺寸及省份名复用、main／mask 失败的部分目的地写入、原生 TJS 短读消息、更多 decoder 原因仍待实现。JPEG host 只提供 RGB，当前灰度是明确的 BT.601 Web 近似，尚不等于原 libjpeg Y 分量和数字错误；OS/2／15–16bit BMP 的 host 支持仍需各浏览器结果。原 PNG RGB8 palettized 分支没有安全地拒绝多字节行写入，本实现保留明确的 Web 不支持错误，不复制越界行为或编造原消息。完整目标、历史应用回归、菜单 heap 根因及真实游戏验收继续未完成。

所有新增执行结果仍未报告。下轮补取 107 未报告范围并回收本批结果，不实时监控。

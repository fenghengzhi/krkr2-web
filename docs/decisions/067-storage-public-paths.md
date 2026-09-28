# 067：Storages 原生通用类与公开游戏路径

本切片将通用 Storages 从 bootstrap Dictionary 改为真实 TJS native Class，并让同一规范名贯穿资源解析和保存。公开完整名称统一使用 `game://./`；这是当前会话游戏挂载空间的虚拟媒体。内部 `Resource.name`、存档键、缓存标识及导出备份仍使用根相对名，现有存档无需迁移。

## 原版依据和 Web 适配

通用方法与注册、参数转换顺序依据固定 `krkrz/krkr2@dec49af97e174d31059c3ccd7efc700ba3c6b788`，`kirikiri2/branches/2.32stable/kirikiri2/src/core/base/StorageIntf.cpp` 的词法函数、自动路径和 Storages 注册实现（固定原文归档见当前任务 `out/verification/storage-paths/reference/source/StorageIntf.cpp`）。该归档和官方 2.32r2 SDK 文档的版本、哈希、差异说明见 `out/verification/storage-paths/contract.md`；官方发行文档与源码提交不宣称编译同源。

这个媒体不访问宿主文件系统，不解析网络 URL。`file`、HTTP、驱动器、UNC 和其他媒体均拒绝。远程导入的 URL 仍仅是宿主导入流程的数据来源，游戏脚本没有因此获得网络路径媒体。

`getFullPath` 不查询存在性。空串得到空串，非空且消除点段后为根得到 `game://./`；普通目录保留尾 `/`，归档根保留尾 `>`。大小写可变的 `GAME://./` 只规范媒体前缀，路径本身保留原拼写。相对名、反斜线与单层 `archive>member` 继续可用。`%xx`、`?`、`#` 不由路径解析器解码或赋予 URL 含义；具体媒体 API 原有的参数语法（例如 VideoOverlay 的 `?` 选项）不变。

这是明确的 Web 适配：原版 Windows 使用 `file://` 和 ASCII 大小写规范化；现有 Web 挂载允许 `Scene.tjs` 与 `scene.tjs` 作为不同 exact 名称，查找无 exact 命中时保留已有 Unicode 折叠唯一匹配/歧义错误规则。自动目录去重也保留大小写。只支持通常的 `.` 与 `..`，纯 `...` 仍是普通分量。终端 `.`/`..` 表达目录，不复刻尚无 hosted SDK 观察证实的原版就地字符串处理边界。

## Native 边界

9 个静态 native Function 为 `addAutoPath`、`removeAutoPath`、`getFullPath`、`getPlacedPath`、`isExistentStorage`、`extractStorageExt`、`extractStorageName`、`extractStoragePath` 和 `chopStorageExt`。类保留空 `finalize`，不注册名为 `Storages` 的构造函数，不允许创建实例或派生实例，不添加 `currentDirectory` 属性。

方法先按 native 规则检查 receiver 和最少一个实参，再通过 `ttstr` 执行真实 TJS 字符串转换。七个有返回值的方法只在转换后判断结果是否被使用；不用结果时跳过算法与 host dispatch。add/remove 始终执行，返回 void。多余实参由 TJS 正常求值，但不转换或转发给 host。因此未使用结果时 octet 仍触发转换错误，未知媒体字符串则不进入规范化；这与 System 提前跳过部分委托的策略有意不同。

wrapper 直接将已转换的一个字符串传给固定 host operation。没有捕获 TJS 委托、可被借用 receiver 覆盖的 `__host`、额外 assembly handles 或 nativeStates 引用环。既有 `dispatch_host` / `resolveReply` 和 RAII 回复所有权处理错误和退出。空 receiver 规则保留在 native 入口；TJS 的 `incontextof null` 可能由 variant closure 自动回退 receiver，不能用它虚构一次真的空 native receiver 调用。

WASM manifest 新增 `nativeStorages: 1`，保留 `nativeSystem: 2` 和现有 ABI。生产 Worker 初始化拒绝缺失或不匹配的内核能力，不能以 Dictionary fallback 载入旧内核。

## 路径和保存边界

`src/engine/storage/public-path.ts` 是无宿主依赖的公开名转换入口，四个词法拆分函数独立于规范化。词法函数仅以 `/`、反斜线及 `>` 识别边界，从末端查找点；不改变大小写、Unicode、换行、NUL、冒号或 query 样式文字。

公开名先去掉唯一受支持的媒体前缀，再规范分隔符和点段。外部 archive 和内部 member 分别检查根边界；第二个 `>`、NUL、绝对路径、未知媒体及点段消除后暴露的 scheme/drive 均拒绝。严格导入函数不接受公开媒体前缀，避免公开读取语法绕过导入文件名校验。这个消除点段后的 scheme 检查也由普通导入路径共享，因此启动 dataPath 中 `./C:` 一类输入在共享路径边界被拒绝，错误文案相应为 `Invalid resource path`。

读取归一到 Resolver candidates；每个 candidate 先选保存覆盖层，再选挂载资源。`getPlacedPath` 将实际选中的 `Resource.name` 转成完整名称，不根据候选名猜测，也不重复查询。找不到普通资源返回空串，非法地址和歧义错误继续抛出。

闭合入口如下：

| 入口                                                                          | 统一边界与保持的行为                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Scripts exec/eval/compile、Array/Dictionary 读取和 native binary/text streams | Session 的 `readResource` / `resolveResource` → Resolver public-name candidates |
| 图像、mask/province、转换规则图、touchImages                                  | 既有 ImageLoader 查找回调 → 同一 Session resolver；伴随资源保留规范路径前缀     |
| 字体加载、音频及 `.sli`、VideoOverlay                                         | 既有资源回调 → 同一 Session resolver；不新增格式或媒体解码器                    |
| 文本/二进制 stream validateWrite 与延后写入                                   | 同一个 `storageWritePath`，编码及提交前验证，结果进入 SaveOverlay 的相对键      |
| Layer.saveImage/saveLayerImage                                                | 编码前验证规范目标，保存内容以相对键进入覆盖层                                  |
| Debug.logLocation 和日志写入                                                  | 解析公开目录，内部保留相对目录，实际 UTF-16LE 日志仍落在旧格式存档键            |
| 备份 import/export、SaveStore.load/commit                                     | import/load 继续严格相对输入；export/commit 只含相对键；不迁移现有存档          |

所有显式归档成员地址只读。平面成员 alias 仍可被保存覆盖，显式 `game://./base.xp3>member` 继续读取包内原字节。注册目录和 `getFullPath` 不展开 System dataPath 宏；宏只在启动选项初始化处理一次。

## 自动路径

add/remove 首先检查原始字符串最后一个字符必须为 `/`、反斜线或 `>`，再规范化目录。支持 `game://./`、`./`、普通目录、归档根和归档子目录；注册不要求存在。重复添加规范化后的同名目录不重排；移除不存在项成功；非法注册不改变列表。直接地址优先，随后按反向注册顺序拼接 basename，目录仅匹配直接文件，不递归。

已有测试夹具中 `addAutoPath("art")` 等无尾分隔符调用改为原版合法的 `"art/"`；旧 getPlacedPath 的相对输出预期改为统一完整名。这是公开 API 合同变更，不代表旧失败测试被改写为通过。

## 验收和证据状态

新增 source/compiled bytecode 的真实 WASM native 合同、词法/规范化/搜索/保存验收，以及正常浏览器 Worker 的持久化、归档、媒体加载和 loader 能力拒绝/恢复定义。纯模块案例补充无法安全依赖 native C 字符串表示的 NUL 等边界；它们不能代替真实 VM 测试。 新增 Node 注册定义共 39 项（native 15、路径 24），浏览器注册定义 20 项（主体 12、loader 2、公开 embedding 6；三浏览器配置下预计展开为 60 项）。这些数字是静态清单，不是执行结果。

**本切片当前仅完成源码编辑与静态审阅，测试、构建、类型检查和浏览器验收尚未运行。** 按用户要求与其他功能合并为批次后，只在 GitHub-hosted Actions 执行验证。定义存在、未运行、取消和失败都不能作为通过证据；历史运行与原始附件继续保留。

尚未完成：Windows OS 路径/UNC/驱动器、动态媒体注册和 current directory、`searchCD`、`getLocalName`、`selectFile`；任意嵌套归档；原版缓存和打开缺失/损坏 archive 的错误时机。当前归档在导入时建立索引，不能把缺失的 archive 地址假装成一次原版 archive 打开异常。本切片不是所有非插件子系统完成的声明。

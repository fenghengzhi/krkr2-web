# 解码图像缓存与预加载

状态：缓存、资源版本失效和三个 System 接口已接入纯 TypeScript 引擎。缓存不依赖浏览器存储，也不需要新增 WASM 模块。

## 存放位置与所有权

`engine/storage/image-cache.ts` 管理解码结果的 LRU、容量、并发读取合并和生命周期；`images.ts` 负责资源解析、伴随平面和预加载顺序；会话通过调度端口提供时钟、暂停和取消。

缓存保留颜色键处理之前的 RGBA、可选调色板索引和元数据。每次普通读取复制可变缓冲与元数据字典，再处理颜色键、mask、AlphaMat 和 province。图层修改、不同键参数和脚本修改标签不会污染下一次读取。规则图和 province 读取共用原始解码结果；预加载本身不创建 Layer 或改变画面。

以资源解析后的规范名称和不可变字节版本识别条目。大小写回退、auto-path 和省略扩展名最终解析到同一资源时可以复用缓存。改变 auto-path 会重新解析名称；伴随平面也每次重新查找，所以新导入的 mask/province 能及时生效。名称相同而资源版本不同则重新解码。

StorageResolver 每次挂载生成新 token。SaveOverlay 为每次成功写入生成稳定 Resource 和新 token，读取函数捕获那一版字节；正在读取的旧资源不会突然变为新文件。缓存仅持有 token 和解码结果，不通过资源读取闭包保留输入文件。文件流、图像写出和存档导入共用覆盖层的失效通知。失败的预算验证不改变资源版本。

同一版本的并发读取共用一个读取/解码 Promise，返回的副本仍相互独立；失败不缓存。clear、失效及 dispose 使旧的未完成操作不能重新插入结果。清理旧 Promise 时不会误删更新版本的操作。当前实现以全局 epoch 阻止失效之前启动的其他结果入缓存，代价是可能多一次解码，不会返回错误版本。

## TJS 接口

| 接口 | 行为 |
| --- | --- |
| `System.graphicCacheLimit` | 读出实际字节上限；写入 0 清空并停用，写入 `gcsAuto` / -1 恢复 32 MiB，其他非负值最大为 64 MiB |
| `System.clearGraphicCache()` | 释放保留的源图像，阻止清理前的解码重新插入；已加载的图层保持不变 |
| `System.touchImages(storages, limitbytes=0, timeout=0)` | 尽力预加载数组中的图像，返回 void，忽略单个文件的读取/解码失败 |

graphicCacheLimit 使用 TJS 的 property 引用放入原有 System 字典；属性读写仍由 VM 执行，初始化用的临时全局属性随后删除。

touchImages 在 TJS 中将数组元素转换成字符串，遇到第一个 void 停止枚举。单次列表最多 4096 项，以入口时的数组长度为界，元素 getter 追加的项目不延长当前枚举。容量为 0 时不读取文件；limitbytes 为 0 使用全部缓存上限，为正数使用两者较小值，为负数使用缓存上限加该负数，结果不大于 0 则不读取。

依次处理主图及当前 `_m` / `_p` 资源，按实际解码负载收费；同一资源不重复收费。列表前部优先：本次已选资源受保护，末尾资源不能为了入缓存驱逐它们；结束后调整 LRU，使前面的名称在后续正常加载压力下最后被淘汰。图像过大时可以完成解码但不保留，也会消耗本次预加载预算。预加载只是一项提示，并不保证所有条目常驻。

timeout 单位为毫秒，0 表示不限时；在开始下一个根图像之前检查，超时不会中断正在加载的图像及其伴随平面。循环按 8 ms 时间片让回宿主，缓存命中也参与让出检查；暂停等待恢复，取消必须退出，不能被“忽略加载错误”吞掉。

采用文档描述的顺序及容量/时间限制。参考分支的异步 preload 队列对非空数组提前返回，绕过其后计算的 limitbytes/timeout；本项目没有照搬这一行为。

## 预算和兼容边界

计费包括 RGBA、额外索引和标签键值的 UTF-16 字节数；解码器返回较大工作区的子视图时，缓存收紧为恰好容纳负载的缓冲。条目最多 4096 个，待合并操作最多 64 个。缓存大小变化会立即按 LRU 释放超额条目。关闭缓存后普通加载仍可正常工作。

这里约束的是保留负载，不是整个 JS 堆或进程峰值：Map/字符串对象开销、路径、正在解码的工作区、消费者副本、图层和合成缓存另计。统一内存预留与峰值测量仍待实现。System.clearGraphicCache 不清空图层位图或 SceneComposer 的合成结果。

Web 自动容量固定为 32 MiB，不模仿原生根据物理内存计算上限；浏览器没有本项目可跨平台依赖的物理内存接口。原生部分路径按请求字符串、颜色键、目标格式分别缓存，本项目按解析后的源资源复用；因此省略扩展名、颜色键、规则图或 province 使用方式的改变不会必然触发重解码。这些是保留加载结果语义的缓存策略差异，不宣称原生缓存命中率和内存行为一致。

## 验证

`tests/conformance/image-cache.test.ts` 覆盖 LRU、容量及条目上限、独立副本、并发合并、失败重试、清空/替换竞态、存档版本、预加载优先级/预算/超时及颜色键和伴随平面复用。`tests/integration/image-cache.test.ts` 通过真实 TJS 验证属性、参数转换、void、缓存命中、存档覆盖/导入以及暂停后停止。

`tests/browser/image-cache.spec.ts` 在三种浏览器的两个 WASM 后端验证 PNG/TLG 预加载、显示像素、修改隔离、文件覆盖、清空/停用以及大图预加载停止。测试通过启动日志触发真实停止按钮，不依赖图片必须加载到某个固定时长。

最终 `npm run check` 通过 150 项行为/集成测试和 171 项浏览器测试，无跳过项；原有 KAG 的三浏览器双后端输入、存读档与转场共 18 个场景全部通过。实现、构建哈希、日志与截图见 `out/verification/image-cache-matrix.json` 和 `out/verification/image-cache/`。此前独立图像样本继续参与回归。

## 来源

- [System.touchImages 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_System_touchImages.html)：优先顺序、容量、超时、忽略错误及提示语义。
- [System.graphicCacheLimit 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_System_graphicCacheLimit.html)：字节容量与 gcsAuto。
- [KAG 的 TJS 使用提示](https://krkrz.github.io/krkr2doc/kag3doc/contents/TJSTips.html)：预加载保留容量和超时的用法。
- 相邻参考的 `cpp/core/base/SystemIntf.cpp` 与 `cpp/core/visual/GraphicsLoaderIntf.cpp`：接口绑定、清空、LRU、现代异步分支及保留的顺序加载分支。仅作为只读参考，未引入参考项目的缓存实现。

# HTTP 资源来源与会话版本

页面可载入一个 HTTP(S) 文件链接；程序接口接受本地 Blob 与远程 URL 的有序集合。链接中的文件名可覆盖，XP3/ZIP 使用签名识别，所以下载地址不必带扩展名。启动入口、归档限定路径、覆盖顺序和存档继续由既有引擎处理。

## 边界与所有权

`backends/files/source-files.ts` 将输入描述符解析成 `ByteSource`；`http-range.ts` 负责 Fetch、范围、版本、缓存与中断。`import-resources.ts` 只把已解析来源转换为普通资源及归档成员。XP3/ZIP 解析器和引擎均不依赖 Fetch、URL 或 HTTP 头。

当前协议版本为 3（新增库来源引用后升级）：Worker 先 `prepare(files)`，验证整个输入集合、打开来源并生成游戏 ID，然后创建 VM，再 `mount()` 和执行入口。这保证身份计算与归档读取使用同一组来源。远程准备失败或用户停止都会关闭 HTTP pool；VM 取消也关闭它。准备阶段没有 VM，仍可响应停止。停止后的迟到响应不能发布来源或缓存。

一个会话只拥有一个 pool。它合并同 URL 的打开操作，以及相同块的在途读取；停止时清空缓存、释放完整快照并取消已发出/排队的 Fetch。原生流写入仍进入本地存档覆盖层，不执行网络上传。

## 范围与版本

第一次请求是 `GET Range: bytes=0-0`，不依赖 HEAD 或 Accept-Ranges。206 必须包含可读的 `Content-Range`、明确安全整数总长度和强 ETag。后续请求发到首次响应的最终 URL，带 `Range` 与 `If-Match`；逐次核对 206 状态、区间、总长度、ETag、最终 URL、Content-Length（存在时）和实际正文长度。Range 响应须为 identity 内容编码。

412、返回完整 200、版本/区间/长度/编码等不一致会使该来源永久失效，同时清除它之前的缓存。其他来源继续可用。网络异常、超时和临时 HTTP 错误不缓存结果，下一次显式读取可重试；当前不自动重试。已在缓存中的旧版本块可以继续使用，直到新请求发现来源不一致；不会主动轮询更新。

强 ETag 的比较规则依据 [RFC 9110 §8.8.3](https://httpwg.org/specs/rfc9110.html#field.etag) 与 [If-Match](https://httpwg.org/specs/rfc9110.html#field.if-match)。客户端依赖服务器正确维护强验证器，无法识别服务器复用 ETag 却改变字节的违约行为。当前不以 Last-Modified 代替强 ETag。

## 完整下载降级

服务器直接返回 200，或者小文件的 206 没有可用的强 ETag 时，允许一次有预算的完整下载。后一种情况先取消探测正文，再发不含 Range 的 GET。完整响应成为只读快照，之后不再联网；身份使用其强 ETag，否则计算完整 SHA-256。零长度文件的 416 `bytes */0` 也转为完整 GET 确认。

超过会话完整快照预算时明确拒绝，不能偷偷整包下载到无上限数组。已被浏览器解压的完整响应按实际解码字节计数；非 identity Content-Encoding 下不把传输 Content-Length 当成解码长度。未知长度流同样检查上限并取消超量正文。

## 跨域服务器配置

Fetch 使用 `mode: cors`、`credentials: omit`、`cache: no-store`。URL 只接受 HTTP(S)，拒绝嵌入用户名/密码，移除片段，保留查询参数。当前没有 Cookie 登录、Authorization 配置或远程目录枚举。

跨域 Range 服务器需要允许页面 Origin，处理 OPTIONS，并允许 `If-Match`；同时通过 `Access-Control-Expose-Headers` 暴露 `ETag, Content-Range, Content-Encoding`。例如：

```http
Access-Control-Allow-Origin: https://player.example
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: If-Match, Range
Access-Control-Expose-Headers: ETag, Content-Range, Content-Encoding
```

单个 Range 可以是 CORS 安全列出的请求头，但 If-Match 需要预检，ETag/Content-Range 也不会默认暴露给脚本。规则见 [Fetch CORS 协议](https://fetch.spec.whatwg.org/#cors-protocol)。应用必须遵循浏览器的 HTTPS、跨域和本地网络访问策略；此功能不代理或绕过这些限制。

## 预算

| 项目 | 当前限制 |
| --- | --- |
| 会话块缓存 | 默认 32 MiB LRU，可配置 0–64 MiB |
| 块大小 / 单次范围请求 | 256 KiB / 最多 4 块，约 1 MiB |
| 并发 / 含在途的队列上限 | 4 / 128 个操作 |
| 单次 `read` 输出 | 64 MiB |
| 未完成 `read` 的输出预留 | 会话合计 128 MiB |
| 完整快照 | 会话合计 64 MiB，读取正文前预留 |
| 请求超时 | 默认 15 秒，包含排队与读取正文 |

这些是各组件的保留/在途预算，不是整个浏览器的峰值内存上限。Fetch 内部缓冲、块复制、完整快照哈希、未知长度缓冲扩容以及随后归档/媒体解码均有额外瞬时内存。来源可超过 4 GiB，单个展开资源的 64 MiB 限制仍适用。压缩归档成员可能需要读取整个压缩段；Range 不等于流式解码。

## 身份、验证与剩余工作

本地来源保留原有路径/大小/首尾采样的序列化及哈希，避免迁移已有存档。远程来源以逻辑路径、长度、原始 URL、最终 URL 和固定版本构成身份，计算身份时不额外读取文件首尾。相同来源/版本刷新后可读原存档，版本改变产生新命名空间。链接查询参数、重定向目标或输入文件名改变也可能改变身份；游戏库中的合并与迁移尚未实现。

`tests/conformance/http-range.test.ts` 验证惰性/合并/LRU、超过 4 GiB、协议异常、正文边界、取消、超时和共享预算。`tests/integration/http.test.ts` 使用真实 HTTP 服务与 TJS WASM 验证远程 XP3/ZIP、后续读取、覆盖层和本地身份兼容。`tests/browser/http.spec.ts` 使用另一个端口的真实服务器验证三浏览器双后端的 CORS/预检、画面、刷新存档、版本失效、小文件降级、准备/挂载时取消及错误恢复。

后续的 [OPFS 游戏库](017-game-library.md) 已支持主动完整保存远程来源；按块的持久 HTTP 缓存、断点续传、PWA 外壳离线加载、远程目录/清单 UI、身份迁移及流式媒体仍未实现。当前页面一次添加一个远程文件；多个本地/远程来源可通过播放器 API 一起准备。未验证外部 CDN 或商业游戏集合，测试服务器均运行在本机。

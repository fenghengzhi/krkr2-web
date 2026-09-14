# 视频首帧与媒体时钟

本阶段正在云端验证，不能视为完整视频兼容已经完成。

`VideoOverlay.open` 原先只等待 `loadeddata`。WebKit 的失败记录表明，此时 `readyState` 已为 4，图像读取仍可能得到透明像素；首个时间戳为 0 的帧在之后才提交。如果立刻 seek 到 0.5 秒，`seeked` 和 `currentTime` 可能已经确认目标，而实际图像仍停在初始红色帧。

## 证据与对照

- [34834878908](https://github.com/fenghengzhi/krkr2-web/actions/runs/34834878908) 的两个 WebKit 遮盖用例和 [34836507523](https://github.com/fenghengzhi/krkr2-web/actions/runs/34836507523) 的 Asyncify 用例出现此问题，原始截图与 trace 保留。
- [34837150688](https://github.com/fenghengzhi/krkr2-web/actions/runs/34837150688) 在同一应用上运行 40 次原遮盖案例，25 次通过、15 次失败。失败记录包含 seek 请求、seeked、当前媒体位置、原始解码像素和呈现回调；不是单凭 DOM 属性推断画面。
- [34838225383](https://github.com/fenghengzhi/krkr2-web/actions/runs/34838225383) 只在测试中延迟首次 seek，直到首帧回调。40 次目标帧与像素检查全部通过，完整用例为 39/40。剩余一次在后续区间播放失败：媒体位置已到 1.5 秒，最后的呈现元数据仍为 0.5 秒，旧实现只依赖呈现回调，没有发出经过的周期与区间事件。该运行仍为失败，不当作完整验证通过。
- [34838394481](https://github.com/fenghengzhi/krkr2-web/actions/runs/34838394481) 的隐藏图层对照在首次取样处失败，尚未执行 seek：两个后端的 `loadeddata` 取样均透明，之后的首帧回调取样才为红色。回调能够到达隐藏的图层视频，不能把这次失败说成回调不可用。
- [34838126140](https://github.com/fenghengzhi/krkr2-web/actions/runs/34838126140) 引用了未成功的构建，已取消，没有验证结论。

这些结果支持按首帧就绪建立加载边界，但没有证明浏览器内部所有解码竞态的根因。[requestVideoFrameCallback 文档](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)区分提交呈现的帧与媒体播放时间；回调时机也不提供严格的实时保证。

## 实现

打开视频同时等待数据就绪与首个原生视频帧回调，再把成功返回给脚本。回调在设置来源之前注册，并纳入原有可暂停的请求期限；关闭或停止会取消该回调、定时器及中止监听。没有通过自动播放来预热视频。

帧像素与 `onFrameUpdate` 继续根据实际呈现回调生成。周期事件和区间边界同时由 `timeupdate`、`ended` 与呈现回调检查当前媒体时钟；跨过的周期先派发，再跳回区间起点。区间终点等于总帧数时使用流时长，处理最后一帧之后的边界。正在 seek 的实例不再发起重叠的边界操作，迟到的 ended 通知须仍处于实际结束状态。

新增受控浏览器案例保留真实解码，分别扣住首帧通知和播放后的呈现通知，检查打开仍未完成、停止释放回调、重新导入恢复，以及媒体时钟仍能派发周期与 EOF 区间循环。所有执行均在 GitHub 托管 runner 完成。

## 边界

这不提供无缝、采样精确的区间循环，也不让低频 `timeupdate` 变成高精度计时器。真实帧提交、后台节流、移动端生命周期和旧编码支持仍受浏览器能力及其余未完成工作限制。首帧等待在浏览器停止提交帧时也会等待恢复或按已有期限失败；不返回尚不可读取的图像作为成功。历史 WebKit 暂停位置跳变与 Chromium 初始帧截图问题各自保留，不据本次对照宣称全部根因已解决。

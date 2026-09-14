# 冻结期间的媒体请求期限

GitHub Actions 的真实 Chromium 冻结测试暴露了恢复竞态：Worker 处理 `frozen` 状态时发出 `pauseAll`，页面与 Worker 随后冻结，20 秒请求计时到期。冻结约 21 秒后，超时回调有机会先于排队回复执行，导致会话报 `Audio pauseAll timed out`。独立云端作业三次复现中两次失败，一次通过；日志与可信 freeze/resume 时间记录见 [修复前诊断](https://github.com/fenghengzhi/krkr2-web/actions/runs/34808210462)。

`PausableTimeouts` 为未完成请求保留剩余预算。冻结期间的新请求不启动计时，恢复后才获得原有期限；已完成或取消请求不会被排队的旧计时回调再次触发。Worker 音频/视频请求保留 20 秒预算，主线程 Worklet 与视频事件等待保留 15 秒预算。

EngineSession 在发送暂停命令之前通知传输后端冻结期限；主线程也在分发页面暂停操作前更新音频/视频宿主。仅 `frozen` 和 `away` 暂停期限，普通隐藏、用户暂停及 GPU 暂停继续保留正常的请求超时保护。关闭 Worker 媒体端口时恢复关闭请求的计时，完成后清理所有挂起请求。

新增虚拟时钟测试覆盖剩余期限、冻结中新建/取消请求及过期回调失效；真实 TJS 集成测试检查生命周期通知与媒体命令的顺序。验证只在 GitHub Actions 执行。修复后 346 项 Node、7 项原生生命周期检查已通过；[独立长冻结复测](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809075784) 三次均通过，实际冻结分别约 21,061、21,059、21,053 毫秒，事件均为可信。完整浏览器回归继续执行。原生用例继续要求超过 21 秒的真实冻结、可信事件和 30 秒正文预算。

此修改不改变 TJS ABI 3、字体 ABI 2 或会话协议 9。尚未证明全部媒体加载/seek、BFCache 或操作系统挂起次序；后续仍以实际场景记录为准。

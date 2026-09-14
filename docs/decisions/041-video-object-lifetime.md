# 041 — 视频对象生命周期：实现进行中

本阶段从声音生命周期分支的 `1e5579e` 开始，在独立工作目录推进。完整 VideoOverlay 所有权尚未实现，不能把首批端口修改视为阶段完成。构建、类型检查、测试和浏览器探测只在 GitHub-hosted Actions 运行。

首批修改为 `PortVideoBackend` 增加每次打开操作的独立标记。关闭同一 ID、替换打开、会话取消或 shutdown 撤销标记；元数据读取结束后只有仍有效的请求能发给浏览器宿主。元数据解析和传输使用同一份私有输入副本。shutdown 在等待远端回执前关闭命令入口，多次调用共享同一次关闭操作，待处理回执与定时任务在结束时统一释放。六个新增用例使用真实 MessageChannel 与受控的元数据 Promise，验证请求顺序、输入字节所有权及并发关闭。[首轮完整回归 34896332070](https://github.com/fenghengzhi/krkr2-web/actions/runs/34896332070) 已通过，绑定 `c3b59716960049ef69f27eb1dbfeff62a9ea044f`；该结果仅验证端口首批修改，不代表完整视频所有权阶段已完成。

## 下一步的原生依据

[VideoOvlIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/VideoOvlIntf.cpp) 保留 Window action owner，弱引用视频自身，并向 Window 注册 native 指针；这不等同于 `Window.add`。基础 finalize 为空，资源清理由原生 Invalidate 执行。当前 Web bootstrap 自动 `window.add(this)`，服务永久保留绑定 dispatch，且依赖脚本 finalize 关闭，均待调整。

同一文件的同步与异步状态变化都会取消此前尚未派发的视频事件，frame/period 是立即事件，ended 状态是入队事件。不能直接照搬 Sound 中保留 label 后接 ended 的规则；排队的实际视频事件需要独立持有并在完成或取消后释放。

[VideoOvlImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/visual/win32/VideoOvlImpl.cpp) 的 Disconnect 关闭底层 overlay 并解除 Window 指针，不直接 invalidate VideoOverlay 脚本对象。窗口失效和视频对象失效需要分别处理。其 layer1/layer2 存 native 指针，当前 bootstrap 的强引用与宿主数字 ID 也需要审计和对应的失效处理。

后续应补声音阶段同样的弱 owner、实际事件持有、异步关闭等待和主异常保留，同时验证浏览器视频元素、对象 URL、AudioNode、帧回调、seek/load 等待器与迟到回执的实际释放。当前 WebVideoHost 在加载前发布 Movie 并用 AbortController 取消等待，但创建回滚、关闭期间回执及所有资源清理排列仍需专项验证。窗口断开时的状态与事件行为应结合原生源码和托管对照记录，不宣称全部兼容。

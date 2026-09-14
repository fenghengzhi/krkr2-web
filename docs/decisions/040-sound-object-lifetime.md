# 040 — 声音对象生命周期：实现进行中

独立工作目录已接入声音弱观察、事件持有、异步关闭队列、flags 原生失效、labels 的延后失效队列以及后端迟到解码隔离，验证仍在进行。本文件也保留实现前的审计依据。不能把当前改动、现有音频测试或 [039 的通用宿主观察机制](039-host-object-lifetime.md) 视为声音生命周期阶段已经完成。所有构建、测试和可执行探测只在 GitHub-hosted Actions 运行。

## 当前实现

`SoundService` 只弱观察声音实例，实际进入后台队列的 label、ended、fade 事件各自取得独立句柄，在投递、失败或取消后释放。投递时解析对应的成员，支持排队后替换事件方法。基础 finalize 为空；显式失效的脚本终结器失败时保留资源并允许重试，直接调用 finalize 不关闭资源。实际失效同步撤销源和排队事件，再通过微任务等待正在进行的音频操作并关闭后端资源。Session 执行边界、idle 和 stop 都等待关闭；关闭失败不覆盖已有脚本主异常。

原生桥新增弱 owner 代理和从属对象登记。外部 flags 不保活声音，声音失效后代理拒绝访问；未打开媒体的 flags 写入忽略、读取为零。labels 缓存 Dictionary 在 reopen 时失效，并通过原生登记随 owner 失效；通知只排入待处理队列，后续可挂起的执行边界才运行 Dictionary 终结。先移除登记再执行脚本，避免终结重入；VM 退出则停止脚本终结并释放登记。外部 filters Array 继续有效，插件滤镜执行仍在当前范围之外。

WebAudioHost、PortAudioBackend 和 HeadlessAudioBackend 使用每次创建操作的独立标记，取消与迟到解码不能重新加载已关闭的声音。Headless 的时钟仅在播放、淡出或实时 MIDI 音符仍需推进时运行，空闲时解除任务；新任务能重新启动。AudioWorklet 与 AudioContext 仍归 Session 所有，不能把最后一个声音关闭解释为整个音频设备关闭。

当前新增 82 个真实声音 Session 用例、6 个后端用例、12 个三浏览器音频竞态用例和 28 个从属对象用例。直接运行时入口另接入三浏览器 × 两种 WASM 后端的 168 个从属对象场景，以及源码/编译存储两种加载方式的 60 个真实声音场景。新增场景的最终整体验证尚待报告绑定，不能由用例数量推断通过。

## 托管验证进度

首轮 [Tests 34885096935](https://github.com/fenghengzhi/krkr2-web/actions/runs/34885096935) 绑定 `66bfa5adacba647a198b63e348b40b7317292675`：构建和类型检查通过，651 项浏览器、6 项直接运行时通过，Node 为 679/682，完整运行仍记为失败。82 个新增声音 Session 用例通过；三个失败来自夹具：10 ms 淡出按现有语义同步完成，不应期待后续时钟任务；两个停止 Trigger 的旧预期尚未包含新增的声音/关联对象零值计数。已分别改为检查同步短淡出与实际异步淡出，并保留所有资源字段必须归零的精确断言。原始完整材料与元数据保存在 `out/verification/github-actions/34885096935/`。

同一源码的 [双后端分配诊断 34885263390](https://github.com/fenghengzhi/krkr2-web/actions/runs/34885263390) 已通过原有字节码、执行、集合和弱观察故障检查，归档同样按 run ID 保留；它尚未证明新增关联对象注册和失效队列的全部分配边界。需要进一步专项验证后才能完成本阶段报告。

后续 [分配诊断 34893165714](https://github.com/fenghengzhi/krkr2-web/actions/runs/34893165714) 绑定 `c07f1e532fb97dc0db0270c06fdfe968021ad007`，新增从属对象诊断在两种后端均通过。共 16 组、56 个样本包含各组无故障对照、逐点实际失败与最终无命中样本；24 个实际失败点为注册 16 个、延后 Dictionary 失效 8 个。注册失败不残留登记，恢复后重试成功；延后失效失败返回 `std::bad_alloc`，句柄、登记和待失效数归零，销毁后原生分配账本与对照一致。原始分配大小、栈、边界计数及元数据保存在对应 run 归档。

[独立宿主句柄诊断 34894031736](https://github.com/fenghengzhi/krkr2-web/actions/runs/34894031736) 与 [独立对象诊断 34894027615](https://github.com/fenghengzhi/krkr2-web/actions/runs/34894027615) 也已通过。最终报告将核对这些运行与最终应用源码、各自测试源码和产物的一致性。

## 实现前审计与设计依据

以下“当前”和“计划”指实现前审计时的状态，保留原始依据与设计边界；当前代码状态以本文件上半部分为准。

当前 `src/engine/media/sounds.ts` 在创建时强持有绑定实例的 dispatch，`src/engine/tvp/sound.ts` 依赖脚本 finalize 调用 Sound.destroy。这会阻止隐式析构，也会遗漏不调用 super 的子类清理；直接调用 finalize 又过早关闭资源。原始 [SoundBufferBaseIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/SoundBufferBaseIntf.cpp) 将非持有 Owner 与强持有 ActionOwner 分开，native Invalidate 禁止事件、取消队列并释放 ActionOwner。[WaveIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/WaveIntf.cpp) 和 [MIDIIntf.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/MIDIIntf.cpp) 都注册空的基础 finalize。实际停止播放及释放解码、线程或 MIDI 资源位于 [WaveImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/WaveImpl.cpp) 与 [MIDIImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/MIDIImpl.cpp) 的 native Invalidate 链。

计划让 `Sound.create(kind, this)` 注册弱 owner，保留实例自身对用户 action owner 的强引用。基础 finalize 为空，成功失效和实际析构由 native observer 通知服务；显式 finalize 抛错时保留声音资源，支持重试。直接 `.finalize()` 不等于 invalidate，子类 `super.finalize()` 后抛错也不能提前关闭声音。用户主动制造的引用环及 action owner 的真实所有权沿用 TJS2 引用计数，不引入任意对象环回收。

每个实际入队的后台 label、ended、fade 事件独立 upgrade 一份强句柄，动态调用对应的 onLabel、onStatusChanged、onFadeCompleted，在投递完成、失败或取消后释放。声音注册表不能成为永久强根，也不能把正在排队或暂停执行的对象提前释放。每个声音需要独立的 queue source，失效或取消时实际移除队列任务；仅改变 version 会让已失效任务继续占据队列和句柄。同步状态变化取消此前事件，异步 SetStatusAsync 则保留此前 label，避免破坏 label 后接结束事件的顺序。Sound.call 返回的同步回调继续在原 TJS 栈执行，与后台队列区分；宿主清理通知不得执行这些回调。

声音关闭需要独立的、可等待的资源清理队列。observer 同步撤销注册、增加 version、unobserve、取消事件并登记关闭任务，之后通过微任务启动后端操作。不能在 observer 内直接调用看似异步的 backend.command：async 函数在首次 await 前仍同步执行，当前 HeadlessAudioBackend.command 会 advance 并发出其他声音事件。Session 的执行边界、idle 和 stop 需要等待清理完成，已有脚本主异常不能被关闭失败覆盖；通知本身也不能等待或重新进入 TJS。

每个声音需记录资源创建请求和进行中的操作。open/create 发起前就记录可能拥有后端资源，不能仅依赖成功后设置的 ready。失效后的清理应覆盖失败或迟到的创建，阻止旧结果重新发布声音状态。超时不证明底层解码已经结束：WebAudioHost 可在异步 decode 尚未完成时处理 close，随后旧 decode 再 load 同一 id。需在实际执行异步解码的后端用每个 id 的 generation 或关闭标志拒绝旧结果，服务层等待一个已经超时的 Promise 不能单独解决这个竞态。

当前 HeadlessAudioBackend 在收到任意命令后每 20ms 唤醒，即使最后一个 mixer voice 已经 close，也要等整个 backend.close 才停止。后续应根据实际声音/淡出工作停止空闲时钟，并保证新工作能重新启动；只验证 SoundService 表为空，不能证明后台任务已经释放。原始 [SoundBufferBaseImpl.cpp](https://github.com/krkrz/krkr2/blob/master/kirikiri2/branches/2.32stable/kirikiri2/src/core/sound/win32/SoundBufferBaseImpl.cpp) 的全局声音计时器在最后一个注册声音移除时释放。

flags、labels 与 filters 不能使用相同的所有权规则：

- WaveFlags 的原生 Construct 只保存 Buffer 原始指针，不持有 Sound。外部保留 flags 不应让声音保活。计划为 HostProxy 增加可选的弱 owner 绑定，在资源失效后安全拒绝访问；不能通过强引用延长声音生命周期掩盖陈旧指针。
- 原始 krkr2 stable/trunk 与 [krkrz WaveIntf.cpp](https://github.com/krkrz/krkrz/blob/master/sound/WaveIntf.cpp) 都有可见缺口：BaseWaveSoundBuffer::Invalidate 的注释提到 flags，实际调用 RecreateWaveLabelsObject，未对 WaveFlagsObject 执行 Invalidate/Release。原代码无法证明 Sound 删除后的 flags 有明确安全契约。上述过期代理处理是拟定的安全行为，需要明确记录，不能谎称已经通过原生对照。
- [官方 flags 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_WaveSoundBuffer_flags.html) 规定未打开媒体时忽略写入，open 重置全部值，count 固定为 16；原属性实现无 LoopManager 时读取 0。当前服务会保存未 ready 时的写值，存在明确差异。淡出可能创建没有媒体的 voice，所以判断媒体是否打开不能只用 ready。flags 应保持对象身份，并与每次 open 的数据重置区分。
- filters 是普通 Array；声音释放自己持有的引用，外部保留的 Array 应继续有效。实际插件滤镜处理不属于当前非插件目标，数组及其中对象的引用语义仍需正确。
- labels 原生在重建与失效时 invalidate 缓存 Dictionary；当前 bootstrap 只清除缓存字段，外部旧 Dictionary 仍有效。这是独立的生命周期差异，需要后续实现和对照，不能被 flags 代理改动自动覆盖。[官方 labels 文档](https://krkrz.github.io/krkr2doc/kr2doc/contents/f_WaveSoundBuffer_labels.html) 说明返回嵌套字典，并要求将其视为只读数据。

构造路径需要事务式回滚：观察注册失败不留下服务条目；注册后 flags 代理分配或子类构造失败，由 native observer 清理可能已创建的资源并保留构造主异常。原生 constructor 会立即将 action 参数转换为对象闭包，当前 bootstrap 仅拒绝 void、仍接受数字等参数，参数检查也需要修正。当前 __SoundBase 还向 MIDI/CDDA 暴露 Wave 专用的 flags、labels、filters；本设计没有把这些扩展行为认定为已符合原生类接口。

计划增加独立于产品 UI snapshot 的声音源数、待关闭任务数，并结合实际 mixer voice 数、关闭命令、时钟任务、native objects 和句柄数验证。GitHub 托管用例应覆盖无媒体/播放/淡出声音的隐式析构，no-super 与失败 finalize 重试，后台事件成为最后所有者，动态方法替换，排队取消、暂停与恢复，构造失败，外部保留 flags/labels/filters，关闭失败及迟到解码。正常声音生命周期测试还需与现有同步回调、SLI label、MIDI 播放及整场停止检查共同运行；尚无本阶段通过结论。

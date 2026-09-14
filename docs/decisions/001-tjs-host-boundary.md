# TJS2 host boundary

The first implementation keeps the TJS interpreter/compiler in one WASM instance per session Worker. TypeScript owns storage lookup, layer state and browser adapters. C++ only provides the VM ABI and native dispatch bridge.

The bridge uses tagged values and retained closure handles rather than JSON. Host replies can carry a value, error, script to execute, or callback with arguments. Nested scripts and callbacks are executed by C++ after the asynchronous JS import has returned. This avoids suspending intervening JavaScript frames during a nested read.

There are two builds from the same sources:

- JSPI uses native WASM exceptions and promising execution exports.
- Asyncify uses Emscripten's JavaScript exception handling. The installed Emscripten 6.0.9 warns that Asyncify mixed with native WASM exceptions is not generally compatible; the fallback therefore uses `-fexceptions` and `DISABLE_EXCEPTION_CATCHING=0`.

Host object releases are queued until a native execution boundary. The C++ bridge explicitly clears values outside container destructors so throwing finalizers can be handled by the execution error wrapper. Final whole-VM teardown suppresses user finalizers; explicit script invalidation during execution remains supported. See the [current behavior](../compatibility/current.md).

Budget checkpoints yield the Worker event loop without pthreads or SharedArrayBuffer. Pause, resume and cancellation change the session control gate while the VM is suspended. The caller cannot start a second VM execution concurrently. The session's serial queue orders script commands, while cancellation and read completions bypass that queue.

Ordinary Worker RPC convenience imports remain available for future stateless codec jobs. A game session uses `createRpcClient`/`exposeRpc` from the existing plugin's public runtime with `pool: 1`, so it can explicitly dispose the client and create a fresh Worker after stopping or failure.

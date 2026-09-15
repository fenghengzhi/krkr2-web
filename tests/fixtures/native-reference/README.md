# Original SDK modal observations

These fixtures execute only through `original-runtime.yml` on GitHub-hosted
Windows 2022 and Windows 2025 runners. They load the pinned executable from the
[official 2.32r2 distribution](https://krkrz.github.io/), create only their own
Windows and Timers, and use no external input or plugins. Each process has a
30-second deadline. Completion reports observed events; it does not declare an
unknown native ordering correct or count as a Web runtime test.

The executable is passed an explicit project directory, as documented by the
SDK's `Startup.html`. Its working directory alone does not select the project.
`-forcelog=yes`, arguments, fixture bytes, hashes, engine version, stdout/stderr,
native log, event log and terminal status are retained as hosted artifacts.

## Preserved runs

- [34991235952](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991235952),
  `ddcdd2a`: both processes exceeded the deadline without producing script
  observations. The missing project argument was a launcher error. This run
  remains failed and provides no evidence about modal behavior.
- [34992096141](https://github.com/fenghengzhi/krkr2-web/actions/runs/34992096141),
  `7810f93580fc5c6e33b17c950506e438bd4228a0`: both runners completed the baseline
  observation with identical event ordering. `close()` returned before the
  corresponding `onCloseQuery`. The first query vetoed closure; the second
  accepted it. `showModal()` returned `void`; the Window remained valid and was
  hidden. The archived engine file version is `2.32.2.426`; this does not identify
  its exact source commit or VCL build.

## Scenarios

- `modal-close`: timer-initiated close, veto, then acceptance.
- `modal-accepted-reclose`: query accepts closure and immediately calls `close()`
  again before returning. A second query vetoes if delivered; a third timer tick
  requests a recovery close if the modal is still waiting. Event values remain
  observations rather than predeclared assertions.
- `modal-hidden-timer`: first timer tick hides the modal; a second tick attempts
  closure if the modal is still waiting. The event log distinguishes early
  return from continued hidden execution.
- `modal-parent-child`: the parent query accepts closure and opens a child modal
  before returning. A later timer closes the child and records both returns.

Each scenario runs in its own process so a failure cannot hide the other
scenarios. No hardware input, menu notifications, browser behavior or native
plugin behavior is covered by these fixtures.

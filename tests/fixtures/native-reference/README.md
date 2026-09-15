# Original SDK modal observations

These fixtures execute only through `original-runtime.yml` on GitHub-hosted
Windows 2022 and Windows 2025 runners. They load the pinned executable from the
[official 2.32r2 distribution](https://krkrz.github.io/), create only their own
Windows and Timers, and use no external input or plugins. Each process has a
30-second deadline. Completion reports observed events; it does not declare an
unknown native ordering correct or count as a Web runtime test.

The executable is passed an explicit project directory, as documented by the
SDK's `kirikiri2/kr2doc/contents/Startup.html`, before its `content-data`, archive
and `data` fallbacks. Its working directory alone does not select the project.
`CommandLine.html` documents `-forcelog=yes`. Arguments, fixture bytes, hashes,
engine version, stdout/stderr, event log and terminal status are retained as
hosted artifacts, together with any top-level `.log` or `.txt` the engine emits.
The baseline success produced no separate native console log.

## Preserved runs

- [34991235952](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991235952),
  `ddcdd2a`: both processes exceeded the deadline without producing script
  observations, stdout or stderr. Both verified the pinned archive and engine
  and started version `2.32.2.426`. The missing project argument was a launcher error. This run
  remains failed and provides no evidence about modal behavior.
- [34992096141](https://github.com/fenghengzhi/krkr2-web/actions/runs/34992096141),
  `7810f93580fc5c6e33b17c950506e438bd4228a0`: both runners completed the baseline
  observation with identical event ordering. `close()` returned before the
  corresponding `onCloseQuery`. The first query vetoed closure; the second
  accepted it. `showModal()` returned `void`; the Window remained valid and was
  hidden. The archived engine file version is `2.32.2.426`; this does not identify
  its exact source commit or VCL build.
- [34992643111](https://github.com/fenghengzhi/krkr2-web/actions/runs/34992643111),
  `806dc3f453d3f66ae35deb792d998300cdc84067`: three observations completed,
  four processes timed out, and one script reported an invalidated object. All
  eight event logs are preserved. Timer-count sequencing was invalid: multiple
  timer callbacks can precede a query, coalescing close requests, and the child
  could be closed before it entered its modal. The hidden cases on both runners
  executed a timer after hiding and returned from `close()` without a delivered
  query or modal return before their deadlines. They remain failed observations.
  The correction gates the next action on an actual query or child entry and
  explicitly supplies the hidden window's final answer to end that observation.
  This correction remains unverified until its hosted run completes.

## Scenarios

- `modal-close`: timer-initiated close, veto, then acceptance.
- `modal-accepted-reclose`: query accepts closure and immediately calls `close()`
  again before returning. A second query vetoes if delivered and arms a later
  timer recovery close if the modal is still waiting. Event values remain
  observations rather than predeclared assertions.
- `modal-hidden-timer`: first timer tick hides the modal; a second tick attempts
  closure if the modal is still waiting. A third tick supplies an explicit query
  answer if still waiting, so an undelivered hidden close need not leave the
  observation open. The log distinguishes this explicit answer from the earlier
  close request and from any query it might have delivered.
- `modal-parent-child`: the parent query accepts closure and opens a child modal
  before returning. A later timer closes the child and records both returns.

Each scenario runs in its own process so a failure cannot hide the other
scenarios. No hardware input, menu notifications, browser behavior or native
plugin behavior is covered by these fixtures.

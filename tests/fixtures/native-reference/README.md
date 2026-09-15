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
- [34993108821](https://github.com/fenghengzhi/krkr2-web/actions/runs/34993108821),
  `6fed67b404a2927845362c96abc6ff6941b82637`: all eight observations completed
  (four scenarios on each runner). Each scenario's entire event list was
  identical across the two runners. All 48 artifact files, terminal metadata,
  workflow log and per-file hashes are archived; earlier failures remain failed.

## Observed ordering

| Scenario         | Recorded result on both runners in `34993108821`                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline         | Each `close()` returned before its query. Veto kept waiting; acceptance returned `void`, hid the Window and left it valid.                                                                                                                                              |
| Accepted reclose | Accepting query 1 and then calling `close()` in the same callback produced query 2. Its veto kept the modal waiting until a later recovery close produced accepting query 3.                                                                                            |
| Hidden timer     | Hiding kept the modal active; ticks 2 and 3 ran while invisible. The hidden `close()` returned without a query before tick 3. The only query then logged was the fixture's explicitly marked `onCloseQuery(true)` call; after that the modal returned valid and hidden. |
| Parent and child | The parent accepted closure and continued into child `showModal()`. The child returned before the parent query returned; the parent was still visible at that point. The parent modal then returned. Both windows remained valid and hidden.                            |

The earlier two 30-second hidden timeouts additionally observed no delivered
query after the hidden close. The successful finite observation does not assert
that a hidden query can never arrive under every possible host condition. No
reshow or subsequent hidden-close recovery behavior has been observed here.

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

## Owned keyboard menu observations

The workflow's `menu` suite selects eight independent scenarios: flags `0`,
`tpmNoNotify` (`128`), `tpmReturnCmd` (`256`) and both (`384`), each with target
selection or Escape cancellation. The `modal` suite remains the default.

The official SDK documents popup's Window menu-tree requirement and client
coordinates. Fixed `2.32stable` native source exposes read-only `Window.HWND` and
`MenuItem.HMENU` properties without requiring a plugin. The fixture publishes
these handles and a random owner caption. The hosted driver verifies the HWND's
PID against the held engine process, its exact caption, the owner's actual menu
tree, two exact leaf captions and independently read command IDs before posting
any input. `GetGUIThreadInfo` always uses that explicit nonzero thread ID and
must show its owned active popup.

The driver uses only owned-HWND `PostMessageW` key pairs. Selection has at most
two Down presses and requires an actual `MF_HILITE` target before a single
Enter. Cancellation sends one Escape. There is no fallback Escape for failed
selection, no `WM_COMMAND` synthesis, no hook, injected code, `SendInput` or
foreground manipulation. A terminal key delivered to the script's ordinary
Window handler invalidates the menu-input evidence. An unverified input path is
`not-executable`, never a successful cancellation or selection.

Each popup has a 3-second observation budget; the complete held process has a
30-second budget. The TJS script records before/after, raw return and target/other
onClick counts, then observes at least 600 ms after return using its own Timer.
The unknown NoNotify callback count is recorded, not compared with a Web
implementation expectation. Selection with ReturnCmd must identify the actual
target command; cancellation must not produce selection evidence. Other return
and callback values remain observations. This protocol proves bounded posted
keyboard behavior; it does not cover physical keyboard input, mouse input,
recursive menus or command-ID allocation beyond these actual leaves.

The first menu run,
[34995723956](https://github.com/fenghengzhi/krkr2-web/actions/runs/34995723956)
at `770ecfa0e67e361ad161aafc0b67c58a8e6bb2b7`, remains failed: 9 observations
completed and 7 input paths were marked not executable. Three Windows 2022
selection attempts posted two Down presses before any highlight was observed;
they never sent Enter or fallback Escape. Four other cases recorded menu exit
and complete native logs, but a later unnecessary HWND ownership read raced the
engine's own window destruction. Their failed driver statuses are preserved.
All 112 files from the 16 original artifacts are archived with terminal metadata,
workflow log and hashes.

The corrected driver waits for an actual highlight transition before advancing
its bounded navigation and stops all UI reads after observed menu exit. It keeps
the same two-Down, one-terminal-key and 3-second budgets. This correction is not
verified until a subsequent hosted run completes.

One already completed case in that failed run is Windows 2025's NoNotify-only
selection: the actual target was highlighted, Enter was posted to the owned
popup, the raw return was `1`, and one target onClick was recorded after return.
This confirms that concrete original-SDK posted-keyboard counterexample without
turning the seven incomplete observations or the whole run into a pass.

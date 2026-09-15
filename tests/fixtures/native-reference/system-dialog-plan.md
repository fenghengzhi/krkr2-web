# Original SDK System dialogs: bounded observation plan

The pinned 2.32r2 executable and archive hashes remain unchanged. All execution
uses GitHub-hosted Windows 2022 and Windows 2025 through `original-runtime.yml`.
No local probe, plugin, injected code, hook, foreground manipulation or global
input is involved. Product source files are outside this task.

## Minimum matrix

Each of four scenarios has its own engine process and random dialog caption:

1. `inform`: record the call, observe its real owned dialog for 800 ms, activate
   its real OK button, and record whether the result is void.
2. `input-unicode`: replace the real owned Edit's text with `Hello 雪 Ω 😀`, read
   back the control text, activate OK, and record the exact native return.
3. `input-empty`: replace the Edit's initial text with an empty string and click
   OK, keeping empty confirmation distinct from cancellation.
4. `input-cancel`: preserve the initial text and click the real Cancel button,
   recording whether the native result is void.

A TJS Timer runs every 100 ms. The driver records its event count when the actual
dialog is identified and immediately before clicking the button after the
800 ms observation interval. A positive delta proves Timer execution while that
dialog was present. Zero means no callback was observed during this bounded
interval, not a general impossibility result.

## Input evidence

The driver first filters HWNDs by the held engine PID, then requires the exact
random caption and random prompt text. It records the actual dialog/control
classes, IDs, text, parent/root relation and thread identity. Each targeted
control must still belong to that same dialog and PID immediately before use.
Only a real enabled/visible Edit may receive `WM_SETTEXT`; only a real enabled
push button may receive `BM_CLICK`. `SendMessageTimeout` bounds these directed
control messages. No `WM_COMMAND`, keyboard or mouse input is synthesized.

The resulting TJS return supplies the handler evidence: confirmation must return
a string; cancellation must return void. Unknown text conversion is retained as
data. The fixed native `InputQuery` path converts through `AnsiString`, so Unicode
loss in the SDK must not become a Web implementation requirement. Desired text,
control readback and native returned text are recorded separately.

The popup/control phase has a 3-second budget and the held process has a
30-second budget. Identity, control or handler failures remain `not-executable`.
All logs, partial results, generated fixture bytes, driver bytes, hashes and
terminal statuses are retained. A failed attempt may justify a bounded fixture
correction, while preserving that failed attempt. Nested dialogs are excluded
from this minimum matrix; no result for them is implied.

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
random caption. For the MessageBox it also requires the real Static prompt text;
the VCL InputQuery prompt may be a windowless label, so its availability is
recorded rather than guessed. InputQuery additionally requires exactly one Edit
and identifiable OK/Cancel push buttons. It records the actual dialog/control
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

Microsoft documents [BM_CLICK](https://learn.microsoft.com/en-us/windows/win32/controls/bm-click)
as invoking the button's normal click notifications and gives it no return value.
The driver therefore uses the native TJS result to confirm the chosen handler;
it does not treat a zero button-message result as failure. It does not activate
an inactive dialog to force a click. Edit input uses
[WM_SETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settext),
with directed messages bounded by
[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw).

## Preserved first attempt and correction

[35001453121](https://github.com/fenghengzhi/krkr2-web/actions/runs/35001453121)
at `4b2f88c0b9459194b866a11ab45e5922d11dd7ad` remains failed: two inform
observations completed, and six input observations were not executable. Four
early `WM_GETTEXT` reads timed out; two other attempts found an ANSI VCL `TForm`
with a default `TButton` captioned `OK`, a non-default `TButton` captioned
`?????`, and one `TEdit`. No input was sent in any failed input scenario. All
56 original artifact files and terminal evidence are preserved.

The completed inform cases prove TJS Timer execution while the real MessageBox
was present: Windows 2022 recorded 4 ticks at discovery and 12 before clicking
(+8 over 812 ms); Windows 2025 recorded 6 and 13 (+7 over 818 ms). Both returned
void after the actual OK button was clicked.

The corrected driver performs its 800 ms observation before reading controls,
and individual directed messages use at most 300 ms of the unchanged 3-second
case budget. It retains control identities even when a subsequent text read
fails. Only for the exact recorded two-`TButton` InputQuery shape, the
non-default `?????` button opposite the explicit default `OK` may be selected
as a cancellation candidate. That name is not assumed to mean Cancel: the
original handler must return void after its real `BM_CLICK` before the scenario
is recorded as observed. The correction has not yet been executed.

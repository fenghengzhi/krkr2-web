# Original TVP messages

`MsgIntf.h` and `MsgImpl.h` are unchanged CP932 source bytes from KRKR2's
2.32stable branch at commit `dec49af97e174d31059c3ccd7efc700ba3c6b788`.
`manifest.json` records their original URLs, lengths and SHA-256 values.
`LICENSE.original.txt` is the license from the same pinned branch.

The hosted build runs `scripts/generate-tvp-messages.py --check`. That source
transcription preserves the literal Japanese default expressions, including
compile-time `__DATE__` and `__TIME__`, in `include/TvpMessages.generated.inc`.
It also produces the internal TypeScript ID inventory in
`src/engine/system/tvp-message-ids.ts`; it does not create a second translated
message dictionary. There are 138 assignable holders and six constants.

The private native formatter reads the current holder and implements the
original zero/one/two-argument overload distinction. It scans only the template;
replacement text is never rescanned. Exact sizing and the existing 16 MiB
native temporary-allocation budget replace the original overflow-prone buffer
size estimate. This is a per-format allocation guard, not a total heap bound.
NUL-terminated result semantics remain intact. The existing native string-value
transport itself truncates JS arguments at NUL before formatting; this boundary
is unchanged. No script is invoked, no pending
VM cleanup is drained, and no new public TJS member is introduced.

The catalog includes original registered IDs referring to plugins or native
facilities so `System.assignMessage` has the original namespace. Their presence
does not advertise or implement those facilities. Real supported engine
exceptions use typed IDs and the native formatter; Web-only budget, cancellation
and unsupported-facility diagnostics remain separate.

# Original SDK observations

This workflow executes only the pinned SDK engine on GitHub-hosted Windows runners.
It does not run on the developer's computer or establish compatibility by itself.
The script loads no plugins; each process has an isolated temporary directory and
a 30-second deadline. Observation completion and semantic assertions are separate.

The official SDK's `kirikiri2/kr2doc/contents/Startup.html` says an explicit folder
argument selects the project, followed by `content-data`, archives and `data`.
The executable's working directory containing `startup.tjs` is not sufficient.
`CommandLine.html` documents `-forcelog=yes` for preserving console messages.
These files are included in the archive pinned by `sdk.json`.

## Preserved attempts

- [34991235952](https://github.com/fenghengzhi/krkr2-web/actions/runs/34991235952),
  `ddcdd2a`: both Windows 2022 and 2025 verified the archive and engine hashes,
  started engine version 2.32.2.426, then hit the owned-process deadline. Neither
  emitted script observations, stdout or stderr. No modal behavior was observed.
  The launcher had not passed a project folder. The correction supplies the
  documented folder argument and enables console logging; its result remains
  unverified until a subsequent hosted run completes.

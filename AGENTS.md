# Repository instructions

- Run all tests and executable verification probes on GitHub-hosted GitHub Actions runners.
- Do not run tests, Playwright, browser probes, or `npm run check` on the local machine. Do not use a self-hosted runner on the user's machine.
- Local source inspection and editing are allowed. Push to the configured repository, inspect the Actions results, and make fixes based on those results.
- Preserve historical verification evidence. An interrupted run or a workflow that has not run is not a passing result.

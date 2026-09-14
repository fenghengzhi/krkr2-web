#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUNNER_OS:-}" == Linux ]]; then
  exec xvfb-run -a -s '-screen 0 1920x1600x24' "$@"
fi
exec "$@"

#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUNNER_OS:-}" == Linux ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]; then
    mkdir -p out/ci
    export KRKR_CI_DISPLAY_LOG_DIR
    KRKR_CI_DISPLAY_LOG_DIR=$(mktemp -d "$PWD/out/ci/display.XXXXXXXX")
    date -u '+%Y-%m-%dT%H:%M:%S.%NZ wrapper-start' > "$KRKR_CI_DISPLAY_LOG_DIR/wrapper.log"
    # Keep observer source with its evidence, and preserve the command's original stdin.
    cat > "$KRKR_CI_DISPLAY_LOG_DIR/observe.py" <<'PY'
import datetime
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time

output = pathlib.Path(os.environ['KRKR_CI_DISPLAY_LOG_DIR'])
write_lock = threading.RLock()
record_error = False

def warn(error):
    try:
        print(f'Display diagnostics: {error}', file=sys.stderr, flush=True)
    except OSError:
        pass

try:
    timeline = (output / 'timeline.jsonl').open('a', buffering=1)
except OSError as error:
    timeline = None
    warn(error)

def record(event, **details):
    global record_error
    with write_lock:
        if timeline is None or record_error:
            return
        try:
            timeline.write(json.dumps({
                'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'monotonicNs': time.monotonic_ns(), 'event': event, **details,
            }) + '\n')
        except OSError as error:
            record_error = True
            warn(error)

display = os.environ.get('DISPLAY', '')
record('display-wrapper-entered', display=display, command=sys.argv[1:],
       runId=os.environ.get('GITHUB_RUN_ID'), attempt=os.environ.get('GITHUB_RUN_ATTEMPT'),
       passiveSampleMs=100, heartbeatMs=1000)

def connection_check(phase):
    # Only after the command: even a preflight X client could cause a last-client reset.
    try:
        check = subprocess.run(['xdpyinfo', '-display', display], capture_output=True,
                               text=True, timeout=2)
        (output / (phase + '-xdpyinfo.log')).write_text(check.stdout + check.stderr)
        record('connection-check', phase=phase, exitCode=check.returncode)
    except (OSError, subprocess.TimeoutExpired) as error:
        record('connection-check', phase=phase, error=str(error))

def state():
    result = {}
    number = re.fullmatch(r':(\d+)(?:\.\d+)?', display)
    if not number:
        return {'unsupportedDisplay': display}
    socket = pathlib.Path('/tmp/.X11-unix/X' + number[1])
    lock = pathlib.Path('/tmp/.X' + number[1] + '-lock')
    for label, path in [('socket', socket), ('lock', lock), ('serverLog', output / 'xvfb.log')]:
        try:
            info = path.stat()
            result[label] = {'inode': info.st_ino, 'mode': info.st_mode,
                             'size': info.st_size, 'mtimeNs': info.st_mtime_ns}
        except OSError as error:
            result[label] = {'error': str(error)}
    try:
        pid = int(lock.read_text().strip())
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        result['server'] = {'pid': pid, 'state': fields[0], 'parentPid': int(fields[1]),
                            'startTicks': int(fields[19])}
    except (OSError, ValueError, IndexError) as error:
        result['server'] = {'error': str(error)}
    return result

stop = threading.Event()

def observe():
    previous, last = None, 0
    while not stop.is_set():
        current = state()
        now = time.monotonic()
        if current != previous or now - last >= 1:
            record('passive-display-state', state=current)
            previous, last = current, now
        stop.wait(0.1)

record('passive-display-state-initial', state=state())
observer = threading.Thread(target=observe, daemon=True)
try:
    observer.start()
except RuntimeError as error:
    record('observer-start-error', error=str(error))
received_signals = []
try:
    command = subprocess.Popen(sys.argv[1:])
except OSError as error:
    status = 127
    record('command-launch-error', error=str(error))
else:
    record('command-start', pid=command.pid)

    def forward(signum, frame):
        # Defer file writes until wait returns; signals can interrupt an in-progress write.
        received_signals.append({'signal': signum, 'receivedMonotonicNs': time.monotonic_ns()})
        if command.poll() is None:
            try:
                command.send_signal(signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    status = command.wait()
    for received in received_signals:
        record('wrapper-signal', **received)
    record('command-exit', returnCode=status)
finally:
    stop.set()
    if observer.is_alive():
        observer.join()
    record('passive-display-state-final', state=state())
connection_check('after-command')
if timeline is not None:
    try:
        timeline.close()
    except OSError as error:
        warn(error)
sys.exit(status if status >= 0 else 128 - status)
PY
    # Keep the original server options: diagnostics must not change X reset behavior.
    if xvfb-run -a -e "$KRKR_CI_DISPLAY_LOG_DIR/xvfb.log" -s '-screen 0 1920x1600x24' \
      python3 "$KRKR_CI_DISPLAY_LOG_DIR/observe.py" "$@"
    then
      krkr_command_status=0
    else
      krkr_command_status=$?
    fi
    date -u '+%Y-%m-%dT%H:%M:%S.%NZ wrapper-end' >> "$KRKR_CI_DISPLAY_LOG_DIR/wrapper.log" || true
    printf 'exitCode=%s\n' "$krkr_command_status" >> "$KRKR_CI_DISPLAY_LOG_DIR/wrapper.log" || true
    exit "$krkr_command_status"
  fi
  exec xvfb-run -a -s '-screen 0 1920x1600x24' "$@"
fi
exec "$@"

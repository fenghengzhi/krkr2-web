"""Run the pinned original Windows sound project on a hosted Wine audio endpoint."""
import hashlib
import io
import json
import os
import shutil
import sys
from pathlib import Path
import subprocess
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile


def checked_bytes(data, size, digest, label):
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Pinned {label} differs in size or SHA-256")
    return data


def main():
    if (os.environ.get("GITHUB_ACTIONS"), os.environ.get("RUNNER_ENVIRONMENT"), os.environ.get("RUNNER_OS")) != (
        "true", "github-hosted", "Linux",
    ):
        raise RuntimeError("Original sound comparison requires GitHub-hosted Linux")
    output = Path("out/verification/original-sound-wine").resolve()
    game = output / "game"
    pin = json.loads(Path("tests/fixtures/native-reference/sdk.json").read_text())
    state = {"commit": os.environ["GITHUB_SHA"], "state": "not-run", "exitCode": None,
             "host": "Wine / PulseAudio", "timedOut": False}
    try:
        if not (game / "startup.tjs").is_file() or (game / "native-events.txt").exists():
            raise RuntimeError("Expected a freshly prepared original sound project")
        with urlopen(pin["url"], timeout=45) as response:
            archive = checked_bytes(response.read(pin["archiveBytes"] + 1),
                                    pin["archiveBytes"], pin["archiveSha256"], "SDK archive")
        with ZipFile(io.BytesIO(archive)) as sdk:
            executable = checked_bytes(sdk.read(pin["engineMember"]), pin["engineBytes"],
                                       pin["engineSha256"], "SDK executable")
        state.update(engineSha256=pin["engineSha256"], archiveSha256=pin["archiveSha256"],
                     wineVersion=subprocess.check_output(["wine", "--version"], text=True).strip())
        state["defaultSink"] = subprocess.check_output(["pactl", "get-default-sink"], text=True).strip()
        if state["defaultSink"] != "krkr_sdk_output":
            raise RuntimeError("The original engine requires the configured software audio output")
        directory = Path(tempfile.mkdtemp(prefix="krkr-sound-", dir=os.environ["RUNNER_TEMP"]))
        engine = directory / "krkr.exe"
        env = {**os.environ, "WINEARCH": "win32", "WINEPREFIX": str(directory / "prefix"),
               "WINEDLLOVERRIDES": "mscoree,mshtml=", "WINEDEBUG": "fixme-all"}
        with (output / "wine.log").open("wb") as log:
            def run(command, timeout, check=True):
                return subprocess.run(command, env=env, cwd=game, stdout=log, stderr=subprocess.STDOUT,
                                      timeout=timeout, check=check)
            try:
                engine.write_bytes(executable)
                run(["wineboot", "--init"], 120)
                run(["wineserver", "-w"], 60)
                run(["wine", "reg", "add", r"HKCU\Software\Wine\Drivers", "/v", "Audio",
                     "/d", "pulse", "/f"], 30)
                project = subprocess.check_output(["winepath", "-w", str(game)], env=env,
                                                  stderr=log, timeout=30, text=True).strip()
                state["state"] = "running"
                result = run(["wine", str(engine), project, "-forcelog=yes"], 45, check=False)
                state["exitCode"] = result.returncode
                result.check_returncode()
                if not (game / "native-events.txt").is_file():
                    raise RuntimeError("The original executable exited without observations")
                state["state"] = "observed"
            finally:
                primary_error = sys.exc_info()[0] is not None
                try:
                    try:
                        run(["wineserver", "-w"], 3)
                    except subprocess.TimeoutExpired:
                        run(["wineserver", "-k"], 15)
                        run(["wineserver", "-w"], 15)
                    state["prefixRetired"] = True
                    shutil.rmtree(directory)
                except Exception as cleanup:
                    state["cleanupError"] = str(cleanup)
                    if not primary_error:
                        raise
    except Exception as error:
        state["state"] = "failed"
        state["error"] = str(error)
        state["timedOut"] = isinstance(error, subprocess.TimeoutExpired)
        raise
    finally:
        output.mkdir(parents=True, exist_ok=True)
        (output / "sdk-process.json").write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    main()

"""Author a normal mixed-mode game disc on a GitHub-hosted Linux runner.

The pinned cue2ccd 1.1.0 source writes CCD/IMG/SUB. The input is the independently
authored boot-source.iso plus deterministic stereo PCM, packed into ordinary
MODE1/2352 sectors here. bchunk independently extracts the complete ISO and WAV
again. No production reader participates in authoring or either comparison.
"""
from pathlib import Path
import configparser
import hashlib
import json
import os
import struct
import subprocess
import tarfile
import tempfile
import urllib.request
import wave


if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise RuntimeError("CloneCD authoring requires a GitHub-hosted runner")

ROOT = Path("out/verification/clone-cd-game").resolve()
ROOT.mkdir(parents=True, exist_ok=True)
LOGS = ROOT / "logs"
LOGS.mkdir(exist_ok=True)
PIN = "aa74f53b6d211e4ac844bd7c8fb2b69ea482669d"
SOURCE_URL = f"https://codeload.github.com/mistydemeo/cue2ccd/tar.gz/{PIN}"
SOURCE_SHA = "9d9ef46eec8671a01556a84ce0b1da9de0ab55654992477fda370994af1f8d93"
LOCK_SHA = "b53c2a654dfdf5d2a3ad570af78bf981f3f3d94cbf4a9a8c0456ebbbe2e7b7a9"
STEM = "boot-clonecd-source"
AUDIO_SECTORS = 300
SAMPLES = [
    {"frame": 0, "left": 8192, "right": -16384},
    {"frame": 24, "left": 8192, "right": -16384},
    {"frame": 25, "left": 8192, "right": 16384},
    {"frame": 49, "left": 8192, "right": 16384},
    {"frame": 50, "left": -8192, "right": -16384},
    {"frame": 99, "left": -8192, "right": 16384},
    {"frame": 100, "left": 8192, "right": -16384},
    {"frame": 176399, "left": -8192, "right": 16384},
]
manifest = {
    "schema": 1, "commit": os.environ["GITHUB_SHA"], "complete": False,
    "author": {"name": "cue2ccd", "version": "1.1.0", "commit": PIN,
               "sourceUrl": SOURCE_URL, "sourceBytes": 159156, "sourceSha256": SOURCE_SHA, "cargoLockSha256": LOCK_SHA},
    "volume": "KRKR_STORY", "sectorBytes": 2352,
    "audio": {"track": 1, "startSector": 0, "sectors": AUDIO_SECTORS,
              "frames": AUDIO_SECTORS * 588, "sampleRate": 44100, "channels": 2, "encoding": "s16le",
              "leftPeriodFrames": 100, "rightPeriodFrames": 50, "samples": SAMPLES},
    "data": {"track": 2, "startSector": AUDIO_SECTORS, "mode": "MODE1/2352", "payloadBytes": 2048},
    "files": [], "commands": [], "readback": {}, "error": None,
    "scope": "Ordinary authored disc; SUB is retained as author output, not a product subchannel compatibility claim.",
    "references": [f"https://github.com/mistydemeo/cue2ccd/tree/{PIN}",
                   "https://ecma-international.org/publications-and-standards/standards/ecma-130/",
                   "https://github.com/hessu/bchunk/blob/master/bchunk.c"],
}


def save():
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def describe(path):
    return {"name": path.name, "bytes": path.stat().st_size, "sha256": sha(path)}


def run(args, timeout=120, env=None):
    log = LOGS / f"{len(manifest['commands']):03d}.log"
    row = {"argv": [str(value) for value in args], "log": str(log.relative_to(ROOT)), "timeoutSeconds": timeout}
    manifest["commands"].append(row)
    save()
    try:
        result = subprocess.run(row["argv"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=env)
        log.write_bytes(result.stdout)
        row.update({"exitCode": result.returncode, "bytes": len(result.stdout), "sha256": sha(log)})
        if result.returncode:
            raise RuntimeError(f"CloneCD authoring command failed: {args[0]} ({result.returncode}); {log.name}")
        return result.stdout
    except subprocess.TimeoutExpired as error:
        log.write_bytes(error.output or b"")
        row.update({"timedOut": True, "bytes": log.stat().st_size, "sha256": sha(log)})
        raise
    finally:
        save()


# ECMA-130 Mode 1: reflected EDC followed by the two Reed-Solomon parity
# interleaves over GF(256), primitive polynomial x^8+x^4+x^3+x^2+1.
# These sector-construction equations are independent of the Web ISO reader.
FORWARD, BACKWARD, EDC = [0] * 256, [0] * 256, []
for value in range(256):
    doubled = ((value << 1) ^ (0x11D if value & 128 else 0)) & 255
    FORWARD[value] = doubled
    BACKWARD[value ^ doubled] = value
    crc = value
    for _ in range(8):
        crc = (crc >> 1) ^ (0xD8018001 if crc & 1 else 0)
    EDC.append(crc)


def parity(data, major_count, minor_count, major_mult, minor_inc):
    result = bytearray(major_count * 2)
    size = major_count * minor_count
    assert len(data) == size
    for major in range(major_count):
        offset = (major >> 1) * major_mult + (major & 1)
        accum, total = 0, 0
        for _ in range(minor_count):
            value = data[offset]
            offset = (offset + minor_inc) % size
            accum = FORWARD[accum ^ value]
            total ^= value
        accum = BACKWARD[FORWARD[accum] ^ total]
        result[major] = accum
        result[major + major_count] = accum ^ total
    return result


def mode1(payload, lba):
    assert len(payload) == 2048
    minutes, rest = divmod(lba + 150, 75 * 60)
    seconds, frames = divmod(rest, 75)
    assert minutes < 100
    sector = bytearray(2352)
    sector[1:11] = b"\xff" * 10
    sector[12:16] = bytes(((minutes // 10) * 16 + minutes % 10,
                           (seconds // 10) * 16 + seconds % 10,
                           (frames // 10) * 16 + frames % 10, 1))
    sector[16:2064] = payload
    crc = 0
    for value in sector[:2064]:
        crc = (crc >> 8) ^ EDC[(crc ^ value) & 255]
    struct.pack_into("<I", sector, 2064, crc)
    sector[2076:2248] = parity(sector[12:2076], 86, 24, 2, 86)
    sector[2248:2352] = parity(sector[12:2248], 52, 43, 86, 88)
    return sector


def ccd_layout(path, sectors):
    config = configparser.ConfigParser(interpolation=None)
    config.read_string(path.read_text(encoding="ascii"))
    number = lambda section, key: int(config[section][key], 0)
    assert number("CloneCD", "Version") == 3
    assert number("Disc", "Sessions") == 1 and number("Disc", "TocEntries") == 5
    assert number("Disc", "DataTracksScrambled") == 0
    tracks = []
    for track, mode, start in [(1, 0, 0), (2, 1, AUDIO_SECTORS)]:
        section = f"TRACK {track}"
        assert number(section, "MODE") == mode and number(section, "INDEX 1") == start
        # An implicit zero-length INDEX 0 is harmless. A real data pregap
        # would shorten the first audio track and must fail this fixture.
        zero = number(section, "INDEX 0") if "INDEX 0" in config[section] else None
        assert zero is None or zero == start, "Unexpected authored pregap"
        entry = next(name for name in config.sections() if name.startswith("Entry ") and number(name, "Point") == track)
        assert number(entry, "PLBA") == start
        assert number(entry, "Control") == (0 if track == 1 else 4)
        tracks.append({"number": track, "mode": mode, "index0": zero, "index1": start, "control": number(entry, "Control")})
    leadout = next(name for name in config.sections() if name.startswith("Entry ") and number(name, "Point") == 0xA2)
    assert number(leadout, "PLBA") == sectors
    return {"tracks": tracks, "leadoutSector": sectors, "firstAudioSectors": AUDIO_SECTORS}


def main():
    # The author deliberately does not overwrite an existing IMG. Never let
    # that policy substitute an earlier authoring result for this invocation.
    assert not any((ROOT / f"{STEM}.{extension}").exists() for extension in ["ccd", "img", "sub"]), \
        "CloneCD output files must be absent before the independent author runs"
    source_dir = Path("out/verification/disc-volumes").resolve()
    source_manifest = source_dir / "boot-manifest.json"
    boot = json.loads(source_manifest.read_text())
    original = source_dir / "boot-source.iso"
    image = next(row for row in boot["images"] if row["name"] == original.name)
    assert boot["schema"] == 1 and boot["complete"] and boot["commit"] == manifest["commit"]
    assert image["mode"] == "source" and image["independentlyExtracted"]
    assert original.stat().st_size == image["bytes"] and sha(original) == image["sha256"]
    assert image["bytes"] > 0 and image["bytes"] % 2048 == 0
    with original.open("rb") as iso:
        iso.seek(16 * 2048)
        pvd = iso.read(2048)
    assert pvd[:7] == b"\x01CD001\x01" and pvd[40:72].rstrip(b" ") == b"KRKR_STORY"
    manifest["source"] = {**image, "manifestSha256": sha(source_manifest)}
    manifest["data"]["sectors"] = image["bytes"] // 2048
    sectors = AUDIO_SECTORS + image["bytes"] // 2048
    save()
    with tempfile.TemporaryDirectory(prefix="krkr-clonecd-", dir=os.environ["RUNNER_TEMP"]) as directory:
        work = Path(directory)
        archive = work / "cue2ccd-source.tar.gz"
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response, archive.open("wb") as target:
            while block := response.read(64 * 1024):
                target.write(block)
                if target.tell() > 2 * 1024 * 1024:
                    raise RuntimeError("Unexpected cue2ccd source archive size")
        assert archive.stat().st_size == 159156 and sha(archive) == SOURCE_SHA
        with tarfile.open(archive) as source:
            source.extractall(work, filter="data")
        package = work / f"cue2ccd-{PIN}"
        assert sha(package / "Cargo.lock") == LOCK_SHA
        manifest["author"]["cargoVersion"] = run(["cargo", "--version"]).decode().strip()
        manifest["author"]["rustcVersion"] = run(["rustc", "--version"]).decode().strip()
        build_env = {**os.environ, "CARGO_TARGET_DIR": str(work / "target"), "CARGO_HOME": str(work / "cargo-home")}
        run(["cargo", "build", "--locked", "--release", "--manifest-path", package / "Cargo.toml"], timeout=600, env=build_env)
        author = work / "target/release/cue2ccd"
        version = run([author, "--version"]).decode().strip()
        assert version == "cue2ccd 1.1.0"
        manifest["author"].update({"reportedVersion": version, "executableSha256": sha(author)})
        cue = work / f"{STEM}.cue"
        cue.write_text(f'FILE "{STEM}.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
                       '  TRACK 02 MODE1/2352\n    INDEX 01 00:04:00\n', encoding="ascii")
        (ROOT / "input.cue").write_bytes(cue.read_bytes())
        raw = work / f"{STEM}.bin"
        audio_hash = hashlib.sha256()
        with raw.open("wb") as output:
            for sector in range(AUDIO_SECTORS):
                pcm = bytearray(2352)
                for sample in range(588):
                    frame = sector * 588 + sample
                    struct.pack_into("<hh", pcm, sample * 4,
                                     8192 if frame % 100 < 50 else -8192,
                                     -16384 if frame % 50 < 25 else 16384)
                audio_hash.update(pcm)
                output.write(pcm)
            with original.open("rb") as iso:
                for sector in range(image["bytes"] // 2048):
                    output.write(mode1(iso.read(2048), AUDIO_SECTORS + sector))
        manifest["input"] = {"cue": describe(ROOT / "input.cue"), "raw": describe(raw),
                             "rawRetainedAs": f"{STEM}.img", "sectorEncoding": "ECMA-130 Mode 1 EDC + P/Q ECC"}
        manifest["audio"]["pcmSha256"] = audio_hash.hexdigest()
        save()
        run([author, cue, "--output-path", ROOT])
        for extension in ["ccd", "img", "sub"]:
            manifest["files"].append(describe(ROOT / f"{STEM}.{extension}"))
        img = ROOT / f"{STEM}.img"
        assert img.stat().st_size == sectors * 2352 and sha(img) == manifest["input"]["raw"]["sha256"]
        assert (ROOT / f"{STEM}.sub").stat().st_size == sectors * 96
        manifest["layout"] = ccd_layout(ROOT / f"{STEM}.ccd", sectors)
        save()
        # bchunk independently uses the input CUE's public track offsets. It
        # must recover every ISO byte and every audio sample from author IMG.
        run(["bchunk", "-w", img, cue, work / "readback-"], timeout=180)
        recovered_iso, recovered_wav = work / "readback-02.iso", work / "readback-01.wav"
        assert recovered_iso.stat().st_size == image["bytes"] and sha(recovered_iso) == image["sha256"]
        with wave.open(str(recovered_wav), "rb") as audio:
            assert audio.getparams()[:4] == (2, 2, 44100, AUDIO_SECTORS * 588)
            pcm = audio.readframes(audio.getnframes())
        assert len(pcm) == AUDIO_SECTORS * 2352 and hashlib.sha256(pcm).hexdigest() == audio_hash.hexdigest()
        observed = []
        for expected in SAMPLES:
            left, right = struct.unpack_from("<hh", pcm, expected["frame"] * 4)
            actual = {"frame": expected["frame"], "left": left, "right": right}
            observed.append(actual)
            assert actual == expected
        manifest["readback"] = {"tool": "bchunk", "isoMatched": True, "audioMatched": True,
                                "iso": describe(recovered_iso), "wave": describe(recovered_wav),
                                "pcmBytes": len(pcm), "pcmSha256": hashlib.sha256(pcm).hexdigest(), "samples": observed}
    manifest["complete"] = True


save()
try:
    main()
except BaseException as error:
    manifest["complete"] = False
    manifest["error"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    # Also inventory any partial author output when conversion/readback fails.
    manifest["files"] = [describe(ROOT / f"{STEM}.{extension}") for extension in ["ccd", "img", "sub"]
                         if (ROOT / f"{STEM}.{extension}").is_file()]
    save()

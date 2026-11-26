"""Verify the hosted IMAPI original against a separate 7-Zip UDF extraction."""
from pathlib import Path
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile

if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise RuntimeError("Disc verification requires a GitHub-hosted runner")

def tree(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
            for p in sorted(root.rglob("*"))}

root = Path("out/verification/disc-volumes")
if sys.argv[1:] not in ([], ["--bridge"]):
    raise ValueError("Expected no arguments or --bridge")
bridge = sys.argv[1:] == ["--bridge"]
variant = "bridge" if bridge else "metadata"
image = root / f"boot-udf250-{variant}-source.iso"
data = image.read_bytes()
block = 2048
assert len(data) % block == 0 and len(data) <= 64 * 1024 * 1024

def sector(at):
    assert 0 <= at < len(data) // block
    return data[at * block:(at + 1) * block]

recognition = [sector(i)[1:6] for i in range(16, 32)]
assert b"NSR03" in recognition and b"BEA01" in recognition
assert (b"CD001" in recognition) == bridge
anchor = sector(256)
assert struct.unpack_from("<H", anchor)[0] == 2
length, start = struct.unpack_from("<II", anchor, 16)
assert 0 < length <= 1024 * 1024
lvd = next(s for i in range(start, start + (length + block - 1) // block)
           if (s := sector(i))[:2] == b"\x06\x00")
assert struct.unpack_from("<H", lvd, 240)[0] == 0x250
assert lvd[440:442] == bytes((1, 6)) and lvd[446:448] == bytes((2, 64))
assert lvd[451:474].rstrip(b"\0") == b"*UDF Metadata Partition"
primary, mirror = struct.unpack_from("<II", lvd, 486)
assert primary != mirror and lvd[504] & 1
assert struct.unpack_from("<H", lvd, 256)[0] == 1

original = tree(root / "story-files")
with tempfile.TemporaryDirectory() as extracted:
    subprocess.run(["7z", "x", "-tUdf", "-y", "-o" + extracted, str(image)], check=True)
    assert tree(Path(extracted)) == original, "7-Zip readback differs from the game input tree"

if bridge:
    with tempfile.TemporaryDirectory() as extracted:
        subprocess.run(["7z", "x", "-tIso", "-y", "-o" + extracted, str(image)], check=True)
        iso_tree = tree(Path(extracted))
        assert not any(name.casefold() == "routes/開幕.tjs" for name in iso_tree)
        assert original["Routes/開幕.tjs"] in iso_tree.values()

manifest = {"bridge": bridge, "commit": os.environ["GITHUB_SHA"], "author": "Windows IMAPI2FS", "reader": "7-Zip UDF",
            "name": image.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "revision": 0x250, "partitionMaps": ["physical", "metadata"], "duplicate": True,
            "primary": primary, "mirror": mirror, "tree": original, "complete": True}
if bridge:
    manifest["isoTree"] = iso_tree
(root / f"udf-{variant}-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

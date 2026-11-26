"""Package both authored KAG discs and compare each compressed image with Info-ZIP."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package(directory, row):
    binary = row["mode"] == "bytecode"
    outer = "StoryBytecode.zip" if binary else "StorySource.zip"
    path = directory / outer
    image = (directory / row["name"]).read_bytes()
    assert digest(image) == row["sha256"]
    member = "Media/" + row["name"]
    contents = {member: image, "Setup.exe": b"Authored installer name only.\r\n"}
    if binary:
        contents["Media/boot.cue"] = (
            f'FILE "{row["name"]}" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00\n'
        ).encode()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)
        track = archive.getinfo(member)
    raw = path.read_bytes()
    if binary:
        # The ISO is the first member. Both cuts lie inside its compressed payload.
        start = track.header_offset + 30 + len(member.encode()) + len(track.extra)
        cut1, cut2 = (start + track.compress_size * i // 3 for i in (1, 2))
        parts = [raw[:cut1], raw[cut1:cut2], raw[cut2:]]
        names = [outer + f".{i:03d}" for i in range(1, 4)]
        for name, part in zip(names, parts):
            (directory / name).write_bytes(part)
        path.write_bytes(b"".join((directory / name).read_bytes() for name in names))
    else:
        names = [outer]
    assert digest(path.read_bytes()) == digest(raw)
    for name, expected in contents.items():
        assert subprocess.check_output(["unzip", "-p", path, name]) == expected
    volumes = []
    for name in names:
        data = (directory / name).read_bytes()
        volumes.append({"name": name, "bytes": len(data), "sha256": digest(data)})
    if binary:
        path.unlink()
    return {"outer": outer, "mode": row["mode"], "volumes": volumes,
            "image": member, "imageSha256": row["sha256"], "zipSha256": digest(raw)}


if __name__ == "__main__":
    assert os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    directory = Path("out/verification/disc-volumes")
    original = json.loads((directory / "boot-manifest.json").read_text())
    assert original["complete"] and original["commit"] == os.environ["GITHUB_SHA"]
    releases = [package(directory, row) for row in original["images"]]
    assert {release["mode"] for release in releases} == {"source", "bytecode"}
    (directory / "release-manifest.json").write_text(json.dumps(
        {"schema": 1, "commit": original["commit"], "releases": releases}, indent=2) + "\n")

"""Hosted-only, explicit CP932 primary ISO names with independent isoinfo IO.

genisoimage authors an ordinary ASCII layout. Fixed-width byte substitutions
then model OEM names used by non-Joliet game discs, including 95 5C (表). The
manifest records every reversible substitution; no production parser is used.
"""
from pathlib import Path
import hashlib
import json
import os
import struct
import subprocess
import tempfile

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise RuntimeError("OEM game disc authoring requires a GitHub-hosted runner")

ROOT = Path("out/verification/oem-game-disc").resolve()
ROOT.mkdir(parents=True, exist_ok=True)
LOGS = ROOT / "logs"
LOGS.mkdir(exist_ok=True)
NAME = "boot-oem932-source.iso"
NAMES = {b"JPGame": bytes.fromhex("95 5c 47 61 6d 65"), b"JP": bytes.fromhex("95 5c"),
         b"JP.ks": bytes.fromhex("95 5c 2e 6b 73"), b"JP.tjs": bytes.fromhex("95 5c 2e 74 6a 73")}
manifest = {"schema": 1, "commit": os.environ["GITHUB_SHA"], "complete": False,
            "name": NAME, "encoding": "shift_jis", "volume": "KRKR_表", "volumeBytes": "4b524b525f955c",
            "commands": [], "inputs": [], "patches": [], "readback": {"complete": False, "files": []},
            "error": None, "scope": "genisoimage primary ISO layout with explicit fixed-width CP932 identifiers; no Joliet, UDF, Rock Ridge or product authoring"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save():
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n")


def run(args, binary=False):
    log = LOGS / f"{len(manifest['commands']):03d}.log"
    argv = [os.fsdecode(value) if isinstance(value, bytes) else str(value) for value in args]
    row = {"argv": argv, "argvRawHex": [os.fsencode(value).hex() for value in argv],
           "log": str(log.relative_to(ROOT)), "binaryStdout": binary, "timeoutSeconds": 120}
    manifest["commands"].append(row)
    save()
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        log.write_bytes(result.stderr + (b"" if binary else result.stdout))
        row.update({"exitCode": result.returncode, "stdoutBytes": len(result.stdout), "stdoutSha256": sha(result.stdout),
                    "logBytes": log.stat().st_size, "logSha256": sha(log.read_bytes())})
        if result.returncode:
            raise RuntimeError(f"OEM disc command failed: {argv[0]}; {log.name}")
        return result.stdout
    except subprocess.TimeoutExpired as error:
        log.write_bytes((error.stderr or b"") + (b"" if binary else error.output or b""))
        row["timedOut"] = True
        raise
    finally:
        save()


def replace(image, at, before, after, kind):
    assert len(before) == len(after) and image[at:at + len(before)] == before
    image[at:at + len(before)] = after
    manifest["patches"].append({"offset": at, "before": before.hex(), "after": after.hex(), "kind": kind})


def rewrite_primary(image):
    descriptors = []
    at = 16 * 2048
    while True:
        assert image[at + 1:at + 7] == b"CD001\x01"
        kind = image[at]
        descriptors.append(kind)
        if kind == 255:
            break
        assert kind == 1 and at == 16 * 2048, "Only one primary descriptor is allowed"
        at += 2048
    assert descriptors == [1, 255]
    pvd = 16 * 2048
    old_volume = b"KRKR_JP".ljust(32, b" ")
    replace(image, pvd + 40, old_volume, bytes.fromhex(manifest["volumeBytes"]).ljust(32, b" "), "volume")
    assert struct.unpack_from("<H", image, pvd + 128)[0] == struct.unpack_from(">H", image, pvd + 130)[0] == 2048
    table_size = struct.unpack_from("<I", image, pvd + 132)[0]
    assert table_size == struct.unpack_from(">I", image, pvd + 136)[0]
    table_rows = []
    for offset, endian in [(140, "<"), (144, "<"), (148, ">"), (152, ">")]:
        location = struct.unpack_from(endian + "I", image, pvd + offset)[0]
        if not location:
            continue
        cursor, end = location * 2048, location * 2048 + table_size
        assert end <= len(image)
        rows = []
        while cursor < end:
            length = image[cursor]
            assert length > 0 and cursor + 8 + length <= end
            original = bytes(image[cursor + 8:cursor + 8 + length])
            changed = NAMES.get(original, original)
            if changed != original:
                replace(image, cursor + 8, original, changed, "path-table-" + endian)
            rows.append(changed.hex())
            cursor += 8 + length + (length & 1)
        assert cursor == end
        table_rows.append(rows)
    assert len(table_rows) >= 2 and all(rows == table_rows[0] for rows in table_rows)
    files = {}
    seen = set()

    def walk(extent, size, parts=()):
        assert (extent, size) not in seen
        seen.add((extent, size))
        cursor, end = extent * 2048, extent * 2048 + size
        assert 0 < size and end <= len(image)
        while cursor < end:
            length = image[cursor]
            if not length:
                cursor = (cursor // 2048 + 1) * 2048
                continue
            assert length >= 34 and cursor + length <= end and cursor % 2048 + length <= 2048
            target = struct.unpack_from("<I", image, cursor + 2)[0]
            target_size = struct.unpack_from("<I", image, cursor + 10)[0]
            assert target == struct.unpack_from(">I", image, cursor + 6)[0]
            assert target_size == struct.unpack_from(">I", image, cursor + 14)[0]
            name_size = image[cursor + 32]
            assert 33 + name_size <= length
            original = bytes(image[cursor + 33:cursor + 33 + name_size])
            if original not in (b"\x00", b"\x01"):
                changed = NAMES.get(original, original)
                if changed != original:
                    replace(image, cursor + 33, original, changed, "directory-record")
                path = (*parts, changed)
                if image[cursor + 25] & 2:
                    walk(target, target_size, path)
                else:
                    assert not image[cursor + 25] & 128 and target * 2048 + target_size <= len(image)
                    raw_path = b"/".join(path)
                    assert raw_path not in files
                    files[raw_path] = {"offset": target * 2048, "bytes": target_size}
            cursor += length

    walk(struct.unpack_from("<I", image, pvd + 158)[0], struct.unpack_from("<I", image, pvd + 166)[0])
    manifest["layout"] = {"joliet": False, "udf": False, "primaryOnly": True, "isoDescriptors": descriptors,
                          "pathTables": table_rows, "directoryCount": len(seen)}
    return files


def main():
    with tempfile.TemporaryDirectory(prefix="krkr-oem-disc-", dir=os.environ["RUNNER_TEMP"]) as directory:
        work = Path(directory)
        script = """import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { oemDiscProjectFiles } from './tests/helpers/oem-game-disc.ts';
const directory=process.argv[1], rows=[];
for(const file of oemDiscProjectFiles()) {
 const path=join(directory,'files',file.isoName);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.buffer);
 rows.push({name:file.name,isoName:file.isoName,bytes:file.buffer.length,sha256:createHash('sha256').update(file.buffer).digest('hex')});
}
writeFileSync(join(directory,'inputs.json'),JSON.stringify(rows,null,2));"""
        run(["node", "--import", "tsx", "--input-type=module", "-e", script, work])
        manifest["inputs"] = json.loads((work / "inputs.json").read_text())
        assert next(item for item in manifest["inputs"] if item["name"] == "表Game/data.xp3")["sha256"] == \
            "5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644"
        manifest["genisoimageVersion"] = run(["genisoimage", "--version"]).decode().strip()
        # -U preserves the authored ASCII spelling. High-bit OEM bytes are
        # added below explicitly rather than relying on a tool charset guess.
        original = work / "ascii-layout.iso"
        run(["genisoimage", "-quiet", "-U", "-V", "KRKR_JP", "-o", original, work / "files"])
        before = original.read_bytes()
        manifest["unmodifiedImage"] = {"bytes": len(before), "sha256": sha(before)}
        image = bytearray(before)
        files = rewrite_primary(image)
        assert len(files) == len(manifest["inputs"])
        for item in manifest["inputs"]:
            raw_path = b"/".join(NAMES.get(part.encode("ascii"), part.encode("ascii")) for part in item["isoName"].split("/"))
            assert raw_path.decode("cp932") == item["name"]
            record = files[raw_path]
            assert record["bytes"] == item["bytes"] and sha(image[record["offset"]:record["offset"] + record["bytes"]]) == item["sha256"]
            item["rawPathHex"] = raw_path.hex()
        # The before/after patch list is enough to recover the exact original
        # tool output without uploading a duplicate copy of the whole disc.
        restored = bytearray(image)
        for patch in reversed(manifest["patches"]):
            at = patch["offset"]; old, new = bytes.fromhex(patch["before"]), bytes.fromhex(patch["after"])
            assert restored[at:at + len(new)] == new
            restored[at:at + len(old)] = old
        assert restored == before
        output = ROOT / NAME
        output.write_bytes(image)
        manifest.update({"bytes": len(image), "sha256": sha(image)})
        save()
        listing = run(["isoinfo", "-i", output, "-f"])
        paths = set(listing.splitlines())
        info = run(["isoinfo", "-i", output, "-d"])
        assert b"Volume id: " + bytes.fromhex(manifest["volumeBytes"]) in info
        for item in manifest["inputs"]:
            path = b"/" + bytes.fromhex(item["rawPathHex"])
            assert path in paths, "Independent reader did not expose the exact OEM path bytes"
            content = run(["isoinfo", "-i", output, "-x", path], binary=True)
            observed = {"name": item["name"], "rawPathHex": item["rawPathHex"], "bytes": len(content), "sha256": sha(content)}
            manifest["readback"]["files"].append(observed)
            assert observed["bytes"] == item["bytes"] and observed["sha256"] == item["sha256"]
        manifest["readback"].update({"complete": True, "listingSha256": sha(listing), "descriptorSha256": sha(info)})
    manifest["complete"] = True


save()
try:
    main()
except BaseException as error:
    manifest["complete"] = False
    manifest["error"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    save()

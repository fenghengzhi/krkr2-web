"""Author ordinary UDF-only game media with mkudffs and the hosted Linux writer.

No Web filesystem implementation participates in authoring or either readback.
The two image files remain in disc-volumes once; extraction copies are temporary.
"""
from pathlib import Path
import binascii
import hashlib
import json
import os
import shutil
import struct
import subprocess
import tempfile


if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise RuntimeError("UDF authoring requires a GitHub-hosted runner")

ROOT = Path("out/verification/disc-volumes").resolve()
LOGS = ROOT / "udf-logs"
LOGS.mkdir(parents=True, exist_ok=True)
BLOCK = 2048
BLOCKS = 32 * 1024 * 1024 // BLOCK
VOLUME = "KRKR_STORY"
manifest = {"schema": 1, "commit": os.environ["GITHUB_SHA"], "complete": False,
            "author": "mkudffs plus Linux UDF filesystem", "images": [], "commands": [], "error": None,
            "policySources": ["https://github.com/pali/udftools/blob/master/mkudffs/options.c",
                              "https://github.com/torvalds/linux/blob/v6.8/fs/udf/super.c"]}


def save():
    (ROOT / "udf-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def run(args, timeout=120):
    log = LOGS / f"{len(manifest['commands']):03d}.log"
    record = {"argv": [str(arg) for arg in args], "log": str(log.relative_to(ROOT)), "timeoutSeconds": timeout}
    manifest["commands"].append(record)
    save()
    try:
        result = subprocess.run(record["argv"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        log.write_bytes(result.stdout)
        record.update({"exitCode": result.returncode, "bytes": len(result.stdout), "sha256": digest(log)})
        if result.returncode:
            raise RuntimeError(f"UDF authoring command failed: {args[0]} ({result.returncode}); {log.name}")
        return result.stdout
    except subprocess.TimeoutExpired as error:
        log.write_bytes(error.output or b"")
        record.update({"timedOut": True, "bytes": log.stat().st_size, "sha256": digest(log)})
        raise
    finally:
        save()


def tree(directory):
    files, directories = [], []
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        if path.is_symlink():
            raise RuntimeError("Unexpected authoring symlink: " + name)
        if path.is_dir():
            directories.append(name)
        elif path.is_file():
            files.append({"name": name, "bytes": path.stat().st_size, "sha256": digest(path)})
        else:
            raise RuntimeError("Unexpected authoring file type: " + name)
    return {"files": files, "directories": directories}


def tag(block):
    if len(block) != BLOCK or sum(block[:4] + block[5:16]) & 255 != block[4]:
        return None
    length = struct.unpack_from("<H", block, 10)[0]
    if length > BLOCK - 16 or binascii.crc_hqx(block[16:16 + length], 0) != struct.unpack_from("<H", block, 8)[0]:
        return None
    return struct.unpack_from("<H", block)[0]


def layout(path, revision, allocation):
    # Independent header inventory only. Payload validation below uses the
    # Linux filesystem and 7-Zip, never the production UDF reader.
    with path.open("rb") as image:
        def block(at):
            if not 0 <= at < BLOCKS:
                raise RuntimeError("Authoring descriptor outside its image")
            image.seek(at * BLOCK)
            return image.read(BLOCK)
        identifiers = [block(at)[1:6].decode("ascii", errors="replace") for at in range(16, 32)]
        assert "CD001" not in identifiers, "Expected original UDF-only image, not an ISO bridge"
        assert ("NSR02" if revision == 0x0102 else "NSR03") in identifiers
        anchor = block(256)
        assert tag(anchor) == 2
        length, location = struct.unpack_from("<II", anchor, 16)
        assert 0 < length <= 1024 * 1024 and length % BLOCK == 0
        descriptors = [block(at) for at in range(location, location + length // BLOCK)]
        lvd = next(data for data in descriptors if tag(data) == 6)
        size = struct.unpack_from("<I", lvd, 212)[0]
        rev = struct.unpack_from("<H", lvd, 240)[0]
        map_bytes, map_count = struct.unpack_from("<II", lvd, 264)
        assert size == BLOCK and rev == revision
        assert map_count == 1 and map_bytes == 6 and lvd[440:442] == b"\x01\x06"
        partition_number = struct.unpack_from("<H", lvd, 444)[0]
        pd = next(data for data in descriptors if tag(data) == 5 and struct.unpack_from("<H", data, 22)[0] == partition_number)
        start, blocks = struct.unpack_from("<II", pd, 188)
        assert start > 0 and blocks > 0 and start + blocks <= BLOCKS
        label_bytes = lvd[84:212]
        assert label_bytes[0] == 8
        label = label_bytes[1:label_bytes[-1]].decode("ascii")
        assert label == VOLUME
        counts = {"FE": 0, "EFE": 0, "embedded": 0, "short": 0, "long": 0}
        for at in range(start, start + blocks):
            data = block(at)
            kind = tag(data)
            if kind not in (261, 266) or data[27] not in (4, 5):
                continue
            if struct.unpack_from("<I", data, 12)[0] != at - start:
                continue
            ad = struct.unpack_from("<H", data, 34)[0] & 7
            counts["FE" if kind == 261 else "EFE"] += 1
            if ad in (0, 1, 3):
                counts[{0: "short", 1: "long", 3: "embedded"}[ad]] += 1
        assert counts["embedded"] > 0 and counts[allocation] > 0, "Requested mixed inline/external allocation was not observed"
        return {"blockSize": size, "revision": rev, "partitionMapTypes": [1], "partitionStart": start,
                "partitionBlocks": blocks, "volume": label, "isoDescriptors": 0,
                "recognition": identifiers[:3], "fileEntryAllocations": counts}


def author(mode, revision, allocation, seven_zip, boot):
    name = f"boot-udf{revision:03x}-{mode}.iso"
    source = ROOT / f"boot-{mode}-files"
    expected = tree(source)
    old = next(item for item in boot["images"] if item["mode"] == mode)
    assert expected["files"] == old["files"], "Original KAG authoring tree changed"
    row = {"name": name, "mode": mode, "revision": f"{revision >> 8}.{revision & 255:02x}", "volume": VOLUME,
           "complete": False, "files": expected["files"], "directories": expected["directories"],
           "allocationPolicy": {"smallFiles": "adinicb", "external": allocation + "ad"},
           "kernelReadback": False, "sevenZipReadback": False}
    manifest["images"].append(row)
    save()
    target = ROOT / name
    if target.exists():
        raise RuntimeError("Refusing to overwrite an existing UDF original: " + name)
    mount = Path(tempfile.mkdtemp(prefix="krkr-udf-mount-"))
    extracted = Path(tempfile.mkdtemp(prefix="krkr-udf-readback-"))
    mounted = False
    primary = None
    try:
        run(["mkudffs", "--utf8", "--media-type=hd", f"--udfrev=0x{revision:04x}", "--blocksize=2048",
             "--label=" + VOLUME, "--strategy=4", "--ad=inicb", "--bootarea=erase", "--new-file", target, str(BLOCKS)])
        assert target.stat().st_size == BLOCK * BLOCKS
        options = "loop,rw,bs=2048,utf8,adinicb," + allocation + "ad,nosuid,nodev,noexec"
        run(["sudo", "-n", "mount", "-t", "udf", "-o", options, target, mount])
        mounted = True
        run(["findmnt", "-J", "--target", mount])
        run(["sudo", "-n", "cp", "-a", str(source) + "/.", str(mount) + "/"])
        run(["sudo", "-n", "umount", mount])
        mounted = False
        row["layout"] = layout(target, revision, allocation)
        before = digest(target)
        run(["sudo", "-n", "mount", "-t", "udf", "-o", "loop,ro,bs=2048,utf8,nosuid,nodev,noexec", target, mount])
        mounted = True
        assert tree(mount) == expected, "Kernel read-only remount differs from the authoring files"
        row["kernelReadback"] = True
        run(["sudo", "-n", "umount", mount])
        mounted = False
        run([seven_zip, "l", "-slt", "-tUdf", target])
        run([seven_zip, "t", "-tUdf", target])
        run([seven_zip, "x", "-tUdf", "-y", "-o" + str(extracted), target])
        assert tree(extracted) == expected, "Independent 7-Zip extraction differs from original KAG inputs"
        row["sevenZipReadback"] = True
        assert digest(target) == before, "A read-only verification changed the UDF original"
        row.update({"bytes": target.stat().st_size, "sha256": before})
    except BaseException as error:
        primary = error
        raise
    finally:
        cleanup = []
        if mounted:
            try:
                run(["sudo", "-n", "umount", mount], timeout=45)
                mounted = False
            except BaseException as error:
                cleanup.append({"operation": "unmount", "type": type(error).__name__, "message": str(error)})
        if not mounted:
            try:
                mount.rmdir()
            except BaseException as error:
                cleanup.append({"operation": "remove mount directory", "type": type(error).__name__, "message": str(error)})
        try:
            shutil.rmtree(extracted)
        except BaseException as error:
            cleanup.append({"operation": "remove extraction directory", "type": type(error).__name__, "message": str(error)})
        row["cleanupErrors"] = cleanup
        row["complete"] = primary is None and not cleanup
        save()
        if cleanup and primary is None:
            raise RuntimeError("UDF authoring cleanup was incomplete; see the original command logs")


try:
    boot = json.loads((ROOT / "boot-manifest.json").read_text())
    assert boot["complete"] and boot["commit"] == manifest["commit"]
    seven_zip = shutil.which("7zz") or shutil.which("7z")
    if not seven_zip:
        raise RuntimeError("No installed 7zz or 7z available for independent UDF readback")
    run(["dpkg-query", "--show", "--showformat=${binary:Package} ${Version}\n", "udftools"])
    run(["uname", "-a"])
    run([seven_zip, "i"])
    author("source", 0x0102, "short", seven_zip, boot)
    author("bytecode", 0x0201, "long", seven_zip, boot)
    manifest["complete"] = True
except BaseException as error:
    manifest["error"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    save()

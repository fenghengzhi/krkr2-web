"""Author ordinary UDF-only game media with mkudffs and the hosted Linux writer.

No Web filesystem implementation participates in authoring or either readback.
The default pair and optional sparable image each remain in disc-volumes once;
extraction copies are temporary. The sparable run has a separate manifest.
"""
from pathlib import Path
import binascii
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile


if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise RuntimeError("UDF authoring requires a GitHub-hosted runner")

ROOT = Path("out/verification/disc-volumes").resolve()
if sys.argv[1:] not in ([], ["--sparable"]):
    raise RuntimeError("Expected no arguments or --sparable")
SPARABLE = sys.argv[1:] == ["--sparable"]
LOGS = ROOT / ("udf-sparable-logs" if SPARABLE else "udf-logs")
LOGS.mkdir(parents=True, exist_ok=True)
BLOCK = 2048
BLOCKS = 32 * 1024 * 1024 // BLOCK
VOLUME = "KRKR_STORY"
manifest = {"schema": 1, "commit": os.environ["GITHUB_SHA"], "complete": False,
            "variant": "sparable-fsd-relocation" if SPARABLE else "physical-type1-pair",
            "author": "mkudffs plus Linux UDF filesystem", "images": [], "commands": [], "error": None,
            "policySources": ["https://github.com/pali/udftools/blob/master/mkudffs/options.c",
                              "https://github.com/pali/udftools/blob/master/include/osta_udf.h",
                              "https://github.com/torvalds/linux/blob/v6.8/fs/udf/partition.c",
                              "https://github.com/torvalds/linux/blob/v6.8/fs/udf/super.c"]}


def save():
    (ROOT / ("udf-sparable-manifest.json" if SPARABLE else "udf-manifest.json")).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


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


def layout(path, revision, allocation, sparable=False):
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
        assert map_count == 1
        extra = {}
        if sparable:
            assert map_bytes == 64 and lvd[440:442] == b"\x02\x40"
            assert lvd[445:468].rstrip(b"\0") == b"*UDF Sparable Partition"
            partition_number = struct.unpack_from("<H", lvd, 478)[0]
            packet = struct.unpack_from("<H", lvd, 480)[0]
            tables, table_size = lvd[482], struct.unpack_from("<I", lvd, 484)[0]
            assert packet == 16 and tables == 2 and 56 <= table_size <= BLOCK
            fsd_length, fsd_block, fsd_partition = struct.unpack_from("<IIH", lvd, 248)
            assert fsd_length == BLOCK and fsd_partition == 0
            extra = {"packetBlocks": packet, "sparingTableBytes": table_size,
                     "sparingTableBlocks": list(struct.unpack_from("<" + "I" * tables, lvd, 488)),
                     "fsdLogicalBlock": fsd_block}
        else:
            assert map_bytes == 6 and lvd[440:442] == b"\x01\x06"
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
        return {"blockSize": size, "revision": rev, "partitionMapTypes": [2 if sparable else 1], "partitionStart": start,
                "partitionBlocks": blocks, "volume": label, "isoDescriptors": 0,
                "recognition": identifiers[:3], "fileEntryAllocations": counts, **extra}


def relocate_fsd_packet(path, description):
    """Populate the formatter's existing reserved slot, not a new Web-authored
    filesystem. Original packet locations are partition-relative; mapped slots
    are absolute medium blocks (Linux udf_get_pblock_spar15)."""
    packet = description["packetBlocks"]
    logical = description["fsdLogicalBlock"] // packet * packet
    physical = description["partitionStart"] + logical
    assert logical + packet <= description["partitionBlocks"]
    tables = []
    with path.open("r+b") as image:
        for location in description["sparingTableBlocks"]:
            assert 0 <= location < BLOCKS
            image.seek(location * BLOCK)
            data = bytearray(image.read(BLOCK))
            assert tag(data) == 0 and struct.unpack_from("<I", data, 12)[0] == location
            assert data[17:40].rstrip(b"\0") == b"*UDF Sparing Table"
            entries = struct.unpack_from("<H", data, 48)[0]
            assert 1 <= entries <= (BLOCK - 56) // 8 and 56 + entries * 8 == description["sparingTableBytes"]
            assert struct.unpack_from("<H", data, 10)[0] == 40 + entries * 8
            pairs = [struct.unpack_from("<II", data, 56 + index * 8) for index in range(entries)]
            assert all(old == 0xffffffff for old, _ in pairs), "Expected newly formatted unused sparing slots"
            tables.append({"location": location, "bytes": data, "entriesBefore": pairs,
                           "sha256Before": hashlib.sha256(data).hexdigest()})
        assert tables and all(item["entriesBefore"] == tables[0]["entriesBefore"] for item in tables)
        mapped = tables[0]["entriesBefore"][0][1]
        assert mapped % packet == 0 and 0 <= mapped < BLOCKS and mapped + packet <= BLOCKS
        assert mapped + packet <= description["partitionStart"] or mapped >= description["partitionStart"] + description["partitionBlocks"]
        assert all(not mapped <= item["location"] < mapped + packet for item in tables)
        image.seek(physical * BLOCK)
        original = image.read(packet * BLOCK)
        assert len(original) == packet * BLOCK
        fsd_at = (description["fsdLogicalBlock"] - logical) * BLOCK
        assert tag(original[fsd_at:fsd_at + BLOCK]) == 256, "The relocated packet must contain the real file set descriptor"
        before = hashlib.sha256(original).hexdigest()
        image.seek(mapped * BLOCK)
        image.write(original)
        for item in tables:
            data = item["bytes"]
            struct.pack_into("<I", data, 56, logical)
            sequence = struct.unpack_from("<I", data, 52)[0] + 1
            struct.pack_into("<I", data, 52, sequence)
            length = struct.unpack_from("<H", data, 10)[0]
            struct.pack_into("<H", data, 8, binascii.crc_hqx(data[16:16 + length], 0))
            data[4] = sum(data[:4] + data[5:16]) & 255
            assert tag(data) == 0
            image.seek(item["location"] * BLOCK)
            image.write(data)
            item.update({"sequence": sequence, "sha256After": hashlib.sha256(data).hexdigest()})
        image.seek(physical * BLOCK)
        image.write(bytes(packet * BLOCK))
        image.flush()
        os.fsync(image.fileno())
        image.seek(physical * BLOCK)
        assert image.read(packet * BLOCK) == bytes(packet * BLOCK)
        image.seek(mapped * BLOCK)
        assert image.read(packet * BLOCK) == original
    return {"packetBlocks": packet, "fsdLogicalBlock": description["fsdLogicalBlock"],
            "originalLogicalPacket": logical, "originalPhysicalPacket": physical,
            "mappedPhysicalPacket": mapped, "originalPacketSha256": before, "mappedPacketSha256": before,
            "originalPacketCleared": True,
            "tables": [{key: value for key, value in item.items() if key != "bytes"} for item in tables]}


def author(mode, revision, allocation, seven_zip, boot, sparable=False):
    name = f"boot-udf{revision:03x}-{'sparable-' if sparable else ''}{mode}.iso"
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
        run(["mkudffs", "--utf8", "--media-type=" + ("dvdrw" if sparable else "hd"), f"--udfrev=0x{revision:04x}", "--blocksize=2048",
             *(["--spartable=2", "--sparspace=32", "--packetlen=16"] if sparable else []),
             "--label=" + VOLUME, "--strategy=4", "--ad=inicb", "--bootarea=erase", "--new-file", target, str(BLOCKS)])
        assert target.stat().st_size == BLOCK * BLOCKS
        options = "loop,rw,bs=2048,utf8,adinicb," + allocation + "ad,nosuid,nodev,noexec"
        run(["sudo", "-n", "mount", "-t", "udf", "-o", options, target, mount])
        mounted = True
        run(["findmnt", "-J", "--target", mount])
        run(["sudo", "-n", "cp", "-a", str(source) + "/.", str(mount) + "/"])
        run(["sudo", "-n", "umount", mount])
        mounted = False
        row["layout"] = layout(target, revision, allocation, sparable)
        if sparable:
            row["formattedImageSha256"] = digest(target)
            row["remapping"] = relocate_fsd_packet(target, row["layout"])
        before = digest(target)
        run(["sudo", "-n", "mount", "-t", "udf", "-o", "loop,ro,bs=2048,utf8,nosuid,nodev,noexec", target, mount])
        mounted = True
        actual_tree = tree(mount)
        if sparable:
            row["kernelReadbackTree"] = actual_tree
        assert actual_tree == expected, "Kernel read-only remount differs from the authoring files"
        row["kernelReadback"] = True
        run(["sudo", "-n", "umount", mount])
        mounted = False
        if sparable:
            row["sevenZipScope"] = "Not required for the sparable map; Linux read-only mount independently verifies every original file and directory"
        else:
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
    if not seven_zip and not SPARABLE:
        raise RuntimeError("No installed 7zz or 7z available for independent UDF readback")
    run(["dpkg-query", "--show", "--showformat=${binary:Package} ${Version}\n", "udftools"])
    run(["uname", "-a"])
    if SPARABLE:
        author("source", 0x0201, "short", seven_zip, boot, sparable=True)
    else:
        run([seven_zip, "i"])
        author("source", 0x0102, "short", seven_zip, boot)
        author("bytecode", 0x0201, "long", seven_zip, boot)
    manifest["complete"] = True
except BaseException as error:
    manifest["error"] = {"type": type(error).__name__, "message": str(error)}
    raise
finally:
    save()

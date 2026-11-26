"""Author and independently extract a Joliet game disc on the hosted build runner."""
from pathlib import Path
import codecs
import struct
import subprocess
import sys
import zipfile


def tjs(source):
    return codecs.BOM_UTF16_LE + source.encode("utf-16-le")


if sys.argv[1:] not in ([], ["--files-only"]):
    raise ValueError("Expected no arguments or --files-only")
root = Path("story-files")
for directory in ("Routes", "Books", "Art", "Empty"):
    (root / directory).mkdir(parents=True, exist_ok=True)
(root / "Routes/Moon Finale.tjs").write_bytes(tjs('"Moon disc scene"'))
(root / "Routes/開幕.tjs").write_bytes(tjs("6*7"))
chapter = Path(__file__).resolve().parents[1] / "tests/fixtures/disc-story/Story.ks"
(root / "Routes/Story.ks").write_bytes(tjs(chapter.read_text(encoding="utf-8").replace("\n", "\r\n")))
(root / "Empty.dat").write_bytes(b"")
with zipfile.ZipFile(root / "Books/Scenes.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("Bonus.tjs", tjs("9*9"))

# A four-pixel BGR row already meets the Windows BMP alignment requirement.
pixels = bytes.fromhex("99 66 33") * 16
header = struct.pack("<2sIHHI", b"BM", 54 + len(pixels), 0, 0, 54)
bitmap = struct.pack("<IiiHHIIiiII", 40, 4, 4, 1, 24, 0, len(pixels), 0, 0, 0, 0)
(root / "Art/Title.bmp").write_bytes(header + bitmap + pixels)

if sys.argv[1:] == ["--files-only"]:
    sys.exit(0)

subprocess.run(["genisoimage", "-quiet", "-input-charset", "utf-8", "-J", "-V", "KRKR_STORY",
                "-o", "story.iso", str(root)], check=True)
reader = ["isoinfo", "-i", "story.iso", "-J"]
listing = subprocess.check_output([*reader, "-f"])
Path("story-files.txt").write_bytes(listing)
paths = {path.split(";", 1)[0]: path for path in listing.decode("ascii", errors="replace").splitlines()}
for item in ("Routes/Moon Finale.tjs", "Routes/Story.ks", "Books/Scenes.zip", "Art/Title.bmp", "Empty.dat"):
    actual = subprocess.check_output([*reader, "-x", paths["/" + item]])
    if actual != (root / item).read_bytes():
        raise ValueError("Independent ISO extraction differs for " + item)

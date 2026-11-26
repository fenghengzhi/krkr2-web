"""Create two game media with distinct contents at identical KRKR storage paths."""
from io import BytesIO
from pathlib import Path
import codecs
import os
import struct
import subprocess
import tempfile
import zipfile


def create_image(out, edition, value, rgb):
    packed = BytesIO()
    with zipfile.ZipFile(packed, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('bonus.tjs', str(value))
    color = bytes(reversed(rgb)) + b'\0'
    bmp = struct.pack('<2sIHHI', b'BM', 58, 0, 0, 54)
    bmp += struct.pack('<IiiHHIIiiII', 40, 1, 1, 1, 24, 0, 4, 0, 0, 0, 0) + color
    files = {'Art.bmp': bmp, 'Archive.zip': packed.getvalue(), f'Routes/only{edition}.tjs': b'true',
             'Routes/scene.ks': codecs.BOM_UTF16_LE + edition.encode('utf-16-le')}
    image = out / f'swap-{edition}.iso'
    with tempfile.TemporaryDirectory() as stage:
        for name, data in files.items():
            path = Path(stage) / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
        subprocess.run(['genisoimage', '-quiet', '-J', '-V', 'KRKR_SWAP_' + edition, '-o', image, stage], check=True)
    listing = subprocess.check_output(['isoinfo', '-i', image, '-J', '-f']).decode().splitlines()
    names = {name.split(';', 1)[0]: name for name in listing}
    for name, expected in files.items():
        data = subprocess.check_output(['isoinfo', '-i', image, '-J', '-x', names['/' + name]])
        if data != expected:
            raise ValueError(f'Extracted bytes differ for {edition}/{name}')


if __name__ == '__main__':
    assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    output = Path('out/verification/disc-volumes')
    create_image(output, 'A', 41, bytes.fromhex('336699'))
    create_image(output, 'B', 82, bytes.fromhex('996633'))

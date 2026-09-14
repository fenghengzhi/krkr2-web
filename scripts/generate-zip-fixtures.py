"""Author deterministic ZIP corpus with CPython's independent zipfile/zlib implementation.
Normal tests only read the committed corpus; Python is not a runtime dependency.
"""
from pathlib import Path
import binascii
import hashlib
import io
import json
import platform
import struct
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests/fixtures/zip'
OUT.mkdir(exist_ok=True)

startup = '''var w=new Window();w.visible=true;w.setInnerSize(2,1);
var layer=new Layer(w,null),asset=new Layer(w,layer);layer.setSize(2,1);asset.loadImages("art/pixel.bmp");layer.fillRect(0,0,2,1,0xff000000+asset.getMainPixel(0,0));
var answer=Scripts.evalStorage("シーン/value.tjs"),previous=Storages.isExistentStorage("savedata/zip.txt");
var saved=[];saved.add("archive-save");saved.save("savedata/zip.txt","utf-8");
Debug.message("zip-ready:"+string(answer)+":"+string(previous));
'''
payloads = {
    'startup.tjs': startup.encode(),
    'シーン/value.tjs': b'42',
    'art/pixel.bmp': struct.pack('<2sIHHI',b'BM',58,0,0,54)+struct.pack('<IiiHHIIiiII',40,1,1,1,24,0,4,0,0,0,0)+b'\x99\x66\x33\x00',
    'folder/café.txt': 'café / 日本語 / 😀'.encode(),
    'empty.bin': b'',
    'repeated.bin': b'abcdefgh12345678' * 8192,
}
class Streaming(io.BytesIO):
    def seek(self, *args):
        raise io.UnsupportedOperation('non-seekable fixture')

class Cp437Info(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):
        return self.filename.encode('cp437'), self.flag_bits & ~0x800

def build(method, streaming=False, force_local=False, zip64=False, comment=b'', cp437=False):
    output=Streaming() if streaming else io.BytesIO()
    old_limit=zipfile.ZIP64_LIMIT
    if zip64:
        zipfile.ZIP64_LIMIT=1
    try:
        with zipfile.ZipFile(output,'w',compression=method,compresslevel=6) as archive:
            archive.comment=comment
            directory=zipfile.ZipInfo('folder/',date_time=(2000,1,1,0,0,0))
            directory.external_attr=(0o40755<<16)|16
            archive.writestr(directory,b'')
            for name,content in payloads.items():
                cls=Cp437Info if cp437 and name=='folder/café.txt' else zipfile.ZipInfo
                info=cls(name,date_time=(2000,1,1,0,0,0))
                info.compress_type=method
                info.external_attr=0o100644<<16
                with archive.open(info,'w',force_zip64=force_local or zip64) as member:
                    member.write(content)
    finally:
        zipfile.ZIP64_LIMIT=old_limit
    return output.getvalue()

cases=[]
for method in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]:
    for streaming,local,large in [(False,False,False),(True,False,False),(False,True,False),(True,True,False),(False,False,True),(True,False,True)]:
        name=f'{method}-stream{int(streaming)}-local64{int(local)}-zip64{int(large)}.zip'
        cases.append((name,build(method,streaming,local,large)))
cases.append(('cp437.zip',build(zipfile.ZIP_DEFLATED,cp437=True)))
cases.append(('comment.zip',build(zipfile.ZIP_DEFLATED,comment=b'x'*65535)))
cases.append(('empty.zip',b'PK\x05\x06'+b'\x00'*18))
# ZIP64 records can be present even when the classic fields fit.
optional=bytearray(build(zipfile.ZIP_DEFLATED,zip64=True))
end=len(optional)-22
locator=end-20
large_offset=struct.unpack_from('<Q',optional,locator+8)[0]
count,size,offset=struct.unpack_from('<QQQ',optional,large_offset+32)
struct.pack_into('<HHII',optional,end+8,count,count,size,offset)
cases.append(('optional-zip64.zip',bytes(optional)))

metadata={'generator':{'python':platform.python_version(),'zlib':zlib.ZLIB_VERSION},'cases':[]}
for name,encoded in cases:
    entries=[]
    with zipfile.ZipFile(io.BytesIO(encoded)) as archive:
        assert archive.testzip() is None
        for entry in archive.infolist():
            if entry.is_dir():continue
            data=archive.read(entry)
            assert data==payloads[entry.filename]
            entries.append({'name':entry.filename,'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'crc32':binascii.crc32(data)&0xffffffff,'method':entry.compress_type})
    (OUT/name).write_bytes(encoded)
    metadata['cases'].append({'file':name,'size':len(encoded),'sha256':hashlib.sha256(encoded).hexdigest(),'entries':entries})
metadata['generator']['sourceSha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
(OUT/'reference.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
print(f'Wrote {len(cases)} independent ZIP archives, {sum(len(c[1]) for c in cases)} bytes')

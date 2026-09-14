"""Optional fixture authoring: Python, Pillow and pypng 0.20220715.0.

Uses independent encoders; no engine code. Run from the project root.
"""
from pathlib import Path
from io import BytesIO
import hashlib, json, struct, zlib
import png
from PIL import Image, __version__ as pillow_version

payload = bytearray()
entries = []

def add(name, encoded, width, height, rgba, indices=None, grayscale=False, metadata=None):
    entry = dict(name=name, width=width, height=height, offset=len(payload), size=len(encoded), sha256=hashlib.sha256(encoded).hexdigest(), grayscale=grayscale)
    payload.extend(encoded)
    entry['rgbaOffset'] = len(payload)
    payload.extend(bytes(rgba))
    if indices is not None:
        entry['indicesOffset'] = len(payload)
        payload.extend(bytes(indices))
    if metadata: entry['metadata'] = metadata
    entries.append(entry)

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def filtered(encoded, width, height, channels, mode):
    # Author all five scanline filters, then check them with Pillow's independent decoder.
    at, chunks, compressed = 8, [], b''
    while at < len(encoded):
        size = struct.unpack_from('>I', encoded, at)[0]
        kind, data = encoded[at+4:at+8], encoded[at+8:at+8+size]
        if kind == b'IDAT': compressed += data
        else: chunks.append((kind, data))
        at += size + 12
    raw = zlib.decompress(compressed)
    stride, rows = width * channels, []
    for y in range(height):
        assert raw[y*(stride+1)] == 0
        rows.append(raw[y*(stride+1)+1:(y+1)*(stride+1)])
    packed = bytearray()
    for y, row in enumerate(rows):
        packed.append(mode)
        for x, value in enumerate(row):
            a = row[x-channels] if x >= channels else 0
            b = rows[y-1][x] if y else 0
            c = rows[y-1][x-channels] if y and x >= channels else 0
            p = a+b-c
            candidates = [(abs(p-a), a), (abs(p-b), b), (abs(p-c), c)]
            paeth = min(enumerate(candidates), key=lambda item: (item[1][0], item[0]))[1][1]
            predictor = [0, a, b, (a+b)//2, paeth][mode]
            packed.append((value-predictor) & 255)
    data = b'\x89PNG\r\n\x1a\n' + chunk(*chunks[0]) + chunk(b'IDAT', zlib.compress(packed)) + chunk(b'IEND', b'')
    return data

for color in [0, 2, 3, 4, 6]:
    for depth in ([1,2,4,8,16] if color == 0 else [1,2,4,8] if color == 3 else [8,16]):
        channels = {0:1,2:3,3:1,4:2,6:4}[color]
        for interlace in [False, True]:
            for width, height in [(1,1),(9,7),(17,18)]:
                rows, rgba, indices = [], [], []
                maximum = (1 << depth)-1
                palette = [((i*71)&255, (i*29+19)&255, (255-i*11)&255, [0,73,255][i%3]) for i in range(1 << depth)] if color == 3 else None
                for y in range(height):
                    row = []
                    for x in range(width):
                        samples = [(x*913+y*157+c*103+29) & maximum for c in range(channels)]
                        row.extend(samples)
                        scaled = [(s >> 8) if depth == 16 else s*255//maximum for s in samples]
                        if color == 3:
                            rgba.extend(palette[samples[0]])
                            indices.append(samples[0])
                        elif color in [0,4]: rgba.extend([scaled[0]]*3 + [scaled[1] if color == 4 else 255])
                        else: rgba.extend(scaled[:3]+[scaled[3] if color == 6 else 255])
                    rows.append(row)
                buffer = BytesIO()
                options = dict(width=width,height=height,bitdepth=depth,interlace=interlace)
                if palette: options['palette'] = palette
                else: options.update(greyscale=color in [0,4], alpha=color in [4,6])
                png.Writer(**options).write(buffer, rows)
                encoded = buffer.getvalue()
                add(f'png-{color}-{depth}-{int(interlace)}-{width}x{height}', encoded, width, height, rgba, indices if color == 3 else None, color == 0 and depth <= 8)
                if color == 6 and depth == 8 and not interlace and width == 17:
                    for mode in range(5):
                        encoded_filter = filtered(encoded,width,height,channels,mode)
                        assert Image.open(BytesIO(encoded_filter)).convert('RGBA').tobytes() == bytes(rgba)
                        add(f'png-filter-{mode}',encoded_filter,width,height,rgba)

# Deliberately duplicate palette colors so province and key tests cannot infer indices from RGB.
palette = [255,0,0, 255,0,0, 0,255,0, 0,0,255] + [0]*756
for width,height in [(2,1),(4,2),(257,35)]:
    indices = bytes((x*17+y*29+(x//7)*31)&255 if width>4 else (x+y)%4 for y in range(height) for x in range(width))
    image=Image.frombytes('P',(width,height),indices)
    image.putpalette(palette)
    for format in ['PNG','GIF','BMP']:
        output=BytesIO()
        options=dict(optimize=False)
        if format in ['PNG','GIF']: options['transparency']=0
        if format=='GIF': options['interlace']=True
        image.save(output,format=format,**options)
        encoded=output.getvalue()
        expected=[]
        for index in indices: expected.extend(palette[index*3:index*3+3]+[0 if format!='BMP' and index==0 else 255])
        assert Image.open(BytesIO(encoded)).convert('RGBA').tobytes()==bytes(expected)
        add(f'palette-{width}x{height}.{format.lower()}',encoded,width,height,expected,indices)

gray=Image.frombytes('L',(2,1),bytes([0,128]))
output=BytesIO();gray.save(output,format='PNG')
add('mask.png',output.getvalue(),2,1,[0,0,0,255,128,128,128,255],grayscale=True)

rgba=bytes([200,100,50,64,201,101,51,128])
main=Image.frombytes('RGBA',(2,1),rgba)
output=BytesIO();main.save(output,format='PNG')
encoded=output.getvalue()
encoded=encoded[:33]+chunk(b'oFFs',struct.pack('>iiB',12,-7,0))+chunk(b'pHYs',struct.pack('>IIB',3780,3780,1))+chunk(b'vpAg',struct.pack('>IIB',640,480,0))+encoded[33:]
add('main.png',encoded,2,1,rgba,metadata=dict(offs_x='12',offs_y='-7',offs_unit='pixel',reso_x='3780',reso_y='3780',reso_unit='meter',vpag_w='640',vpag_h='480',vpag_unit='pixel'))

# A tiny four-bit BMP for nibble order and row padding; Pillow independently checks its pixels.
raw=bytes([0x12,0x30,0,0,0x01,0x20,0,0])
table=b''.join(bytes([palette[i*3+2],palette[i*3+1],palette[i*3],0]) for i in range(4))
offset=54+len(table)
encoded=b'BM'+struct.pack('<IHHI',offset+len(raw),0,0,offset)+struct.pack('<IiiHHIIiiII',40,3,2,1,4,0,len(raw),0,0,4,0)+table+raw
indices=[0,1,2,1,2,3];rgba=[]
for index in indices:rgba.extend(palette[index*3:index*3+3]+[255])
assert Image.open(BytesIO(encoded)).convert('RGBA').tobytes()==bytes(rgba)
add('palette-4bit.bmp',encoded,3,2,rgba,indices)

mono=Image.frombytes('L',(9,3),bytes(255 if (x+y)%2 else 0 for y in range(3) for x in range(9))).convert('1')
output=BytesIO();mono.save(output,format='BMP')
add('palette-1bit.bmp',output.getvalue(),9,3,mono.convert('RGBA').tobytes(),[(x+y)%2 for y in range(3) for x in range(9)])

for gray in [False,True]:
    output=BytesIO()
    transparent=0x1234 if gray else (0x1234,0x5678,0x9abc)
    row=[0x1234,0x1200] if gray else [0x1234,0x5678,0x9abc,0x1234,0x5678,0x9abd]
    png.Writer(width=2,height=1,bitdepth=16,greyscale=gray,transparent=transparent).write(output,[row])
    rgba=[0x12,0x12,0x12,0,0x12,0x12,0x12,255] if gray else [0x12,0x56,0x9a,0,0x12,0x56,0x9a,255]
    add('transparent-gray.png' if gray else 'transparent-rgb.png',output.getvalue(),2,1,rgba)

destination=Path('tests/fixtures')
stress=BytesIO();Image.new('L',(4096,4096),0).save(stress,format='PNG')
(destination/'large-gray.png').write_bytes(stress.getvalue())
(destination/'image-reference.bin').write_bytes(payload)
(destination/'image-reference.json').write_text(json.dumps(dict(description='Project-owned pixels encoded by PyPNG and Pillow. All five authored PNG filters additionally checked with Pillow. Expected bytes derive from original samples; 16-bit PNG uses high-byte stripping.',pypng=png.__version__,pillow=pillow_version,cases=len(entries),sha256=hashlib.sha256(payload).hexdigest(),generatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),stress=dict(file='large-gray.png',width=4096,height=4096,sha256=hashlib.sha256(stress.getvalue()).hexdigest()),entries=entries),indent=2)+'\n')
print(f'Recorded {len(entries)} PNG/GIF/BMP images ({len(payload)} bytes)')

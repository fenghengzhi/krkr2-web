"""Synthetic, redistribution-free glyphs and TTFs for font conformance tests."""
import hashlib, json, pathlib, struct
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
import fontTools
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/fixtures/font'
OUT.mkdir(parents=True,exist_ok=True)
glyphs=[
 dict(code=32,width=0,height=0,originX=0,originY=0,incX=3,incY=0,advance=3,levels=[]),
 dict(code=65,width=3,height=2,originX=0,originY=2,incX=5,incY=0,advance=4,levels=[0,16,32,48,64,64]),
 dict(code=66,width=1,height=2,originX=1,originY=2,incX=6,incY=0,advance=7,levels=[64,32]),
 dict(code=0x4e2d,width=5,height=3,originX=-2,originY=3,incX=0,incY=6,advance=8,levels=[0,16,32,48,64]*3),
 dict(code=0xd800,width=65,height=1,originX=2,originY=-1,incX=65,incY=2,advance=65,levels=list(range(65))),
 dict(code=0xffff,width=37,height=20,originX=0,originY=20,incX=40,incY=-3,advance=39,levels=[0]*260+[64]*260+[31]*220),
]
def encode(levels,version):
    data=bytearray(); i=0
    while i<len(levels):
        value=levels[i];data.append(value);i+=1
        while i<len(levels) and levels[i]==value:
            run=0
            while i+run<len(levels) and levels[i+run]==value and run<(255 if version==0 else 191):run+=1
            if version==0:data.extend([0x41,run])
            else:data.append(0x40+run)
            i+=run
    return data
for version in [0,1]:
    count=len(glyphs);data=bytearray(b'TVP pre-rendered font\x1a')+bytes([version,2])+struct.pack('<III',count,36,36+count*2)
    data.extend(struct.pack('<'+'H'*count,*[g['code'] for g in glyphs]))
    records=bytearray();payload=bytearray();offset=36+count*22
    for g in glyphs:
        records.extend(struct.pack('<IHHhhhhhH',offset+len(payload),g['width'],g['height'],g['originX'],g['originY'],g['incX'],g['incY'],g['advance'],0))
        payload.extend(encode(g['levels'],version))
    data+=records+payload
    (OUT/f'coverage-v{version}.tft').write_bytes(data)
for name,advance in [('narrow',500),('wide',900)]:
    builder=FontBuilder(1000,isTTF=True)
    order=['.notdef','space','A','V','uni4E2D']
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({32:'space',65:'A',86:'V',0x4e2d:'uni4E2D'})
    drawings={}
    for char in order:
        pen=TTGlyphPen(None)
        if char!='space':
            pen.moveTo((0,0));pen.lineTo((400,0));pen.lineTo((400,700));pen.lineTo((0,700));pen.closePath()
        drawings[char]=pen.glyph()
    builder.setupGlyf(drawings)
    builder.setupHorizontalMetrics({char:(300 if char=='space' else 700 if char=='V' else advance,0) for char in order})
    builder.setupHorizontalHeader(ascent=800,descent=-200)
    builder.setupNameTable({'familyName':'Krkr Synthetic '+name,'styleName':'Regular','uniqueFontIdentifier':'krkr-synthetic-'+name,'fullName':'Krkr Synthetic '+name,'psName':'KrkrSynthetic-'+name,'version':'Version 1.0'})
    builder.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200)
    builder.setupPost();builder.setupMaxp()
    builder.font['head'].created=builder.font['head'].modified=3406620153
    builder.font.recalcTimestamp=False
    builder.save(OUT/(name+'.ttf'))
metadata={'generator':'scripts/generate-font-fixtures.py','fontToolsVersion':fontTools.__version__,'license':'All glyph outlines and coverage data are synthetic test data created for this project; no external font outlines copied.','glyphs':glyphs,'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.iterdir()) if p.suffix in ['.tft','.ttf']}}
(OUT/'reference.json').write_text(json.dumps(metadata,indent=2)+'\n')
print('generated',len(metadata['files']),'font files')

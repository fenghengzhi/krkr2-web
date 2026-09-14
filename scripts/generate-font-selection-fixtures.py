"""Author redistributable font metadata cases from the project's synthetic glyphs."""
import hashlib,json,pathlib
from fontTools.ttLib import TTFont,TTCollection,newTable
from fontTools.ttLib.tables._n_a_m_e import NameRecord
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/fixtures/font-selection';OUT.mkdir(parents=True,exist_ok=True)
cases=[]
for file,family,fixed,bits in [('latin.ttf','Selection Latin',False,1),('latin-bold.ttf','Selection Latin',False,1),('mono.ttf','Selection Mono',True,1<<17),('symbol.ttf','Selection Symbols',True,1<<31),('mac.ttf','Caf\u00e9 \u03a9',False,1),('unknown.ttf','Selection Unknown Pitch',None,1)]:
    font=TTFont(ROOT/'tests/fixtures/font/narrow.ttf')
    bold=file=='latin-bold.ttf'
    for record in font['name'].names:
        if record.nameID in [1,2,4,6]:
            value=family if record.nameID==1 else ('Bold' if bold else 'Regular') if record.nameID==2 else family+(' Bold' if bold else '')
            record.string=(value.replace(' ','') if record.nameID==6 else value).encode(record.getEncoding())
    font['OS/2'].ulCodePageRange1=bits; font['OS/2'].ulCodePageRange2=0
    font['OS/2'].fsSelection=32 if bold else 64
    font['OS/2'].usWeightClass=700 if bold else 400
    font['head'].macStyle=1 if bold else 0
    if bold:
        # Distinct source advance proves face matching, not synthetic emboldening.
        advance,bearing=font['hmtx'].metrics['A'];font['hmtx'].metrics['A']=(900,bearing)
    if fixed is None: del font['post']
    else: font['post'].isFixedPitch=int(fixed)
    if fixed:
        font['hmtx'].metrics={name:(700,bearing) for name,(_,bearing) in font['hmtx'].metrics.items()}
    if file=='mono.ttf':
        vhea=newTable('vhea')
        values=dict(tableVersion=0x00010000,ascent=800,descent=-200,lineGap=0,advanceHeightMax=1000,minTopSideBearing=0,minBottomSideBearing=0,yMaxExtent=800,caretSlopeRise=1,caretSlopeRun=0,caretOffset=0,reserved1=0,reserved2=0,reserved3=0,reserved4=0,metricDataFormat=0,numberOfVMetrics=len(font.getGlyphOrder()))
        for key,value in values.items():setattr(vhea,key,value)
        font['vhea']=vhea;vmtx=newTable('vmtx');vmtx.metrics={name:(1000,100) for name in font.getGlyphOrder()};font['vmtx']=vmtx
    if file=='symbol.ttf':
        cmap=CmapSubtable.newSubtable(4);cmap.platformID=3;cmap.platEncID=0;cmap.language=0;cmap.cmap={0xf041:'A'};font['cmap'].tables.append(cmap)
    if file=='mac.ttf':
        name=NameRecord();name.nameID=1;name.platformID=1;name.platEncID=0;name.langID=0;name.string=family.encode('mac_roman');font['name'].names=[name]
    font.recalcTimestamp=False;font.save(OUT/file)
    cases.append({'file':file,'family':family,'fixedPitch':fixed,'outline':True,'charsets':[128,'unicode'] if file=='mono.ttf' else [2] if file=='symbol.ttf' else [0,'unicode'],'vertical':file=='mono.ttf','bold':bold,'italic':False})
collection=TTCollection();collection.fonts=[TTFont(OUT/'latin.ttf'),TTFont(OUT/'mono.ttf')]
for font in collection.fonts:font.recalcTimestamp=False
collection.save(OUT/'collection.ttc')
cases.append({**cases[0],'file':'collection.ttc'})
for case in cases:case['sha256']=hashlib.sha256((OUT/case['file']).read_bytes()).hexdigest()
(OUT/'reference.json').write_text(json.dumps({'generator':'scripts/generate-font-selection-fixtures.py','license':'Derived only from project-owned synthetic font outlines.','cases':cases},indent=2)+'\n')
print('Generated',len(cases),'font metadata cases')

"""Project-owned asymmetric outlines and explicit OpenType vertical alternates."""
import copy,hashlib,json,pathlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib.tables import otTables
import fontTools

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/fixtures/text-layout';OUT.mkdir(parents=True,exist_ok=True)
order=['.notdef','space','A','han','comma','paren','kana','comma.vert','paren.vert','kana.vert','A.rot']
cmap={32:'space',65:'A',0x6f22:'han',0x3001:'comma',0xff08:'paren',0x3041:'kana',
      0xe001:'comma.vert',0xe002:'paren.vert',0xe003:'kana.vert',0xe004:'A.rot',0xfe11:'comma.vert',0xfe35:'paren.vert'}
rectangles={
 '.notdef':[(100,100,700,700)],'space':[],
 'A':[(100,0,250,700),(100,550,500,700)],
 'han':[(100,0,250,700),(100,550,800,700),(500,100,700,250)],
 'comma':[(100,0,250,150)],'paren':[(100,0,250,800),(100,650,400,800)],
 'kana':[(100,0,250,450),(100,300,550,450)],
 'comma.vert':[(650,650,800,800)],'paren.vert':[(100,550,900,700),(100,400,250,700)],
 'kana.vert':[(400,300,550,750),(400,600,850,750)],
 'A.rot':[(100,550,800,700),(650,300,800,700)],
}
cases=[]
for kind in ['vert','vrt2','none','extension','delta','split','novmetrics']:
 builder=FontBuilder(1000,isTTF=True)
 builder.setupGlyphOrder(order);builder.setupCharacterMap(cmap)
 glyphs={}
 for name in order:
  pen=TTGlyphPen(None)
  for l,b,r,t in rectangles[name]:
   pen.moveTo((l,b));pen.lineTo((r,b));pen.lineTo((r,t));pen.lineTo((l,t));pen.closePath()
  glyphs[name]=pen.glyph()
 builder.setupGlyf(glyphs)
 advances={name:600 if name=='A' else 500 if name=='space' else 1000 for name in order}
 builder.setupHorizontalMetrics({name:(advances[name],min((r[0] for r in rectangles[name]),default=0)) for name in order})
 builder.setupHorizontalHeader(ascent=800,descent=-200)
 if kind!='novmetrics':
  builder.setupVerticalMetrics({name:(600 if name=='A.rot' else 1000,800-max((r[3] for r in rectangles[name]),default=800)) for name in order})
  builder.setupVerticalHeader(ascent=500,descent=-500)
 builder.setupNameTable({'familyName':'Krkr Vertical '+kind,'styleName':'Regular','uniqueFontIdentifier':'krkr-vertical-'+kind,'fullName':'Krkr Vertical '+kind,'psName':'KrkrVertical'+kind,'version':'Version 1.0'})
 builder.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200,ulCodePageRange1=1<<17)
 builder.setupPost(underlinePosition=-100,underlineThickness=50);builder.setupMaxp()
 if kind!='none':
  feature='sub comma by comma.vert; sub paren by paren.vert; sub kana by kana.vert;'
  if kind in ['delta','split']:feature='sub A by han; sub han by comma; sub comma by paren; sub paren by kana; sub kana by comma.vert;'
  addOpenTypeFeaturesFromString(builder.font,'languagesystem DFLT dflt; languagesystem hani dflt; feature vert {'+feature+'} vert;'+
    ('feature vrt2 {'+feature+' sub A by A.rot;} vrt2;' if kind=='vrt2' else ''))
  if kind=='extension':
   for lookup in builder.font['GSUB'].table.LookupList.Lookup:
    subs=[]
    for sub in lookup.SubTable:
     extension=otTables.ExtensionSubst();extension.Format=1;extension.ExtensionLookupType=1;extension.ExtSubTable=sub;subs.append(extension)
    lookup.LookupType=7;lookup.SubTable=subs
  if kind=='split':
   lookup=builder.font['GSUB'].table.LookupList.Lookup[0]
   first=copy.deepcopy(lookup.SubTable[0]);first.mapping={'A':'han'}
   second=copy.deepcopy(lookup.SubTable[0]);second.mapping={a:b for a,b in second.mapping.items() if a!='A'}
   lookup.SubTable=[first,second];lookup.SubTableCount=2
 builder.font['head'].created=builder.font['head'].modified=3406620153
 builder.font.recalcTimestamp=False
 file=kind+'.ttf';builder.save(OUT/file)
 cases.append({'file':file,'family':'Krkr Vertical '+kind,'sha256':hashlib.sha256((OUT/file).read_bytes()).hexdigest()})
(OUT/'fonts.json').write_text(json.dumps({'generator':'scripts/generate-vertical-font-fixtures.py','fontToolsVersion':fontTools.__version__,
 'license':'All glyph outlines are project-owned synthetic test data.','glyphOrder':order,'cmap':cmap,'rectangles':rectangles,'cases':cases},indent=2)+'\n')
print('Generated',len(cases),'vertical fonts')

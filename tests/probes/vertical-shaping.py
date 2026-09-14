"""Independent native HarfBuzz selection vectors; not production-generated expected values."""
import hashlib,json,pathlib
import uharfbuzz as hb
ROOT=pathlib.Path(__file__).resolve().parents[2]
FONTS=ROOT/'tests/fixtures/text-layout'
description=json.loads((FONTS/'fonts.json').read_text())
rows=[]
for case in description['cases']:
 path=FONTS/case['file'];font=hb.Font(hb.Face(path.read_bytes()))
 feature='vrt2' if path.stem=='vrt2' else 'vert'
 for code in [32,65,0x6f22,0x3001,0xff08,0x3041,0xe001,0xe004]:
  buffer=hb.Buffer();buffer.add_str(chr(code));buffer.direction='ttb';buffer.script='hani';buffer.language='ja'
  hb.shape(font,buffer,{'vert':feature=='vert','vrt2':feature=='vrt2','kern':False})
  assert len(buffer.glyph_infos)==1
  glyph=buffer.glyph_infos[0].codepoint;position=buffer.glyph_positions[0]
  # Horizontal direction with the explicit vertical feature isolates GSUB from
  # HarfBuzz's Unicode presentation-form fallback used in vertical direction.
  only_gsub=hb.Buffer();only_gsub.add_str(chr(code));only_gsub.direction='ltr';only_gsub.script='hani';only_gsub.language='ja'
  hb.shape(font,only_gsub,{'vert':feature=='vert','vrt2':feature=='vrt2','kern':False})
  rows.append({'file':case['file'],'feature':None if path.stem=='none' else feature,'code':code,
    'nominal':font.get_nominal_glyph(code),'glyph':glyph,'substitution':only_gsub.glyph_infos[0].codepoint,
    'position':[position.x_offset,position.y_offset,position.x_advance,position.y_advance]})
native=pathlib.Path(hb._harfbuzz.__file__)
result={'uharfbuzz':hb.__version__,'harfbuzz':hb.version_string(),'nativeLibrarySha256':hashlib.sha256(native.read_bytes()).hexdigest(),
 'scope':'Native HarfBuzz single-character hani/ja vertical shaping with mutually exclusive vert/vrt2. Rotation and KRKR anchoring are not provided by HarfBuzz.',
 'fonts':{case['file']:case['sha256'] for case in description['cases']},'cases':rows}
(FONTS/'shaping.json').write_text(json.dumps(result,indent=2)+'\n')
print('Generated',len(rows),'independent HarfBuzz cases')
